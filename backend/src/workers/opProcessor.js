/**
 * makeOpProcessor(session, redis, broadcastLocal, instanceId)
 *
 * Returns the async processor function that the OperationQueue will call
 * for each op. This is where the canonical work happens:
 *
 *   1. Document.receive(op)  — transforms + applies, returns transformed op
 *   2. Persist op to Redis op log (for replay during recovery)
 *   3. Publish to room:{sid} channel — other Node instances pick this up
 *   4. Broadcast to LOCAL clients in this session (skip the originator)
 *
 * IMPORTANT: We tag every published message with our instanceId. When the
 * Redis subscriber on THIS same instance receives an echo, it skips the
 * local broadcast (we already did it inline). This prevents duplicate
 * delivery to local sockets without sacrificing speed for them.
 */

function makeOpProcessor({ session, redis, broadcastLocal, instanceId }) {
  return async function processOp(op) {
    // The op carries .__originSocket internally so we can skip echoing back.
    const originSocket = op.__originSocket;
    delete op.__originSocket;

    let result;
    try {
      result = session.document.receive(op);
    } catch (err) {
      if (err.code === 'STALE_BASE_REV') {
        // Tell originator to resync. Don't broadcast.
        if (originSocket && originSocket.readyState === 1) {
          originSocket.send(JSON.stringify({
            type: 'resync_required',
            serverRev: session.document.rev,
            text: session.document.text,
          }));
        }
        return;
      }
      // Malformed op — ack failure to originator only.
      if (originSocket && originSocket.readyState === 1) {
        originSocket.send(JSON.stringify({
          type: 'op_rejected',
          opId: op.opId,
          reason: err.message,
        }));
      }
      return;
    }

    const { applied, rev } = result;

    // ACK to originator with the new revision (so they can advance baseRev)
    if (originSocket && originSocket.readyState === 1) {
      originSocket.send(JSON.stringify({
        type: 'ack',
        opId: op.opId,
        rev,
      }));
    }

    if (applied.type === 'noop') return;

    const broadcastMsg = {
      type: 'remote_op',
      sessionId: session.id,
      op: applied,
      rev,
      author: op.clientId,
      from: instanceId,
    };

    // 1) Persist (fire-and-forget; failure is non-fatal because we still
    //    have the in-memory history for active clients).
    redis.appendOpLog(session.id, applied).catch(() => {});

    // 2) Periodic snapshot
    if (rev % 50 === 0) {
      redis.saveSnapshot(session.id, session.document.snapshot()).catch(() => {});
    }

    // 3) Broadcast locally first (lowest latency for same-node peers)
    broadcastLocal(session, broadcastMsg, originSocket);

    // 4) Publish for OTHER instances (we'll filter our own echoes via instanceId)
    redis.publish(`room:${session.id}`, broadcastMsg).catch(() => {});
  };
}

module.exports = { makeOpProcessor };
