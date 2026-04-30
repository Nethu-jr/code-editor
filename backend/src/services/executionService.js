/**
 * ExecutionService
 *
 * The Node.js backend does NOT spawn Docker containers directly — instead
 * it talks to a separate `execution-engine` HTTP service over the internal
 * network. This separation matters because:
 *
 *   1. Security: code execution is the highest-risk surface in the system.
 *      Isolating it lets us harden that one box (no DB creds, no Redis,
 *      seccomp profile, dropped capabilities, gVisor/Firecracker if avail.)
 *
 *   2. Scaling: execution is bursty and CPU-bound, very different from
 *      WebSocket fanout which is I/O-bound. They scale on different curves.
 *
 *   3. Resource quotas: easier to apply per-pool limits at the cluster
 *      level when the work lives in its own deployment.
 *
 * This client just forwards requests and surfaces timeouts cleanly.
 */

class ExecutionService {
  constructor({ url } = {}) {
    this.url = url || process.env.EXEC_ENGINE_URL || 'http://localhost:7000';
  }

  async run({ language, code, stdin = '', timeoutMs = 5000 }) {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), timeoutMs + 2000);
    try {
      const res = await fetch(`${this.url}/run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, code, stdin, timeoutMs }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text().catch(() => '');
        return { ok: false, stdout: '', stderr: `engine error ${res.status}: ${text}`, timedOut: false };
      }
      return await res.json();
    } catch (err) {
      if (err.name === 'AbortError') {
        return { ok: false, stdout: '', stderr: 'execution engine timeout', timedOut: true };
      }
      return { ok: false, stdout: '', stderr: err.message, timedOut: false };
    } finally {
      clearTimeout(t);
    }
  }
}

module.exports = { ExecutionService };
