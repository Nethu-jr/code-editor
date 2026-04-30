import React, { useState } from 'react';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export function RunPanel({ code, language }) {
  const [stdin, setStdin] = useState('');
  const [output, setOutput] = useState(null);
  const [running, setRunning] = useState(false);

  async function run() {
    setRunning(true);
    setOutput(null);
    try {
      const r = await fetch(`${API}/run`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ language, code, stdin, timeoutMs: 5000 }),
      });
      const j = await r.json();
      setOutput(j);
    } catch (e) {
      setOutput({ ok: false, stderr: e.message });
    } finally {
      setRunning(false);
    }
  }

  return (
    <div style={{ padding: 12, borderTop: '1px solid #333', background: '#1e1e1e', color: '#ddd' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <button onClick={run} disabled={running} style={runBtnStyle}>
          {running ? 'Running…' : `▶ Run ${language}`}
        </button>
        <input
          placeholder="stdin (optional)"
          value={stdin}
          onChange={(e) => setStdin(e.target.value)}
          style={{ flex: 1, background: '#2a2a2a', border: '1px solid #444',
                   color: '#ddd', padding: '4px 8px', borderRadius: 3, fontFamily: 'monospace' }}
        />
      </div>
      {output && (
        <div style={{ fontFamily: 'monospace', fontSize: 12 }}>
          {output.stdout && (
            <>
              <div style={{ color: '#888', marginTop: 4 }}>stdout:</div>
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap' }}>{output.stdout}</pre>
            </>
          )}
          {output.stderr && (
            <>
              <div style={{ color: '#ff6b6b', marginTop: 4 }}>stderr:</div>
              <pre style={{ margin: 0, color: '#ff6b6b', whiteSpace: 'pre-wrap' }}>{output.stderr}</pre>
            </>
          )}
          {output.timedOut && <div style={{ color: '#ffa500' }}>(timed out)</div>}
        </div>
      )}
    </div>
  );
}

const runBtnStyle = {
  background: '#16825d', color: 'white', border: 'none',
  padding: '4px 12px', borderRadius: 3, cursor: 'pointer', fontSize: 12,
};
