/**
 * RemoteCursors
 *
 * Translates the remoteCursors map ({userId: {pos, selectionEnd}}) into
 * Monaco decorations. Decorations are the right primitive here because:
 *   - They reposition automatically as the document changes.
 *   - They're cheap to update in bulk.
 *   - They don't interfere with the user's own cursor.
 *
 * We use one decoration per remote user for the caret (a thin colored
 * vertical line, achieved via a CSS-injected ::before pseudo-element)
 * and another for any non-empty selection.
 */

import { useEffect, useRef } from 'react';
import { colorFor } from '../utils/colors';

export function RemoteCursors({ editorRef, cursors }) {
  const decoIdsRef = useRef([]);
  const styleElRef = useRef(null);

  // Inject one stylesheet for caret colors keyed by class name.
  useEffect(() => {
    if (!styleElRef.current) {
      const el = document.createElement('style');
      document.head.appendChild(el);
      styleElRef.current = el;
    }
    const rules = [];
    for (const userId of Object.keys(cursors)) {
      const c = colorFor(userId);
      const cls = classFor(userId);
      // Caret: 2px vertical line via border-left
      rules.push(
        `.${cls}-caret { border-left: 2px solid ${c}; margin-left: -1px; position: relative; }`,
        `.${cls}-caret::after { content: attr(data-name); position: absolute; top: -1.4em; left: -1px; background: ${c}; color: white; font-size: 10px; padding: 0 4px; border-radius: 2px; white-space: nowrap; }`,
        `.${cls}-sel { background: ${c}33; }`, // 33 = 20% alpha
      );
    }
    styleElRef.current.textContent = rules.join('\n');
  }, [cursors]);

  // Apply / refresh decorations whenever cursors change.
  useEffect(() => {
    const editor = editorRef.current;
    if (!editor) return;
    const model = editor.getModel();
    if (!model) return;

    const newDecos = [];
    for (const [userId, { pos, selectionEnd }] of Object.entries(cursors)) {
      const cls = classFor(userId);
      const start = model.getPositionAt(Math.min(pos, selectionEnd));
      const end = model.getPositionAt(Math.max(pos, selectionEnd));
      const caret = model.getPositionAt(pos);

      // Selection background (only if non-empty)
      if (pos !== selectionEnd) {
        newDecos.push({
          range: { startLineNumber: start.lineNumber, startColumn: start.column,
                   endLineNumber: end.lineNumber, endColumn: end.column },
          options: { className: `${cls}-sel`, stickiness: 1 },
        });
      }
      // Caret
      newDecos.push({
        range: { startLineNumber: caret.lineNumber, startColumn: caret.column,
                 endLineNumber: caret.lineNumber, endColumn: caret.column },
        options: { className: `${cls}-caret`, stickiness: 1, hoverMessage: { value: userId } },
      });
    }

    decoIdsRef.current = editor.deltaDecorations(decoIdsRef.current, newDecos);
  }, [cursors, editorRef]);

  return null; // pure side-effect component
}

function classFor(userId) {
  // Class names must be CSS-safe.
  return 'rc-' + userId.replace(/[^a-zA-Z0-9_-]/g, '_');
}
