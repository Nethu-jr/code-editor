# OT vs CRDT — Why This System Uses OT

Both **Operational Transformation (OT)** and **Conflict-free Replicated Data Types (CRDTs)** solve the same core problem: letting many clients edit the same document concurrently and converge to the same final state. They take fundamentally different approaches, and the right choice depends on your topology.

## The two models in one paragraph each

**OT** treats every edit as an operation against a specific document revision. When a server receives an op based on an older revision, it *transforms* it against every op that has been applied since. The transform function is the heart of the algorithm — get it wrong and clients silently diverge. OT requires a **central authoritative server** to assign a global op order; this is what makes the math tractable.

**CRDTs** sidestep the transform problem by making operations *commutative by construction*. Each character gets a globally-unique identifier (typically a fractional position, or a tree path) so that "insert X after Y" is meaningful regardless of order. Apply ops in any order on any peer — they all converge. This works **without a central server**, which is the killer feature for offline-first and peer-to-peer.

## Side-by-side

| Dimension | OT | CRDT |
|---|---|---|
| **Topology** | Star (all clients ↔ central server) | Any (peer-to-peer, gossip, server-mediated, hybrid) |
| **Ordering** | Server assigns total order | Each op carries enough metadata to be reordered freely |
| **Op size** | Tiny — just `{type, pos, text}` (~30 bytes) | Larger — every char carries an ID (~30-50 bytes per char inserted) |
| **Document size on the wire / disk** | O(text length) | O(text length × per-char metadata); tombstones for deleted chars persist |
| **Algorithm complexity** | Transform fn is fiddly; TP1/TP2 invariants are easy to break | Datatype design is fiddly (interleaving anomalies in early CRDTs); modern designs (Yjs, Automerge) have solved most of this |
| **Server requirement** | Required (and is a SPOF without HA) | Optional |
| **Offline editing** | Possible but awkward — long divergence = expensive resync | Native — that's the whole point |
| **Undo/redo** | Natural (op log is linear) | Harder (you have to invert ops that other peers may already have applied) |
| **Memory in long sessions** | Bounded by snapshot+compact | Grows with edit history unless you garbage-collect tombstones |
| **Production examples** | Google Docs, Etherpad, Firepad | Figma's multiplayer, Linear, Apple Notes (Yjs/Automerge backends) |

## Why I chose OT for this system

Three reasons, in priority order:

1. **The product is server-mediated by design.** Users join via a sessionId, the server runs code in a sandbox, the AI service is a server-side dependency anyway. We're not building offline-first; we're building real-time. OT's "central server is required" constraint costs us nothing.

2. **Wire and storage efficiency.** A workshop with 50 people typing in the same file generates ~1500 edits/minute. OT ops are ~30 bytes; CRDT ops with per-char IDs are ~10× that for the same content. Over Redis Pub/Sub at scale, that's a real bandwidth bill.

3. **Simpler mental model when debugging.** OT has a single `transform(a, b)` function and a linear op log. When a session drifts, you can replay the log and find the exact op where things went wrong. CRDT bugs tend to surface as "two characters interleaved weirdly six minutes ago" — much harder to reason about.

## When you should choose CRDT instead

Pick CRDT if **any** of these are true:

- **Offline editing is a real use case.** A pull request reviewer on a plane needs to edit the doc and reconcile when they reconnect. With OT, a 2-hour offline edit means a giant `STALE_BASE_REV` resync. With CRDT, you just merge.
- **Peer-to-peer is desired.** If you want WebRTC-direct collaboration with no server (e.g., a self-hosted desktop app sharing files via IPFS), CRDT is the only sensible answer.
- **Multi-region active-active.** Running OT servers in two regions with cross-region replication is technically possible but you end up implementing CRDT semantics on top of OT, badly. Just use a CRDT.
- **You're already using Yjs/Automerge.** They have mature ecosystems with bindings for Monaco, ProseMirror, TipTap, etc. Don't reinvent.

## Hybrid approaches worth knowing

- **Server-coordinated CRDT**: Yjs supports running a server (`y-websocket`) that just relays messages. You get the simple deployment of OT with the merge semantics of CRDT. The cost is the larger op size.
- **OT with checkpoint-based offline**: Allow offline edits up to N ops; on reconnect, fetch the server's op log and replay-transform locally. Works but feels bolted-on.

## TL;DR for the interview answer

> "OT requires a central server but produces tiny ops and is simple to reason about. CRDT is server-optional and merges arbitrary divergent histories but has larger ops and harder GC. We chose OT because our product is server-mediated anyway and we want minimal bandwidth at scale. If we ever wanted offline-first or P2P, we'd switch to a CRDT — likely Yjs because its Monaco binding is mature."
