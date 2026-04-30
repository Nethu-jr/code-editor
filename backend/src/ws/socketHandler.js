/**
 * socketHandler(ws, req, deps)
 *
 * Wired up by the WS server on each new connection. Handles:
 *   - join:        client wants to enter a session, send initial snapshot
 *   - op:          edit operation (insert/delete) — enqueue + drain
 *   - cursor:      cursor/selection update — broadcast directly (no OT log)
 *   - ping/pong:   liveness via ws.ping; we also accept app-level ping
 *
 * Reconnection support: when a client reconnects with a stale baseRev,
 * the OT engine throws STALE_BASE_REV and we send a 'resync_required'
 * with the latest snapshot. The client then re-sends any pending local ops.
 */

const { makeOpProcessor } = require('../workers/opProcessor');
const { logger } = require('../utils/logger');

function broadcastLocal(session, msg, exceptSocket) {
  const data = JSON.stringify(msg);
  for (const sock of session.localSockets) {
    if (sock === exceptSocket) continue;
    if (sock.readyState === 1) sock.send(data);
  }
}

function attachSocketHandlers({ ws, req, deps }) {
  const { sessions, redis, instanceId, jwtVerify } = deps;
  let joined = null; // { userId, sessionId, session }
  let alive = true;

  // App-level keepalive: server pings every 25s, expects pong within 60s.
  const pingTimer = setInterval(() => {
    if (!alive) return ws.terminate();
    alive = false;
    try { ws.ping(); } catch {}
  }, 25_000);

  ws.on('pong', () => { alive = true; });

  ws.on('message', async (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); }
    catch { return ws.send(JSON.stringify({ type:'error', reason:'invalid_json' })); }

    try {
      switch (msg.type) {
        case 'join':         return handleJoin(msg);
        case 'op':           return handleOp(msg);
        case 'cursor':       return handleCursor(msg);
        case 'ping':         return ws.send(JSON.stringify({ type:'pong', t: Date.now() }));
        default:             return ws.send(JSON.stringify({ type:'error', reason:'unknown_type' }));
      }
    } catch (err) {
      logger.error(`WS handler error: ${err.stack || err.message}`);
      ws.send(JSON.stringify({ type:'error', reason: err.message }));
    }
  });

  ws.on('close', async () => {
    clearInterval(pingTimer);
    if (!joined) return;
    const { userId, sessionId } = joined;
    sessions.detach(ws);
    await redis.removePresence(sessionId, userId);
    const leaveMsg = { type:'user_left', sessionId, userId, from: instanceId };
    broadcastLocal({ localSockets: sessions.get(sessionId)?.localSockets || new Set() },
                   leaveMsg, ws);
    redis.publish(`presence:${sessionId}`, leaveMsg).catch(() => {});
  });

  // ---------- handlers --------------------------------------------------

  async function handleJoin(msg) {
    const { sessionId, token } = msg;
    if (!sessionId) throw new Error('sessionId required');

    let userId;
    if (jwtVerify) {
      const payload = jwtVerify(token); // throws on bad token
      userId = payload.sub;
    } else {
      // Dev mode: trust client-supplied userId
      userId = msg.userId || `anon-${Math.random().toString(36).slice(2,8)}`;
    }

    // Try to load existing snapshot from Redis if this node hasn't seen
    // the session yet (cold start / reconnect to different instance).
    let initialText = '';
    if (!sessions.get(sessionId)) {
      const snap = await redis.loadSnapshot(sessionId);
      if (snap) initialText = snap.text;
    }

    const session = sessions.attach(sessionId, userId, ws);
    if (initialText && session.document.rev === 0) {
      session.document.text = initialText;
      // Note: rev stays 0; the snapshot rev would have been higher in prod.
      // For correctness we'd also load the rev from snapshot — done here:
      const snap = await redis.loadSnapshot(sessionId);
      if (snap?.rev) session.document.rev = snap.rev;
    }

    // Subscribe THIS node to the room channel (idempotent).
    await ensureRoomSubscription(sessionId, session);

    // Track presence cluster-wide.
    await redis.addPresence(sessionId, userId);

    joined = { userId, sessionId, session };

    // Initial state to client
    ws.send(JSON.stringify({
      type: 'joined',
      sessionId,
      userId,
      doc: session.document.snapshot(),
      activeUsers: Array.from(session.activeUsers),
      cursors: Array.from(session.cursors.entries()).map(([uid, c]) => ({ userId: uid, ...c })),
    }));

    // Notify peers
    const joinMsg = { type:'user_joined', sessionId, userId, from: instanceId };
    broadcastLocal(session, joinMsg, ws);
    await redis.publish(`presence:${sessionId}`, joinMsg);
  }

  async function handleOp(msg) {
    if (!joined) throw new Error('must join first');
    const { session } = joined;
    const op = msg.op;
    if (!op || !op.type) throw new Error('invalid op');
    op.clientId = op.clientId || joined.userId;
    op.__originSocket = ws;

    // Enqueue and kick the drain. The processor was set on first attach.
    if (!session.queue.processor) {
      session.queue.start(makeOpProcessor({
        session, redis, broadcastLocal, instanceId,
      }));
    }
    session.queue.enqueue(op);
    session.queue.kick();
  }

  function handleCursor(msg) {
    if (!joined) return;
    const { session } = joined;
    const { pos, selectionEnd } = msg;
    session.cursors.set(joined.userId, { pos, selectionEnd: selectionEnd ?? pos });
    const out = {
      type: 'remote_cursor',
      sessionId: session.id,
      userId: joined.userId,
      pos, selectionEnd: selectionEnd ?? pos,
      from: instanceId,
    };
    broadcastLocal(session, out, ws);
    redis.publish(`room:${session.id}`, out).catch(() => {});
  }

  // --- room-channel fanout from Redis to local sockets ------------------

  // We keep a per-process Set of session IDs we've subscribed to. The
  // handler delivers to local sockets, skipping echoes from our instance.
  const roomSubs = deps.__roomSubs ||= new Set();

  async function ensureRoomSubscription(sessionId, session) {
    if (roomSubs.has(sessionId)) return;
    roomSubs.add(sessionId);
    await redis.subscribe(`room:${sessionId}`, (msg) => {
      if (msg.from === instanceId) return; // our own echo
      const sess = sessions.get(sessionId);
      if (!sess) return;

      if (msg.type === 'remote_op') {
        // Apply the op to our local copy as well — every node maintains
        // its own copy of the canonical doc to serve fast reads. We use
        // baseRev = msg.rev - 1 so it lines up after our existing history.
        // Since the publishing node already transformed & assigned rev,
        // we can append directly without re-running OT.
        const { op, rev } = msg;
        if (rev === sess.document.rev + 1) {
          sess.document._apply(op);
          sess.document.history.push(op);
          sess.document.rev = rev;
        }
        // If revs don't line up exactly, we rely on snapshot resync.

        const data = JSON.stringify(msg);
        for (const sock of sess.localSockets) {
          if (sock.readyState === 1) sock.send(data);
        }
      } else if (msg.type === 'remote_cursor') {
        sess.cursors.set(msg.userId, { pos: msg.pos, selectionEnd: msg.selectionEnd });
        const data = JSON.stringify(msg);
        for (const sock of sess.localSockets) {
          if (sock.readyState === 1) sock.send(data);
        }
      }
    });

    await redis.subscribe(`presence:${sessionId}`, (msg) => {
      if (msg.from === instanceId) return;
      const sess = sessions.get(sessionId);
      if (!sess) return;
      if (msg.type === 'user_joined') sess.activeUsers.add(msg.userId);
      if (msg.type === 'user_left')   sess.activeUsers.delete(msg.userId);
      const data = JSON.stringify(msg);
      for (const sock of sess.localSockets) {
        if (sock.readyState === 1) sock.send(data);
      }
    });
  }
}

module.exports = { attachSocketHandlers };
