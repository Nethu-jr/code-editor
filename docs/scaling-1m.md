# Scaling to 1M+ Concurrent Users

This is the "stretch" question every system design interview ends on, and the answer is mostly **don't try to do it on a single Redis**. Here's the honest path.

## The numbers we're sizing against

Assumptions for the working math:
- 1,000,000 concurrent connected users
- Average session size: 5 users → 200,000 active sessions
- Average edit rate: 1 op/sec/user during active editing → 1M ops/sec at peak
- Fanout: each op delivered to 4 other users → 4M deliveries/sec
- p99 latency target: 100ms within region

## The architecture at this scale

```
┌──────────────────────────────────────────────────────────────────┐
│                       GLOBAL DNS (geo-routed)                     │
└────────┬──────────────────┬────────────────────┬─────────────────┘
         ▼                  ▼                    ▼
   ┌──────────┐       ┌──────────┐         ┌──────────┐
   │ Region   │       │ Region   │         │ Region   │
   │  US-EAST │       │  EU-WEST │         │ APAC-SE  │
   │          │       │          │         │          │
   │ ┌──────┐ │       │ ┌──────┐ │         │ ┌──────┐ │
   │ │ LB+  │ │       │ │ LB+  │ │         │ │ LB+  │ │
   │ │TLS   │ │       │ │TLS   │ │         │ │TLS   │ │
   │ └──┬───┘ │       │ └──┬───┘ │         │ └──┬───┘ │
   │    ▼     │       │    ▼     │         │    ▼     │
   │ ┌────────┐│      │ ┌────────┐│        │ ┌────────┐│
   │ │ 100×   ││      │ │ 60×    ││        │ │ 40×    ││
   │ │ Node   ││      │ │ Node   ││        │ │ Node   ││
   │ │ pods   ││      │ │ pods   ││        │ │ pods   ││
   │ └────┬───┘│      │ └────┬───┘│        │ └────┬───┘│
   │      ▼    │      │      ▼    │        │      ▼    │
   │ ┌────────┐│      │ ┌────────┐│        │ ┌────────┐│
   │ │ Redis  ││      │ │ Redis  ││        │ │ Redis  ││
   │ │ Cluster││      │ │ Cluster││        │ │ Cluster││
   │ │ 16 shrd││      │ │ 12 shrd││        │ │ 8 shrd ││
   │ └────────┘│      │ └────────┘│        │ └────────┘│
   └──────────┘       └──────────┘         └──────────┘
        \                  |                     /
         \              [Postgres]              /
          \  (cross-region replication, R/W   /
           \   primary in US-EAST, others RR)
```

## Sizing each layer

### App servers (Node.js)

- **Per-pod limit**: 5,000 concurrent WS (event loop saturates around there with our op rate)
- **For 1M users**: 200 pods minimum, run 250 for headroom
- **Distribution**: roughly proportional to regional traffic (US-EAST 50%, EU 30%, APAC 20%)

The pods are stateless. Sticky sessions at the LB ensure each WS lives on one pod for its duration. When the pod dies, clients reconnect (jittered backoff) and re-land somewhere with state restored from Redis.

### Redis (the hard part)

A single Redis instance can do ~100k pub/sub deliveries/sec sustainably. We need 4M/sec across the cluster.

**Shard by sessionId hash.** Each session lives on exactly one shard:
- US-EAST: 16 shards × 250k deliveries/sec each = 4M/sec capacity within the region
- EU-WEST: 12 shards
- APAC: 8 shards

**Topology**: Redis Cluster (not just a bunch of Redis instances). Each shard has 1 primary + 2 replicas. Backend pods connect to all shards but only subscribe to the channels for sessions hashed to a given shard.

**Why not move to Kafka or NATS at this scale?** You can. Kafka adds durable replay (great for crash recovery) but adds 5-20ms of latency that puts our p99 at risk. NATS JetStream is the sweet spot — pub/sub semantics with optional persistence. For this design, sharded Redis Cluster + Postgres for snapshots is the simplest answer that hits the SLO.

### Postgres (snapshots + user data)

- **Reads** dominate (one read per session join, ~100k/sec peak)
- **Writes** are sparse (snapshot per session every 50 ops, ~5k/sec)
- **Pattern**: write to single primary in US-EAST, async streaming replication to read-replicas in EU and APAC. Reads are eventually-consistent (a few seconds stale max). For session-rejoin freshness, prefer Redis snapshot over Postgres.

### Execution engine

- Cold start is the killer. With a warm pool of 100 containers per language per host and 50 hosts, we sustain ~5,000 concurrent runs at sub-200ms p99 first-byte.
- **Don't co-locate with app pods.** Different scaling curve, different security profile, different failure domain.
- **Per-user concurrency cap of 1.** If the same user clicks "run" twice, the second is queued, not parallel.

