import React, { useEffect, useState } from 'react';
import { Editor } from './components/Editor';
import { AIPanel } from './components/AIPanel';
import { RunPanel } from './components/RunPanel';

const LANGUAGES = ['javascript', 'python', 'cpp'];

export default function App() {
  // Read sessionId & userId from URL or generate.
  const [sessionId] = useState(() => {
    const u = new URL(window.location.href);
    return u.searchParams.get('session') || `s-${Math.random().toString(36).slice(2, 10)}`;
  });
  const [userId] = useState(() => {
    const u = new URL(window.location.href);
    return u.searchParams.get('user') || `user-${Math.random().toString(36).slice(2, 6)}`;
  });

  const [code, setCode] = useState('');
  const [language, setLanguage] = useState('javascript');

  // Keep URL up-to-date so the link is shareable.
  useEffect(() => {
    const u = new URL(window.location.href);
    u.searchParams.set('session', sessionId);
    u.searchParams.set('user', userId);
    window.history.replaceState({}, '', u);
  }, [sessionId, userId]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100vh', background: '#1e1e1e' }}>
      <div style={{
        padding: '8px 12px', borderBottom: '1px solid #333', color: '#ddd',
        display: 'flex', gap: 12, alignItems: 'center',
      }}>
        <strong style={{ fontSize: 14 }}>LiveCode Editor</strong>
        <span style={{ fontSize: 12, color: '#888' }}>session: {sessionId}</span>
        <span style={{ fontSize: 12, color: '#888' }}>you: {userId}</span>
        <select value={language} onChange={(e) => setLanguage(e.target.value)}
          style={{ marginLeft: 'auto', background: '#2a2a2a', color: '#ddd',
                   border: '1px solid #444', padding: '2px 6px', borderRadius: 3 }}>
          {LANGUAGES.map(l => <option key={l} value={l}>{l}</option>)}
        </select>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        <Editor sessionId={sessionId} userId={userId} language={language} onTextChange={setCode} />
      </div>
      <AIPanel code={code} lang={language} cursorPos={code.length} />
      <RunPanel code={code} language={language} />
    </div>
  );
}
