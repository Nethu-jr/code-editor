/**
 * ServerDocument
 *
 * The canonical document for a session. Holds:
 *   - text:     current content (string buffer; for very large docs, swap
 *               for a rope/piece-table — see scaling section in README)
 *   - rev:      monotonically increasing revision number
 *   - history:  array of applied ops indexed by revision-1
 *
 * We also expose receive(op) which:
 *   1. Transforms the incoming op against every op in history with
 *      revision >= op.baseRev (i.e., ops the client hadn't seen yet).
 *   2. Applies the transformed op to `text`.
 *   3. Appends to history, increments rev, returns the transformed op.
 *
 * Time complexity of receive():
 *   O(k * |op|)  where k = rev - op.baseRev (ops to rebase against).
 *   In practice k is tiny because clients ack quickly. We bound it with
 *   a snapshot interval so history doesn't grow unbounded.
 */

const { transform } = require('./transform');

class ServerDocument {
  constructor(initialText = '', sessionId = null) {
    this.sessionId = sessionId;
    this.text = initialText;
    this.rev = 0;
    // history[i] = op that produced rev (historyOffset + i + 1).
    // historyOffset = number of ops dropped during past compactions.
    this.history = [];
    this.historyOffset = 0;
    this.maxHistory = 1000; // compaction threshold
  }

  /**
   * Apply a single (already transformed) op to the buffer.
   * Returns the same op (or a noop) for chaining.
   */
  _apply(op) {
    if (op.type === 'noop') return op;
    if (op.type === 'cursor') return op; // not part of doc state
    if (op.type === 'insert') {
      if (op.pos < 0 || op.pos > this.text.length) {
        // Defensive: clamp rather than throw — a malformed op shouldn't
        // crash the room. Real systems should also disconnect the offender.
        op = { ...op, pos: Math.max(0, Math.min(op.pos, this.text.length)) };
      }
      this.text = this.text.slice(0, op.pos) + op.text + this.text.slice(op.pos);
      return op;
    }
    if (op.type === 'delete') {
      const start = Math.max(0, Math.min(op.pos, this.text.length));
      const end = Math.max(start, Math.min(start + op.length, this.text.length));
      this.text = this.text.slice(0, start) + this.text.slice(end);
      return { ...op, pos: start, length: end - start };
    }
    return op;
  }

  /**
   * Process an incoming op authored against op.baseRev.
   * Returns the transformed op as it was actually applied (with new pos/length).
   */
  receive(op) {
    if (op.baseRev > this.rev) {
      throw new Error(
        `Op references future revision ${op.baseRev} > current ${this.rev}`
      );
    }
    if (op.baseRev < this.historyOffset) {
      // The client is too far behind — its baseRev is older than what we
      // still have in history. They must resync from the latest snapshot.
      const err = new Error('STALE_BASE_REV');
      err.code = 'STALE_BASE_REV';
      err.serverRev = this.rev;
      throw err;
    }

    // Transform against every op the client hadn't seen.
    let transformed = op;
    for (let absRev = op.baseRev; absRev < this.rev; absRev++) {
      const concurrent = this.history[absRev - this.historyOffset];
      [transformed /* aPrime */] = transform(transformed, concurrent);
      if (transformed.type === 'noop') break;
    }

    if (transformed.type === 'noop') {
      // Op fully cancelled by concurrent deletes. Still increment rev?
      // No — noops don't change the doc, so don't bump the version.
      return { applied: transformed, rev: this.rev };
    }

    const applied = this._apply(transformed);
    if (applied.type !== 'cursor') {
      this.history.push(applied);
      this.rev += 1;
      this._maybeCompact();
    }
    return { applied, rev: this.rev };
  }

  _maybeCompact() {
    // When history grows beyond threshold, snapshot text and drop old ops.
    // Clients with baseRev < historyOffset must do a full resync.
    if (this.history.length > this.maxHistory) {
      const dropCount = Math.floor(this.maxHistory / 2);
      this.history.splice(0, dropCount);
      this.historyOffset += dropCount;
    }
  }

  /**
   * Snapshot for persistence / new clients.
   */
  snapshot() {
    return { text: this.text, rev: this.rev };
  }
}

module.exports = { ServerDocument };
