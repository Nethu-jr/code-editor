# System Design Interview — How to Walk Through This

A 45-minute system design interview on "design Google Docs / VS Code Live Share" generally follows: **clarify → high-level design → deep dive on 1-2 components → scaling → wrap up**. Here's a tight script using this codebase as the worked example.

## Phase 1 (5 min) — Clarify requirements

Ask, don't assume. The interviewer is grading whether you scope before building.

**Functional**:
- "Real-time" — what's the latency budget? *Aim for < 100ms p99 within a region.*
- How many concurrent users per session? *Typically 5-20; design for up to 100.*
- How many concurrent sessions? *Start at 100k, design for 10M.*
- Document size? *Target ≤ 1 MB; larger is a separate problem.*
- Languages for code execution? *Three to start — Python, JS, C++.*
- AI features? *Inline suggestions + explain on demand.*

**Non-functional**:
- Availability target? *99.9% (~8h/year downtime acceptable).*
- Consistency? *Strong within a session, eventual across sessions.*
- Offline support? *Not in V1 — flag this, it changes the OT vs CRDT decision.*

State the result back: *"OK so I'm building a server-mediated collaborative editor, ≤ 100 users per session, sub-100ms p99 within region, no offline V1, three execution languages."*

## Phase 2 (10 min) — High-level design

Draw this on the whiteboard:

```
[Browser w/ Monaco] -- WSS --> [LB w/ sticky] --> [Stateless app servers] -- Pub/Sub --> [Redis]
                                                       |          |
                                                       v          v
                                                   [AI svc]  [Exec engine in Docker pool]
                                                       |
                                                       v
                                                   [Postgres for snapshots/users]
```

Talk through the **edit lifecycle** end-to-end:

1. User types → Monaco emits a delta
2. Client wraps it as `{type, pos, text, baseRev, clientId}` and sends over WS
3. The app server it lands on enqueues the op in a per-session FIFO queue
4. Worker dequeues, runs OT transform against ops in history since `baseRev`, applies to canonical doc, increments rev
5. Server publishes to `room:{sessionId}` on Redis Pub/Sub + ACKs the originator
6. All other app servers subscribed to that channel deliver to their connected clients

This is enough for the interviewer to know you understand the data flow. If they don't push deeper here, move on to scaling.

## Phase 3 (15 min) — Deep dive: pick OT *or* execution engine

Most interviewers will pick OT (it's the meatiest CS topic). Some will pick the sandbox (security-focused interviewers love this).

### If they pick OT

Lead with the problem statement: *"Two clients typing the same character at the same position — without coordination, their docs diverge."* Then:

1. **Why central server.** With a central server, we can assign a total order to ops. Concurrent ops based on the same `baseRev` get rebased in arrival order.
2. **The transform function.** Walk through one case from `transform.js` — I'd pick insert-vs-insert because it's the easiest to draw:
   - Both clients insert at pos 5, base rev 0
   - Server applies A's "X" first → doc rev 1
   - Server receives B's "Y" with baseRev 0 → transforms against A: shift B.pos to 6 → applies → doc rev 2
   - Result: "...XY..."
3. **TP1 invariant.** "After both clients apply both ops in either order, they get the same doc." Mention TP2 (three-way concurrent ops) and that it's harder; we sidestep it because the central server linearizes.
4. **Tie-breaking.** Two inserts at exact same position need a deterministic rule. We use lexicographic clientId comparison. Both peers MUST agree.
5. **Edge case I'd raise myself**: what if a client is offline for an hour and reconnects? Their `baseRev` is way behind the server's. Show the `STALE_BASE_REV` path — server replies with snapshot, client discards pending.

This earns full marks on most rubrics.

### If they pick the execution engine

Lead with the threat model: *"User uploads `os.system('rm -rf /')` — what stops it?"* Then walk through the defense layers:

1. **Process boundary** — separate service from the main backend. A compromised sandbox can't read DB creds or steal Redis keys.
2. **Container boundary** — `docker run --network none --read-only --cap-drop=ALL --memory=128m --pids-limit=64 --security-opt no-new-privileges`. Each flag prevents a specific attack class:
   - `--network none`: can't exfiltrate data or download payloads
   - `--read-only`: can't persist anything across runs
   - `--cap-drop=ALL`: no `CAP_NET_RAW`, no `CAP_SYS_ADMIN`, etc.
   - `--memory=128m`: bounded blast radius for OOM bombs
   - `--pids-limit=64`: stops fork bombs
3. **Wall-clock kill** — host-side timeout, kills the container if user code doesn't exit
4. **Output cap** — stop reading stdout after 1 MB so a `while True: print('a')` doesn't fill our memory
5. **What I'd add for production**: gVisor or Firecracker for syscall-level isolation, dedicated pool of execution hosts (no co-location with WS pods), per-user concurrency cap

The killer line: *"The Docker socket is mounted into the engine container — that's effectively root on the host. In real production I'd use Sysbox or a remote build service, not docker.sock. I called this out in the Dockerfile comments."*

## Phase 4 (10 min) — Scaling

The interviewer will ask "what if you have a million users?" Don't panic — refer them to `scaling-1m.md` mentally and walk through:

- **Stateless app servers** scale horizontally. HPA on CPU + WS connection count. Sticky sessions at the LB.
- **Redis is the SPOF**. Shard by sessionId. For 1M users we'd need ~10 Redis shards. Each session's state lives on exactly one shard.
- **Multi-region**: each region is independent. Sessions are pinned to a region (geo-DNS routes the user to the closest one). Cross-region collaboration is a separate, harder problem — flag it explicitly, don't try to solve it on the fly.
- **AI is rate-limited by the provider**. Per-user budget caps + caching. Self-hosted Llama as fallback.
- **Execution scales separately** — different curves than WS, different host pool.

## Phase 5 (5 min) — What you'd improve

This is where you score points by being self-critical. From this codebase:

- "I'm using plain string for the document buffer; for files > 100KB I'd swap in a rope or piece-table."
- "OT history is in-memory per session; for true HA across pod restarts I'd persist to Redis Streams as the source of truth, with the in-memory copy as cache."
- "Cross-node op fanout assumes Redis Pub/Sub doesn't drop — that's not safe under load. I'd move to Redis Streams + consumer groups, or a small Kafka, for the ops topic."
- "I haven't shown end-to-end metrics — Prometheus on event-loop lag, op-queue depth, p99 transform latency, and Redis fanout queue depth would be where I'd start."

## Phrases that land well

- *"Let me state my assumptions before I start drawing"*
- *"This is a tradeoff — here's the alternative and when I'd pick it"*
- *"I want to flag this is a SPOF; here's the mitigation"*
- *"For V1 I'd cut this; for V2 I'd add..."*

## Phrases that lose points

- "It just works" (no — explain how)
- "We'd use Kafka" (without justifying why over the simpler option)
- "Microservices" (without saying which ones, why split there, what the contract is)
- Drawing 14 boxes before saying anything about data flow

## The shape of a passing answer

> "I'd run stateless Node.js app servers behind a sticky load balancer. Each holds in-memory state for the WebSocket connections it owns. Edits flow through a per-session FIFO queue, get transformed by an OT engine against history-since-baseRev, applied to a canonical buffer, and broadcast — locally directly, and to other servers via Redis Pub/Sub. Snapshots persist to Redis every 50 ops. Auth is JWT. Code execution is a separate service that spawns hardened Docker containers per request. AI is a thin adapter with caching and per-user budgets. For 1M users we shard Redis by sessionId, run 50+ app pods per region, and pin sessions to a region with geo-DNS."

Two minutes. Hits every rubric line.
