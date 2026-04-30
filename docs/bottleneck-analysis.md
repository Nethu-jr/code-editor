# Bottleneck Analysis

Going from "works on my laptop" to "handles real load" requires knowing **where the system breaks first**. Here's the analysis layer by layer, with the numbers that actually matter and the mitigations.

## Layer 1: Single Node.js process

A single Node.js backend process saturates around the following limits on a 4-vCPU box:

| Resource | Hard limit | Practical limit | What hits it first |
|---|---|---|---|
| Open WebSockets | ~65k (file descriptors) | **~10k concurrent** | Each WS holds a TCP socket + buffers; > 10k means GC pressure |
| Op throughput | ~50k ops/sec (microbenchmark of `transform()`) | **~5-10k ops/sec end-to-end** | JSON.parse on inbound + JSON.stringify on broadcast dominates |
| Per-session ops/sec | ~2k/sec before the FIFO queue grows unboundedly | **~500/sec** | OT transform is O(history-since-baseRev); slow clients make this grow |

**First thing to break:** event loop latency. Once it crosses ~50ms, WS pongs start dropping, clients reconnect-storm, and you spiral. Watch `process.eventLoopUtilization()` — if it's > 0.7 sustained, you're done.

**Mitigations**:
- Move JSON serialization off the hot path with a binary protocol (MessagePack ~3× faster, FlatBuffers ~10×)
- Pre-stringify broadcast messages once, send buffer to all sockets (current code already does this in `broadcastLocal`)
- Cap per-session op rate at the WS handler — reject ops faster than 100/sec/client with a friendly throttle response

## Layer 2: Redis Pub/Sub fanout

Redis Pub/Sub has a known shape:

- **Publish cost**: O(subscribers) — one message published to a channel with N subscribers does N TCP writes from the Redis process
- **Pub/Sub is not durable**: a subscriber that's slow or temporarily disconnected misses messages forever
- **Single-threaded**: all pub/sub goes through Redis's main thread

A single Redis instance saturates at roughly:
- **~1M messages/sec** total throughput (small messages, no fanout)
- **~100k subscriber-deliveries/sec** in practice (1k publishes × 100 subscribers each)

For our workload — 10k sessions × 5 ops/sec/session × 5 users/session = **250k subscriber-deliveries/sec** — one Redis is borderline. Two will be tight by mid-2027 if the product takes off.

**Mitigations** (in order of how much you should reach for them):

1. **Shard Redis by sessionId.** `sessionId → hash → shard`. Each backend connects to all shards but only subscribes to channels in the relevant ones. Linear scale-out. **Do this first.**
2. **Replace Pub/Sub with Redis Streams.** Streams are durable, support consumer groups, and let slow consumers catch up. Trade-off: ~30% more latency (~1ms vs ~0.3ms) and you have to manage consumer offsets.
3. **Replace Redis with NATS or Kafka.** NATS is purpose-built for fanout and benchmarks 5-10× higher than Redis Pub/Sub. Kafka if you want durable replay. The ops cost goes up.

## Layer 3: The OT engine itself

`ServerDocument.receive()` is O(k) where k = `serverRev - op.baseRev`. In normal operation k ≤ 5 because clients ack within a round-trip. But during a network blip or a mass-paste, k can spike to thousands.

**The real problem**: a single bad client can DoS a session. They open a WS, send op with `baseRev = 0`, type for an hour. Now every op they send transforms against thousands of history entries and blocks the queue for the whole session.

**Mitigations**:
- **Bound k**: if `serverRev - op.baseRev > 500`, refuse with `STALE_BASE_REV` and force resync. Already implemented via `historyOffset` after compaction; the fix is to set `maxHistory` to ~500 in production.
- **Per-client rate limit on the queue side**, not just the WS side
- **Move OT to a Worker thread per session** if a single session genuinely needs > 500 ops/sec. This is rare for human typing — only matters for "100 people pasting at once" scenarios.

## Layer 4: Execution engine

This is the most operationally dangerous layer. Each `/run` call does:
- `docker run` cold start: **150-500ms** baseline (image already pulled), pure overhead
- User code execution: 0-5000ms (we cap at 5s)
- Container teardown: **50-100ms**

Throughput per host is ~10-20 runs/sec sustained, much less if user code uses memory aggressively (kernel page reclaim slows everyone down).

**Bottleneck symptoms**: `/run` p99 latency climbs from 800ms to 5000ms within minutes when a class of students all click "run" at once.

**Mitigations**:
1. **Warm container pool**: keep N pre-spawned containers per language, exec into them. Drops cold start from 200ms to ~10ms. Reset filesystem/memory after each run via `tmpfs` remount.
2. **Per-user concurrency limit**: max 1 in-flight run per user. Already implicit if frontend disables the button while running, but enforce server-side too.
3. **Separate physical hosts for execution.** Don't co-locate with backend pods — a fork bomb in user code shouldn't degrade the WS layer.
4. **Replace Docker with Firecracker microVMs** for higher isolation and faster cold start (~125ms). gVisor is a middle ground — Docker-compatible but with a userspace kernel for syscall filtering.

## Layer 5: AI calls

OpenAI / Gemini calls are 200-2000ms p50, 5000ms+ p99. Failure modes:
- Provider-side rate limits (429s during peak hours)
- Provider outages (regularly happen, including unrelated incidents)
- Cost: $0.15-3 per 1M tokens

**Bottlenecks felt by users**: typing pauses, then "suggestion" appears 2 seconds later. Annoying but not breaking. The real cost concern is bill shock from runaway usage.

**Mitigations** (already partly in `aiService.js`):
- **Aggressive caching** — same prefix → same suggestion within 30s. Implemented.
- **Debouncing** — frontend waits 600ms of typing inactivity before requesting. Implemented.
- **Per-user budget limit** in tokens/day, returned as a 429 when exceeded.
- **Smaller/cheaper model for completions**, larger model only for explanations and debugging. Implemented (gpt-4o-mini).
- **Self-hosted model fallback** (a Llama 3 deployment) — kicks in when the primary provider 5xx's, even if quality is lower.

## Layer 6: WebSocket reconnection storms

Most insidious failure mode. A backend pod dies → 1000 clients reconnect within 5 seconds → they all hit the same surviving pod → that pod's event loop spikes → its WS pings start failing → another reconnect storm.

**This is the cascading failure that takes down the whole cluster.**

**Mitigations**:
1. **Jittered backoff in the client** (already in `ReconnectingWS` — exponential with cap). Add jitter: `delay * (0.5 + Math.random())`.
2. **Connection budget at the LB**: nginx `limit_conn` per IP, 100/sec per backend.
3. **Pod surge capacity**: HPA `minReplicas` should be 1.5× steady state, not 1×, so the surviving pods can absorb 50% extra without scale-up lag.
4. **Graceful drain on shutdown**: SIGTERM → mark unready → keep serving existing WS for `terminationGracePeriodSeconds` → close cleanly. Implemented.

## Summary table — what breaks first as you scale up

| Concurrent users | First bottleneck | Fix |
|---|---|---|
| 1k | Nothing — single node handles it | — |
| 10k | Single Node.js event loop | Add LB + 3 backends |
| 100k | Redis Pub/Sub CPU | Shard Redis or move to NATS |
| 1M | Cross-region latency, AI quotas, exec engine cold-start | See `scaling-1m.md` |

The order matters: don't pre-optimize past where you actually are. Spending a sprint on Redis sharding when your event loop is at 30% util is wasted work.
