import React, { useState } from 'react';
import { useDebouncedAI } from '../hooks/useDebouncedAI';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';

export function AIPanel({ code, lang, cursorPos }) {
  const [enabled, setEnabled] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [busy, setBusy] = useState(false);
  const { suggestion, loading } = useDebouncedAI({ code, lang, cursorPos, enabled });

  async function explain() {
    setBusy(true);
    try {
      const r = await fetch(`${API}/ai/explain`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code, lang }),
      });
      const j = await r.json();
      setExplanation(j.explanation || '');
    } finally { setBusy(false); }
  }

  return (
    <div style={{ padding: 12, borderTop: '1px solid #333', background: '#1e1e1e', color: '#ddd' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginBottom: 8 }}>
        <label style={{ fontSize: 13 }}>
          <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} />
          {' '}Inline AI suggestions
        </label>
        <button onClick={explain} disabled={busy || !code} style={btnStyle}>
          {busy ? 'Thinking…' : 'Explain code'}
        </button>
      </div>
      {enabled && (
        <div style={{ fontSize: 12, fontFamily: 'monospace', minHeight: 24, color: '#888' }}>
          {loading ? '…' : (suggestion ? `→ ${suggestion}` : 'No suggestion')}
        </div>
      )}
      {explanation && (
        <pre style={{ whiteSpace: 'pre-wrap', fontSize: 13, marginTop: 8 }}>{explanation}</pre>
      )}
    </div>
  );
}

const btnStyle = {
  background: '#0e639c', color: 'white', border: 'none',
  padding: '4px 10px', borderRadius: 3, cursor: 'pointer', fontSize: 12,
};
