/**
 * useCollabSession({ url, sessionId, userId, monacoModel })
 *
 * Lifecycle:
 *   - Opens a ReconnectingWS to the backend.
 *   - On WS open, sends `join`. Server replies with `joined` + initial doc.
 *   - Wires Monaco's onDidChangeModelContent -> emits ops to server.
 *   - Wires server `remote_op` / `remote_cursor` -> applies into Monaco.
 *
 * Avoiding feedback loops:
 *   When we apply a REMOTE op into Monaco, that triggers Monaco's change
 *   event, which would normally re-send the op back to the server. We
 *   guard with `applyingRemote` and skip emit while it's true. Same for
 *   the initial `joined` snapshot.
 *
 * Cursor broadcasting is throttled to 30Hz (32ms) — humans can't perceive
 * faster than that and it'd flood the network.
 */

import { useEffect, useRef, useState } from 'react';
import { ReconnectingWS } from '../services/ws';
import { ClientOT } from '../services/otClient';

const CURSOR_THROTTLE_MS = 32;

export function useCollabSession({ url, sessionId, userId, monaco, editorRef }) {
  const [connected, setConnected] = useState(false);
  const [activeUsers, setActiveUsers] = useState([]);
  const [remoteCursors, setRemoteCursors] = useState({}); // userId -> {pos, selectionEnd}
  const wsRef = useRef(null);
  const otRef = useRef(new ClientOT());
  const applyingRemoteRef = useRef(false);
  const lastCursorSentRef = useRef(0);

  useEffect(() => {
    if (!editorRef.current || !monaco) return;

    const ws = new ReconnectingWS(url);
    wsRef.current = ws;
    const ot = otRef.current;

    const offOpen = ws.on('open', () => {
      setConnected(true);
      ws.send({
        type: 'join', sessionId, userId,
        // include resyncRev so server can replay missed ops if it wants
        clientRev: ot.serverRev,
      });
      // Re-send any pending ops the user typed while offline.
      for (const p of ot.pending) {
        ws.send({ type: 'op', op: { ...p, baseRev: ot.serverRev } });
      }
    });
    const offClose = ws.on('close', () => setConnected(false));

    const offMsg = ws.on('message', (msg) => {
      switch (msg.type) {
        case 'joined': {
          ot.serverRev = msg.doc.rev;
          ot.pending = [];
          setActiveUsers(msg.activeUsers || []);
          // Replace editor content without re-emitting.
          applyingRemoteRef.current = true;
          editorRef.current.getModel().setValue(msg.doc.text);
          applyingRemoteRef.current = false;
          // Initial cursors from existing peers
          const cursorMap = {};
          (msg.cursors || []).forEach(c => {
            if (c.userId !== userId) cursorMap[c.userId] = { pos: c.pos, selectionEnd: c.selectionEnd };
          });
          setRemoteCursors(cursorMap);
          break;
        }
        case 'ack': {
          ot.ack(msg.opId, msg.rev);
          break;
        }
        case 'remote_op': {
          if (msg.author === ot.clientId) return; // shouldn't happen; defensive
          const transformed = ot.applyRemote(msg.op, msg.rev);
          applyingRemoteRef.current = true;
          try { applyOpToEditor(editorRef.current, transformed); }
          finally { applyingRemoteRef.current = false; }
          break;
        }
        case 'remote_cursor': {
          if (msg.userId === userId) return;
          setRemoteCursors(prev => ({ ...prev, [msg.userId]: { pos: msg.pos, selectionEnd: msg.selectionEnd } }));
          break;
        }
        case 'user_joined': {
          setActiveUsers(prev => prev.includes(msg.userId) ? prev : [...prev, msg.userId]);
          break;
        }
        case 'user_left': {
          setActiveUsers(prev => prev.filter(u => u !== msg.userId));
          setRemoteCursors(prev => { const c = { ...prev }; delete c[msg.userId]; return c; });
          break;
        }
        case 'resync_required': {
          ot.resync(msg.text, msg.serverRev);
          applyingRemoteRef.current = true;
          editorRef.current.getModel().setValue(msg.text);
          applyingRemoteRef.current = false;
          break;
        }
        default: break;
      }
    });

    // Wire Monaco -> outbound ops
    const editor = editorRef.current;
    const model = editor.getModel();
    const changeSub = model.onDidChangeContent((e) => {
      if (applyingRemoteRef.current) return;
      // Monaco emits a SINGLE change event per keystroke containing one or
      // more ranges. We translate each into an OT op and send in order.
      // For batched changes (paste), this means a burst of ops — but each
      // is small and the server's queue handles batching naturally.
      for (const ch of e.changes) {
        // Monaco gives us rangeOffset (0-based) and the new text.
        // Delete = old length > 0; Insert = new text length > 0.
        // The order matters: delete first, then insert at same position.
        if (ch.rangeLength > 0) {
          const op = ot.trackLocal({
            opId: cryptoRandom(),
            type: 'delete',
            pos: ch.rangeOffset,
            length: ch.rangeLength,
          });
          ws.send({ type: 'op', op });
        }
        if (ch.text && ch.text.length > 0) {
          const op = ot.trackLocal({
            opId: cryptoRandom(),
            type: 'insert',
            pos: ch.rangeOffset,
            text: ch.text,
          });
          ws.send({ type: 'op', op });
        }
      }
    });

    // Wire Monaco -> outbound cursor (throttled)
    const cursorSub = editor.onDidChangeCursorPosition(() => {
      const now = performance.now();
      if (now - lastCursorSentRef.current < CURSOR_THROTTLE_MS) return;
      lastCursorSentRef.current = now;
      const sel = editor.getSelection();
      const model = editor.getModel();
      const pos = model.getOffsetAt(sel.getStartPosition());
      const selectionEnd = model.getOffsetAt(sel.getEndPosition());
      ws.send({ type: 'cursor', pos, selectionEnd });
    });

    return () => {
      offOpen(); offClose(); offMsg();
      changeSub.dispose(); cursorSub.dispose();
      ws.close();
    };
  }, [url, sessionId, userId, monaco, editorRef]);

  return { connected, activeUsers, remoteCursors, clientId: otRef.current.clientId };
}

// Apply a (server-canonical, already transformed) op to the Monaco model.
// We compute a Monaco edit from the OT op's offset and execute it as a
// model edit so undo stack stays usable.
function applyOpToEditor(editor, op) {
  const model = editor.getModel();
  if (!model) return;
  const startPos = model.getPositionAt(op.pos);
  if (op.type === 'insert') {
    const range = { startLineNumber: startPos.lineNumber, startColumn: startPos.column,
                    endLineNumber: startPos.lineNumber, endColumn: startPos.column };
    model.applyEdits([{ range, text: op.text, forceMoveMarkers: true }]);
  } else if (op.type === 'delete') {
    const endPos = model.getPositionAt(op.pos + op.length);
    const range = { startLineNumber: startPos.lineNumber, startColumn: startPos.column,
                    endLineNumber: endPos.lineNumber, endColumn: endPos.column };
    model.applyEdits([{ range, text: '', forceMoveMarkers: true }]);
  }
}

function cryptoRandom() {
  // Cheap unique ID for opIds. Crypto.getRandomValues if you want stronger.
  return `op-${Math.random().toString(36).slice(2)}-${Date.now().toString(36)}`;
}