### AI service

This is where you negotiate with Anthropic/OpenAI/Google. At 1M users:
- Inline suggestions: assume 10% of users have it on, debounced to ~1 req/15s/user → 6,700 req/sec
- That's an enterprise-scale dedicated capacity contract; you're not on pay-as-you-go
- **Caching saves 30-50%** in our access pattern (lots of identical "type at end of comment" prefixes)
- **Self-hosted fallback** for graceful degradation when the provider has incidents (which they do)

## The four hard problems at this scale

### 1. Cross-region collaboration

What if a user in Tokyo and a user in Frankfurt are in the same session?

**The answer most candidates give**: "We'll replicate ops globally."  
**Why it's wrong**: Cross-region RTT is 100-200ms. OT requires ordering. You'd be doubling your latency for no good reason.

**The right answer**: pin each session to a single region. Geo-DNS routes the *first* user; subsequent joiners go to the same region's pod by sessionId lookup in a global key-value store (Cloudflare Durable Objects, Spanner, or DynamoDB Global Tables). The far-away user accepts +150ms latency for being far away. This is the same tradeoff Google Docs makes.

**If true multi-region active-active is a hard requirement**, you need to switch from OT to CRDT — no way around it.

### 2. Hot sessions

A famous person livestreams their coding session and 5,000 people pile in. One session, one Redis shard, one app pod. The pod melts.

**Mitigations** (in order):
- **Read-only viewers go through a fanout layer, not direct WS to the app pod**. They subscribe to a per-session SSE feed served by a separate read-replica fleet. This converts O(viewers) to O(1) work on the writer pod.
- **Cap interactive participants at 100 per session.** Past that, you're in viewer mode. Discord-style.
- **Detect hot sessions** and migrate them to a dedicated pod with no co-tenants. Triggered by op rate > 100/sec or viewer count > 500.

### 3. Reconnection storms

A region's primary backend deployment rolls. 200,000 WSs reconnect within 30 seconds.

**Mitigations**:
- **Jittered backoff** in the client (250ms × 2^n × random(0.5, 1.5), capped at 10s)
- **LB connection-rate limit** per pod, with proper 503s that don't trigger immediate retries
- **Surge capacity**: HPA `minReplicas` set to 1.5× steady-state so survivors absorb the spike before scale-up lag kicks in
- **Drain on SIGTERM**: mark unready immediately, keep serving existing WSs for 60 seconds, then close — distributes reconnects over time

### 4. Cost

At 1M concurrent users, cloud bill estimates (rough order-of-magnitude):
- 250 backend pods × 1 vCPU × $0.04/hr × 730 hr/mo = **$7,300/mo**
- 36 Redis nodes × 4 vCPU × $0.20/hr × 730 = **$5,300/mo**
- Egress: 4M deliveries/sec × 100 bytes × 86,400 sec/day × 30 = ~1 PB/mo at $0.08/GB = **$80,000/mo** ⚠️
- AI calls: depends entirely on adoption — easily $50k-200k/mo

**The egress is the bill that surprises you.** Mitigations: edge-terminate WS at Cloudflare (egress at fraction of cloud-provider price), aggressive op batching client-side (combine ops within a 16ms tick), binary protocol (MessagePack saves ~40%).

## What you can't scale away

These will bite you and the answer is operational, not architectural:

- **A bug in `transform()` that causes 1-in-10,000 divergence**. At 1M users you have 100 broken sessions every minute. You need: deterministic replay tooling, golden test suites, canary deployment, and the ability to silently snapshot-and-resync any session that drifts.
- **A single client behaving badly** (fork-bomb the exec engine, spam the OT queue, hold a WS forever without sending heartbeats). You need: per-user rate limits, automatic disconnect on abuse, and audit logs.
- **The Postgres snapshot growing unboundedly**. Old sessions with no recent activity should be archived to S3 after 30 days, deleted after 90.

## TL;DR (the answer to the interview question)

> "Pin sessions to regions with geo-DNS. Within a region: stateless Node.js pods (250 of them at 5k WS each), behind sticky LBs, fanning out edits via Redis Cluster sharded 16 ways by sessionId. Snapshot to Postgres every 50 ops; primary in one region, read-replicas elsewhere. Execution and AI scale on independent host pools with their own quotas. The hard problems are cross-region collab (we don't do it — that's the price for using OT), hot sessions (separate viewer fleet, cap participants), reconnect storms (jitter + drain + surge capacity), and egress costs (edge-terminate at the CDN, batch + compress on the wire). If we needed offline support or true multi-region active-active, we'd switch from OT to CRDT and accept the per-op overhead."
