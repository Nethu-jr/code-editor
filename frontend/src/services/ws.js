/**
 * ReconnectingWS — minimal WebSocket wrapper with:
 *   - Exponential backoff reconnection (capped at 10s)
 *   - Outbound message buffering while disconnected (capped to avoid leaks)
 *   - onOpen / onMessage / onClose subscriber callbacks
 *
 * Intentionally tiny — no heartbeat here because the server does WS pings
 * and we already have application-level message acks for op delivery.
 */

export class ReconnectingWS {
  constructor(url) {
    this.url = url;
    this.ws = null;
    this.attempt = 0;
    this.shouldRun = true;
    this.outbox = [];               // messages queued while offline
    this.maxOutbox = 1000;
    this.listeners = { open: new Set(), message: new Set(), close: new Set() };
    this._connect();
  }

  _connect() {
    if (!this.shouldRun) return;
    this.ws = new WebSocket(this.url);
    this.ws.onopen = () => {
      this.attempt = 0;
      this.listeners.open.forEach(fn => fn());
      // Flush any queued messages.
      while (this.outbox.length) this.ws.send(this.outbox.shift());
    };
    this.ws.onmessage = (e) => {
      let msg; try { msg = JSON.parse(e.data); } catch { return; }
      this.listeners.message.forEach(fn => fn(msg));
    };
    this.ws.onclose = () => {
      this.listeners.close.forEach(fn => fn());
      if (!this.shouldRun) return;
      const delay = Math.min(10_000, 250 * 2 ** this.attempt++);
      setTimeout(() => this._connect(), delay);
    };
    this.ws.onerror = () => { try { this.ws.close(); } catch {} };
  }

  send(obj) {
    const data = JSON.stringify(obj);
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(data);
    } else {
      if (this.outbox.length < this.maxOutbox) this.outbox.push(data);
    }
  }

  on(event, fn) { this.listeners[event].add(fn); return () => this.listeners[event].delete(fn); }

  close() { this.shouldRun = false; try { this.ws?.close(); } catch {} }
}
