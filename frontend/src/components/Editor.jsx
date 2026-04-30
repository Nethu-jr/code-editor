import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import { useCollabSession } from '../hooks/useCollabSession';
import { RemoteCursors } from './RemoteCursors';

const WS_URL = import.meta.env.VITE_WS_URL || 'ws://localhost:4000/ws';

export function Editor({ sessionId, userId, language = 'javascript', onTextChange }) {
  const containerRef = useRef(null);
  const editorRef = useRef(null);

  // Mount Monaco
  useEffect(() => {
    const editor = monaco.editor.create(containerRef.current, {
      value: '',
      language,
      theme: 'vs-dark',
      automaticLayout: true,
      minimap: { enabled: false },
      fontSize: 14,
      tabSize: 2,
    });
    editorRef.current = editor;
    return () => editor.dispose();
  }, []);

  // Update language when prop changes
  useEffect(() => {
    if (!editorRef.current) return;
    const model = editorRef.current.getModel();
    if (model) monaco.editor.setModelLanguage(model, language);
  }, [language]);

  // Notify parent of content changes (for AI / run)
  useEffect(() => {
    if (!editorRef.current) return;
    const sub = editorRef.current.getModel().onDidChangeContent(() => {
      onTextChange?.(editorRef.current.getModel().getValue());
    });
    return () => sub.dispose();
  }, [onTextChange]);

  const { connected, activeUsers, remoteCursors, clientId } = useCollabSession({
    url: WS_URL,
    sessionId,
    userId,
    monaco,
    editorRef,
  });

  return (
    <div style={{ position: 'relative', height: '100%' }}>
      <div ref={containerRef} style={{ height: '100%', width: '100%' }} />
      <RemoteCursors editorRef={editorRef} cursors={remoteCursors} />
      <div style={{
        position: 'absolute', top: 8, right: 12, fontSize: 12,
        color: connected ? '#7CFC00' : '#FF6347',
        background: 'rgba(0,0,0,0.5)', padding: '2px 8px', borderRadius: 4,
        pointerEvents: 'none', zIndex: 10,
      }}>
        {connected ? `● Live · ${activeUsers.length} user${activeUsers.length===1?'':'s'}` : '○ Reconnecting...'}
      </div>
    </div>
  );
}
