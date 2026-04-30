/**
 * Operation: the atomic unit of change in our OT system.
 *
 * We use *character-wise* operations (insert/delete a single character or
 * short string at a position). This keeps transform() simple and correct.
 * A full text-op CRDT-style would need multi-component ops; that's a
 * deliberate tradeoff for clarity here.
 *
 * Fields:
 *   type:     'insert' | 'delete' | 'cursor'
 *   pos:      0-based offset in the document at the time the op was authored
 *   text:     for insert: the string to insert
 *   length:   for delete: number of characters to remove starting at pos
 *   baseRev:  the server revision the client based this op on (used to
 *             figure out which historical ops we must transform against)
 *   clientId: stable per-tab identifier — used for tie-breaking
 *   opId:     unique id for ack/dedup
 */

const { randomUUID } = require('crypto');

function makeInsert({ pos, text, baseRev, clientId }) {
  return {
    opId: randomUUID(),
    type: 'insert',
    pos,
    text,
    baseRev,
    clientId,
  };
}

function makeDelete({ pos, length, baseRev, clientId }) {
  return {
    opId: randomUUID(),
    type: 'delete',
    pos,
    length,
    baseRev,
    clientId,
  };
}

function makeCursor({ pos, selectionEnd, clientId }) {
  // Cursor ops are NOT transformed against insert/delete the same way —
  // they just shift, and they are NOT part of the canonical op log.
  return {
    type: 'cursor',
    pos,
    selectionEnd: selectionEnd ?? pos,
    clientId,
  };
}

module.exports = { makeInsert, makeDelete, makeCursor };
