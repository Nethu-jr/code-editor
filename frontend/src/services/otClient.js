/**
 * Client-side OT bookkeeping.
 *
 * The client maintains:
 *   - serverRev:  the latest server revision we've seen (or acked)
 *   - pending:    ops we've sent but haven't received ack for yet
 *
 * When we type, we:
 *   1. Apply the op locally immediately (zero-latency feel).
 *   2. Stamp it with baseRev = serverRev and add to pending.
 *   3. Send to the server.
 *
 * When we receive `remote_op`:
 *   - It was authored against some past serverRev. The server has already
 *     transformed it past everything in its own history — so for us it
 *     just needs to be transformed against our local PENDING ops.
 *   - We transform the incoming op against each pending op, apply to the
 *     editor, and update serverRev.
 *
 * When we receive `ack` for one of our pending ops:
 *   - Remove that op from pending, update serverRev.
 *
 * When we receive `resync_required`:
 *   - Replace local doc with server's text, set serverRev, drop pending.
 */

import { transform } from './otTransform';

export class ClientOT {
  constructor() {
    this.serverRev = 0;
    this.pending = []; // ops awaiting ack, in order sent
    this.clientId = `c-${Math.random().toString(36).slice(2, 10)}`;
  }

  /**
   * Stamp + register a local op for sending. Returns the op to send.
   */
  trackLocal(op) {
    op.baseRev = this.serverRev;
    op.clientId = this.clientId;
    this.pending.push(op);
    return op;
  }

  /**
   * Server acked our op (by opId). Remove from pending.
   */
  ack(opId, rev) {
    const idx = this.pending.findIndex(o => o.opId === opId);
    if (idx >= 0) this.pending.splice(idx, 1);
    if (rev > this.serverRev) this.serverRev = rev;
  }

  /**
   * Apply a remote op: returns the op transformed past local pending.
   * Caller is responsible for actually mutating the editor model.
   */
  applyRemote(remoteOp, rev) {
    let inc = remoteOp;
    // Also TRANSFORM PENDING in place against the incoming op so they
    // remain valid for when we re-send them after reconnect or if the
    // server applies them later. This is the "client bridge" step.
    const newPending = [];
    for (const p of this.pending) {
      const [pPrime, incPrime] = transform(p, inc);
      newPending.push(pPrime);
      inc = incPrime;
    }
    this.pending = newPending;
    if (rev > this.serverRev) this.serverRev = rev;
    return inc;
  }

  resync(text, rev) {
    this.pending = [];
    this.serverRev = rev;
    return text;
  }
}
