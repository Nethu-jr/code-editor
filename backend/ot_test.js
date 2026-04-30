const { ServerDocument } = require('./src/ot/document');
const { makeInsert, makeDelete } = require('./src/ot/operation');
const { transform } = require('./src/ot/transform');

// Test 1: convergence under concurrent inserts at same position
function test1() {
  const a = makeInsert({ pos: 0, text: 'A', baseRev: 0, clientId: 'alice' });
  const b = makeInsert({ pos: 0, text: 'B', baseRev: 0, clientId: 'bob' });

  // Server applies a first, then b transformed
  const s1 = new ServerDocument('', 's');
  s1.receive(a);
  s1.receive(b);

  // Server applies b first, then a transformed — but on a different "server"
  // we simulate by applying in opposite order at the OT level
  const [aPrime, bPrime] = transform(a, b);

  // Doc1: apply a, then bPrime
  let d1 = '';
  d1 = d1.slice(0, a.pos) + a.text + d1.slice(a.pos);
  d1 = d1.slice(0, bPrime.pos) + bPrime.text + d1.slice(bPrime.pos);

  // Doc2: apply b, then aPrime
  let d2 = '';
  d2 = d2.slice(0, b.pos) + b.text + d2.slice(b.pos);
  d2 = d2.slice(0, aPrime.pos) + aPrime.text + d2.slice(aPrime.pos);

  console.log('Test1 (concurrent inserts same pos):', d1, '==', d2, d1 === d2 ? 'PASS' : 'FAIL');
}

// Test 2: insert vs delete that overlap
function test2() {
  // doc = "hello world", a inserts "X" at pos 6, b deletes "world" (pos 6, len 5)
  const a = makeInsert({ pos: 6, text: 'X', baseRev: 0, clientId: 'alice' });
  const b = { opId:'b', type:'delete', pos: 6, length: 5, baseRev: 0, clientId: 'bob' };

  const [aPrime, bPrime] = transform(a, b);

  const base = 'hello world';
  // Path 1: apply a then bPrime
  let d1 = base.slice(0, a.pos) + a.text + base.slice(a.pos);
  d1 = d1.slice(0, bPrime.pos) + d1.slice(bPrime.pos + bPrime.length);

  // Path 2: apply b then aPrime
  let d2 = base.slice(0, b.pos) + base.slice(b.pos + b.length);
  d2 = d2.slice(0, aPrime.pos) + aPrime.text + d2.slice(aPrime.pos);

  console.log('Test2 (insert inside delete):', JSON.stringify(d1), '==', JSON.stringify(d2), d1 === d2 ? 'PASS' : 'FAIL');
}

// Test 3: two overlapping deletes
function test3() {
  // doc = "abcdefgh"
  // a deletes pos 1 len 4 ("bcde")
  // b deletes pos 3 len 3 ("def")
  const base = 'abcdefgh';
  const a = { opId:'a', type:'delete', pos: 1, length: 4, baseRev: 0, clientId: 'alice' };
  const b = { opId:'b', type:'delete', pos: 3, length: 3, baseRev: 0, clientId: 'bob' };

  const [aPrime, bPrime] = transform(a, b);

  const applyDel = (s, op) => {
    if (op.type === 'noop' || op.length === 0) return s;
    return s.slice(0, op.pos) + s.slice(op.pos + op.length);
  };

  const d1 = applyDel(applyDel(base, a), bPrime);
  const d2 = applyDel(applyDel(base, b), aPrime);
  console.log('Test3 (overlapping deletes):', JSON.stringify(d1), '==', JSON.stringify(d2), d1 === d2 ? 'PASS' : 'FAIL');
  console.log('  Expected: "afgh" (union of deletes removed b,c,d,e,f)');
}

// Test 4: ServerDocument.receive() with history
function test4() {
  const doc = new ServerDocument('hello', 's');
  // Client X inserts " world" at end (baseRev 0)
  const opX = makeInsert({ pos: 5, text: ' world', baseRev: 0, clientId: 'x' });
  doc.receive(opX);
  console.log('  After X:', JSON.stringify(doc.text), 'rev=', doc.rev);

  // Client Y, also based on rev 0, inserts "!" at pos 5 (end of "hello")
  const opY = makeInsert({ pos: 5, text: '!', baseRev: 0, clientId: 'y' });
  const r = doc.receive(opY);
  console.log('  After Y:', JSON.stringify(doc.text), 'rev=', doc.rev, 'applied:', r.applied);
  // Expected: "hello! world" OR "hello world!" depending on tie-break.
  // Tie-break uses clientId: 'x' < 'y', so X is conceptually first,
  // meaning Y's pos shifts right by len(' world') = 6 -> Y inserts at 11.
  // Result: "hello world!"
  console.log('Test4:', doc.text === 'hello world!' ? 'PASS' : 'FAIL', '(got', JSON.stringify(doc.text) + ')');
}

test1(); test2(); test3(); test4();
