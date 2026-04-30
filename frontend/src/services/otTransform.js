// !!! KEEP IN SYNC with backend/src/ot/transform.js !!!
// Both files must implement the SAME transform(); divergence breaks convergence.

/**
 * transform(a, b)
 *
 * Given two concurrent operations a and b that were both authored against
 * the SAME base document state, return [aPrime, bPrime] such that:
 *
 *      apply(apply(D, a), bPrime)  ===  apply(apply(D, b), aPrime)
 *
 * In other words: after both clients apply both ops (in either order),
 * they converge to the same document. This is the TP1 property.
 *
 * On the server we only ever need aPrime (the version of `a` that's been
 * rebased past `b`), because the server is canonical. But we expose both
 * so the client can use the same code.
 *
 * For tie-breaking when two inserts hit the exact same position, we use
 * clientId lexicographic order. Both peers must agree on this rule or
 * convergence breaks.
 */

function transform(a, b) {
  // Cursor ops are advisory — they shift but don't affect the doc.
  if (a.type === 'cursor' || b.type === 'cursor') {
    return [transformCursor(a, b), transformCursor(b, a)];
  }

  if (a.type === 'insert' && b.type === 'insert') {
    return transformInsertInsert(a, b);
  }
  if (a.type === 'insert' && b.type === 'delete') {
    return transformInsertDelete(a, b);
  }
  if (a.type === 'delete' && b.type === 'insert') {
    const [bp, ap] = transformInsertDelete(b, a);
    return [ap, bp];
  }
  if (a.type === 'delete' && b.type === 'delete') {
    return transformDeleteDelete(a, b);
  }
  throw new Error(`Unknown op pair: ${a.type}/${b.type}`);
}

// --- insert vs insert ---------------------------------------------------
function transformInsertInsert(a, b) {
  // a authored at a.pos, b authored at b.pos against same base.
  // Each one needs to know: "did the OTHER op shift my position?"
  if (a.pos < b.pos || (a.pos === b.pos && a.clientId < b.clientId)) {
    // a goes first conceptually -> b shifts right by len(a.text)
    return [
      a, // a is unchanged when rebased past b that came "after" it
      { ...b, pos: b.pos + a.text.length },
    ];
  } else {
    return [
      { ...a, pos: a.pos + b.text.length },
      b,
    ];
  }
}

// --- insert vs delete ---------------------------------------------------
function transformInsertDelete(ins, del) {
  // ins is an insert at ins.pos; del removes [del.pos, del.pos+del.length).
  if (ins.pos <= del.pos) {
    // insert is before the deleted range -> deletion shifts right
    return [
      ins,
      { ...del, pos: del.pos + ins.text.length },
    ];
  } else if (ins.pos >= del.pos + del.length) {
    // insert is after the deleted range -> insert shifts left by del.length
    return [
      { ...ins, pos: ins.pos - del.length },
      del,
    ];
  } else {
    // insert lands INSIDE the deletion. Convention: keep the inserted
    // text alive and clamp its position to the start of the (now gone) range.
    return [
      { ...ins, pos: del.pos },
      { ...del, length: del.length /* deletion still removes original chars */ },
    ];
  }
}

// --- delete vs delete ---------------------------------------------------
function transformDeleteDelete(a, b) {
  // Both delete ranges authored against same base. We need to subtract
  // their overlap so we don't double-delete characters.
  const aStart = a.pos, aEnd = a.pos + a.length;
  const bStart = b.pos, bEnd = b.pos + b.length;

  // Case 1: completely disjoint, a before b
  if (aEnd <= bStart) {
    return [a, { ...b, pos: bStart - a.length }];
  }
  // Case 2: completely disjoint, b before a
  if (bEnd <= aStart) {
    return [{ ...a, pos: aStart - b.length }, b];
  }

  // Overlapping deletes. Compute the overlap and remove it from BOTH
  // (they each only need to delete the portion the other isn't deleting).
  const overlapStart = Math.max(aStart, bStart);
  const overlapEnd = Math.min(aEnd, bEnd);
  const overlap = overlapEnd - overlapStart;

  const aNewLength = a.length - overlap;
  const bNewLength = b.length - overlap;

  // a' position: characters of b that came BEFORE a's range no longer exist
  const aShift = Math.max(0, Math.min(bEnd, aStart) - bStart);
  const bShift = Math.max(0, Math.min(aEnd, bStart) - aStart);

  const aPrime = aNewLength <= 0
    ? { ...a, type: 'noop', length: 0 }
    : { ...a, pos: aStart - aShift, length: aNewLength };

  const bPrime = bNewLength <= 0
    ? { ...b, type: 'noop', length: 0 }
    : { ...b, pos: bStart - bShift, length: bNewLength };

  return [aPrime, bPrime];
}

// --- cursor transform ---------------------------------------------------
function transformCursor(cursor, op) {
  if (cursor.type !== 'cursor') return cursor;
  if (op.type === 'insert') {
    if (op.pos <= cursor.pos) {
      return { ...cursor, pos: cursor.pos + op.text.length,
                          selectionEnd: cursor.selectionEnd + op.text.length };
    }
    return cursor;
  }
  if (op.type === 'delete') {
    const delEnd = op.pos + op.length;
    let newPos = cursor.pos;
    if (delEnd <= cursor.pos) newPos = cursor.pos - op.length;
    else if (op.pos < cursor.pos) newPos = op.pos;
    return { ...cursor, pos: newPos, selectionEnd: newPos };
  }
  return cursor;
}

export { transform };
