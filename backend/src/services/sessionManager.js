/**
 * SessionManager
 *
 * Owns the in-memory state for sessions HOSTED on this Node instance.
 * Other Node instances see the same sessions via Redis Pub/Sub fanout,
 * but each only keeps state for the clients connected to ITSELF.
 *
 * Data structures:
 *   sessions:    Map<sessionId, Session>            // O(1) session lookup
 *   userSocket:  Map<userId, WebSocket>             // O(1) socket lookup
 *   socketUser:  WeakMap<WebSocket, {userId,sid}>   // reverse, GC-friendly
 *
 * A Session contains:
 *   document:    ServerDocument (the canonical text + history)
 *   queue:       OperationQueue (FIFO of incoming ops to process)
 *   activeUsers: Set<userId> (presence)
 *   localSockets:Set<WebSocket> (only sockets attached to THIS node)
 */

const { ServerDocument } = require('../ot/document');
const { OperationQueue } = require('./operationQueue');

class SessionManager {
  constructor() {
    this.sessions = new Map();      // sessionId -> Session
    this.userSocket = new Map();    // userId -> WebSocket
    this.socketUser = new WeakMap();// WebSocket -> {userId, sessionId}
  }

  /**
   * Lazily creates a session if missing. In production, this would also
   * try to load a snapshot from Redis/Postgres before creating fresh.
   */
  getOrCreate(sessionId, initialText = '') {
    let s = this.sessions.get(sessionId);
    if (!s) {
      s = {
        id: sessionId,
        document: new ServerDocument(initialText, sessionId),
        queue: new OperationQueue(),
        activeUsers: new Set(),
        localSockets: new Set(),
        cursors: new Map(), // userId -> {pos, selectionEnd}
        createdAt: Date.now(),
      };
      this.sessions.set(sessionId, s);
    }
    return s;
  }

  get(sessionId) {
    return this.sessions.get(sessionId);
  }

  /**
   * Register a user joining a session via a specific socket.
   * O(1) for all map/set operations.
   */
  attach(sessionId, userId, socket) {
    const s = this.getOrCreate(sessionId);
    s.activeUsers.add(userId);
    s.localSockets.add(socket);
    this.userSocket.set(userId, socket);
    this.socketUser.set(socket, { userId, sessionId });
    return s;
  }

  /**
   * Detach on disconnect. Cleans up presence and reverse maps.
   * If the session is empty after detach, we DO NOT delete it immediately —
   * we keep it for `linger` ms to allow reconnection without state loss.
   */
  detach(socket, lingerMs = 30000) {
    const meta = this.socketUser.get(socket);
    if (!meta) return null;
    const { userId, sessionId } = meta;
    const s = this.sessions.get(sessionId);
    if (!s) return null;

    s.activeUsers.delete(userId);
    s.localSockets.delete(socket);
    s.cursors.delete(userId);
    this.userSocket.delete(userId);
    this.socketUser.delete(socket);

    if (s.activeUsers.size === 0 && s.localSockets.size === 0) {
      // Note: there might still be users connected via OTHER nodes.
      // The Redis presence channel is what truly tells us if a session
      // is empty cluster-wide. For now we rely on a TTL on the snapshot.
      setTimeout(() => {
        const cur = this.sessions.get(sessionId);
        if (cur && cur.activeUsers.size === 0 && cur.localSockets.size === 0) {
          this.sessions.delete(sessionId);
        }
      }, lingerMs);
    }
    return { userId, sessionId };
  }

  listSessions() {
    return Array.from(this.sessions.keys());
  }

  stats() {
    return {
      sessions: this.sessions.size,
      users: this.userSocket.size,
    };
  }
}

module.exports = { SessionManager };
