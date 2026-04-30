/**
 * Execution Engine
 *
 * A small Express service that runs untrusted user code in a fresh Docker
 * container per request. Each language has its own minimal image:
 *   - python:    python:3.12-alpine
 *   - javascript:node:20-alpine
 *   - cpp:       gcc:13-bookworm-slim   (compile + run)
 *
 * Hardening (applied via docker run flags):
 *   --network none              No internet from inside the sandbox
 *   --read-only                 Root FS is read-only
 *   --tmpfs /tmp:rw,size=64m    A small writable scratch dir
 *   --memory=128m               Hard memory cap
 *   --cpus=0.5                  CPU quota
 *   --pids-limit 64             Prevent fork bombs
 *   --cap-drop=ALL              No Linux capabilities
 *   --security-opt no-new-privileges
 *
 * Plus a wall-clock timeout enforced by killing the container on the host.
 *
 * For maximum isolation, swap docker for gVisor (--runtime=runsc) or
 * Firecracker microVMs. For very high QPS, maintain a warm container pool
 * and exec into them — saves ~200ms cold-start per run.
 */

const express = require('express');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const fs = require('fs');
const path = require('path');
const os = require('os');

const app = express();
app.use(express.json({ limit: '512kb' }));

const PORT = parseInt(process.env.PORT || '7000', 10);

const LANG = {
  python: {
    image: 'python:3.12-alpine',
    file: 'main.py',
    cmd: ['python', '/work/main.py'],
  },
  javascript: {
    image: 'node:20-alpine',
    file: 'main.js',
    cmd: ['node', '/work/main.js'],
  },
  cpp: {
    image: 'gcc:13-bookworm-slim',
    file: 'main.cpp',
    // compile then run; both inside the container in one shell.
    // We use sh -lc so we get exit code propagation.
    cmd: ['sh', '-lc', 'g++ -O2 -std=c++17 -o /tmp/a.out /work/main.cpp && /tmp/a.out'],
  },
};

app.get('/health', (_req, res) => res.json({ ok: true }));

app.post('/run', async (req, res) => {
  const { language, code, stdin = '', timeoutMs = 5000 } = req.body || {};
  const cfg = LANG[language];
  if (!cfg) return res.status(400).json({ ok: false, stderr: `unsupported language: ${language}` });
  if (typeof code !== 'string' || code.length > 200_000) {
    return res.status(400).json({ ok: false, stderr: 'invalid or too-large code' });
  }

  // Write code to a private temp dir that we mount read-only into the container.
  const id = randomUUID();
  const dir = path.join(os.tmpdir(), `runbox-${id}`);
  fs.mkdirSync(dir, { recursive: true, mode: 0o755 });
  const filePath = path.join(dir, cfg.file);
  fs.writeFileSync(filePath, code, { mode: 0o644 });

  const timeoutSeconds = Math.max(1, Math.min(15, Math.ceil(timeoutMs / 1000)));

  const args = [
    'run', '--rm', '-i',
    '--network', 'none',
    '--read-only',
    '--tmpfs', '/tmp:rw,exec,size=64m',  // exec needed for cpp's a.out
    '--memory=128m',
    '--memory-swap=128m',                // disable swap
    '--cpus=0.5',
    '--pids-limit', '64',
    '--cap-drop=ALL',
    '--security-opt', 'no-new-privileges',
    '-v', `${dir}:/work:ro`,
    '-w', '/work',
    cfg.image,
    ...cfg.cmd,
  ];

  // Wall-clock timeout: docker has --stop-timeout but easier to enforce
  // ourselves and kill the proc.
  const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'] });
  let stdout = '', stderr = '';
  let killed = false;

  const killer = setTimeout(() => {
    killed = true;
    try { child.kill('SIGKILL'); } catch {}
  }, timeoutMs + 500);

  child.stdout.on('data', (b) => { stdout += b.toString(); if (stdout.length > 1_000_000) child.kill('SIGKILL'); });
  child.stderr.on('data', (b) => { stderr += b.toString(); if (stderr.length > 1_000_000) child.kill('SIGKILL'); });

  if (stdin) child.stdin.write(stdin);
  child.stdin.end();

  child.on('close', (code) => {
    clearTimeout(killer);
    fs.rm(dir, { recursive: true, force: true }, () => {});
    res.json({
      ok: code === 0 && !killed,
      exitCode: code,
      stdout: stdout.slice(0, 100_000),
      stderr: stderr.slice(0, 100_000),
      timedOut: killed,
    });
  });

  child.on('error', (err) => {
    clearTimeout(killer);
    fs.rm(dir, { recursive: true, force: true }, () => {});
    res.status(500).json({ ok: false, stderr: `engine error: ${err.message}` });
  });
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`exec engine listening on :${PORT}`);
});
