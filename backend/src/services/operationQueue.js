/**
 * OperationQueue
 *
 * A FIFO queue of pending operations for a single session.
 *
 * Why FIFO? OT's correctness depends on processing ops in the order they
 * are received per-server. Reordering breaks transform composition.
 *
 * Why per-session and not global? Different sessions are independent and
 * can be processed in parallel. A single global queue would serialize
 * unrelated work and become a bottleneck.
 *
 * Implementation: a JS array used purely with push() / shift(). For very
 * high throughput sessions (>10k ops/sec), shift() being O(n) becomes a
 * problem and you'd swap in a linked-list or two-stack queue. Profile
 * first — for typical collab editing (humans typing), this is fine.
 *
 * Concurrency: Node.js is single-threaded, so we don't need locks. We
 * DO need a "draining" flag so the worker doesn't recursively re-enter
 * itself when the processor schedules async work (Redis publish, etc.).
 */

class OperationQueue {
  constructor() {
    this.items = [];
    this.draining = false;
    this.onDrain = null;       // optional callback when queue empties
    this.processor = null;     // async fn(op) => transformedOp
  }

  enqueue(op) {
    this.items.push(op);
  }

  size() {
    return this.items.length;
  }

  /**
   * Set the async processor and start draining. Safe to call repeatedly.
   *   processor: async (op) => void
   */
  start(processor) {
    this.processor = processor;
    this._drain();
  }

  /**
   * Trigger a drain check after a new enqueue.
   */
  kick() {
    this._drain();
  }

  async _drain() {
    if (this.draining || !this.processor) return;
    this.draining = true;
    try {
      while (this.items.length > 0) {
        const op = this.items.shift();
        try {
          await this.processor(op);
        } catch (err) {
          // Don't let a single bad op kill the drain loop.
          // The caller's processor should log the error itself.
          // eslint-disable-next-line no-console
          console.error('[OperationQueue] processor error:', err.message);
        }
      }
    } finally {
      this.draining = false;
      if (this.onDrain) this.onDrain();
    }
  }
}

module.exports = { OperationQueue };
