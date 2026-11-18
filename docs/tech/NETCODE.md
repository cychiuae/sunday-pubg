# Netcode (M1)

Owner: network-engineer. Architecture and decisions: [ARCHITECTURE.md §5-6](ARCHITECTURE.md), [ADR 0001](../adr/0001-stack-and-netcode.md).
Code: `src/shared/protocol/messages.ts`, `server/`, `src/net/`.

## Authority model
- The server runs the only real `World` at 30 Hz. Clients send intent (`PlayerInput`, one per local 30 Hz step) and never results.
- The client predicts only its own movement (ClientGame, shared `stepMovement`), reconciling on `snapshot.local`
  (`lastProcessedInputSeq` + `movement`). Remote players are interpolated 100 ms behind the estimated server clock.
- No lag compensation in M1 (hitscan against current server positions). It is the first post-M1 item.

## Rates
| | Rate | Notes |
|---|---|---|
| Sim tick | 30 Hz | fixed-step accumulator on `performance.now()`; at most 4 catch-up ticks, then time is dropped (`droppedTicks` in `/healthz`) |
| Snapshots | 20 Hz per client | ticks where `floor(tick * 20 / 30)` changes |
| Events | per tick, batched | one `events` frame per tick that has events |
| Inputs | 30 Hz | server accepts at most 60/s per socket (token bucket); per-socket jitter buffer forwards **one input per tick** to the World |
| Ping | 1 Hz (+3 quick pings on connect) | max 5/s accepted |

## Messages (JSON text frames)
| Dir | `t` | Payload | Notes |
|---|---|---|---|
| C→S | `join` | `name`, `protocolVersion`, `caps?` | first and once; name ≤ 64 raw chars, sanitised to 1..16 code points; `caps` ≤ 8 strings of ≤ 16 chars, unknown ones ignored (`delta1` = delta snapshots) |
| C→S | `input` | `input: PlayerInput` | all fields required, numbers finite, `seq` safe int ≥ 1, `selectSlot ∈ {-1,0,1,2}`; unknown fields stripped |
| C→S | `ping` | `clientTime` | allowed before `join` |
| C→S | `resync` | | delta clients: "send the next snapshot in full"; max 1/s (burst 3), ignored before join or without `delta1` |
| S→C | `welcome` | `WelcomeInfo` | |
| S→C | `snapshot` | `WireSnapshot` | `delta1` clients: delta-encoded (below). Others (M1 format): full players, `loot` omitted when the socket already has `lootVersion` |
| S→C | `events` | `tick`, `serverTime`, `SimEvent[]` | public events are shared by every joined socket; private events (`actionFailed`) go only to their own player, in order, inside that player's frame (an opponent's `noAmmo` is an information leak). Unknown or malformed events are filtered by the client decoder and logged (rate-limited) by NetClient |
| S→C | `pong` | `clientTime`, `serverTime` | server now = `world.timeMs` + wall time since the last tick |
| S→C | `error` | `code` ∈ `bad_version`, `bad_name`, `full`, `bad_message` | the socket is closed (1008) right after |

### Optional fields (Contract revision 1, `PROTOCOL_VERSION` stays 1)
The decoder accepts each field when absent and checks its type when present; a mistyped value fails the same way a
mistyped required field does (the event is filtered; a bad loot entry fails the whole snapshot).

| Where | Field | Check |
|---|---|---|
| `LootState` | `tier?` | `common` / `rare` / `epic` |
| `damage` event | `armorBefore?` | finite number |
| `kill` event | `headshot?` | boolean |
| `actionFailed` event (new) | `playerId`, `action`, `reason` | int; `heal`/`pickup`/`reload`/`fire`; `noHeals`/`fullHp`/`inventoryFull`/`betterArmor`/`noAmmo` |

`weaponSwitched.pos` is a client-side GameEvent (ClientGame fills it from the interpolated position), not a wire field.
The validator table in `messages.ts` is keyed by `SimEventType` and the enum lists use `satisfies Record<Union, 1>`, so
a new event type or enum value in `types.ts` is a compile error until the decoder learns it, instead of a silent
client-side filter.

## Edge validation (server)
- Frames > 4096 chars, binary frames, non-JSON, unknown `t`, bad shapes: dropped and counted. More than 5 in 1 s → `error bad_message`, close.
  The ws layer hard-closes frames > 16 KB.
- Inputs: `seq` strictly increasing (replays/reorders dropped); move axes clamped to [-1,1] and the vector to length 1
  (only when longer than `1 + 1e-9`, so an already-normalised vector is not divided again and stays bit-identical to
  the client's);
  `pitch` clamped to ±80°; `yaw` wrapped; `dt` clamped to [0, SIM_DT]. Inputs before `join` are ignored.
- Names: NFC, whitespace collapsed, control/format/bidi/private-use chars stripped, trimmed, 1..16 code points.
- WebSocket upgrades must pass the Origin policy (below), else HTTP 403 (logged, rate-limited).
- Sockets that do not join within 15 s are closed. Max sockets = 2 × `match.maxPlayers` + 4; per-IP cap `MAX_CONNS_PER_IP`.
- Slow clients: snapshots skipped while the socket buffer is > 128 KB; closed at > 1 MB. Dead TCP: ws ping every 10 s.
- Every handler and `world.step` runs inside a guard: errors are logged (rate-limited), never crash the room.
- Disconnect → `world.removePlayer(id)`. Joining during playing/results → spectator (`local = null`) until the next lobby.

## Input jitter buffer (server)
The World consumes one input per player per step. If the Room forwarded every arrival immediately, a late burst
(network jitter, tab hitch) would leave a standing queue in the World that never drains, which adds latency permanently.
Instead each socket keeps its own queue (cap `MAX_QUEUED_INPUTS`) and forwards one input per tick. If the queue never
dropped below depth N during a 30-tick window, N inputs are merged away. Overflow merges the same way. A merge keeps the
newer input's held state (move, aim, sprint) and ORs `fire`/`jump`/`reload`/`interact`/`useHeal`, keeping `selectSlot`,
so a press is never lost. The client sees an ack jump of a few seqs and a sub-metre reconciliation that the visual
smoothing absorbs. Plain jitter (the queue empties regularly) never merges.

**Starvation (ADR 0002 §4).** The Room never synthesises or repeats inputs: with an empty queue it forwards nothing
that tick. The World alone repeats the last held input for at most `MAX_INPUT_REPEAT_TICKS` (6 ticks = 200 ms), then
uses neutral held fields (no move, sprint or fire; yaw/pitch kept). So a hidden tab stops after 200 ms, and there is
no second repeat layer at the edge. A standing-queue drain that moves the last queued input into `carry` leaves one
empty tick, which the World's repeat covers. `server/Room.test.ts` drives the real World through the Room to check
this end to end.

## Client (NetClient)
- Status: `connecting` → `connected` (socket open, join sent) → `joined` is signalled by `onWelcome`.
  Server `error` → status `error` with the code as reason. Drop after open → `disconnected`; failure before open → `error/connect_failed`.
  No automatic reconnect: UI offers Rejoin (`connect` again).
- Warnings (malformed frame, dropped event type, loot version gap, send failure) go through `LogLimiter`: the first
  one per kind is logged at once, then at most one per 5 s with the suppressed count, so a broken server cannot flood
  the console at 20-30 Hz.
- Clock: offset sample = `serverTime + rtt/2 - now`; the lowest-RTT of the last 5 is the target; the applied offset slews at
  ≤ 5% (monotonic `serverNow()`), snaps if off by > 250 ms. Welcome/snapshot times give a lower bound before the first pong.
- Interpolation buffer keeps 1 s. Positions/velY lerp, yaw/pitch shortest arc, discrete fields from the newer snapshot.
  Clamps at both ends (no extrapolation). A player moving > 8 m between two snapshots snaps (teleport/spawn).

## Snapshot deltas (`src/shared/protocol/delta.ts`)
Clients that join with `caps: ['delta1']` (NetClient, `server/testClient.ts`) get delta snapshots. Others get the M1
format, so a stale cached client keeps working and `PROTOCOL_VERSION` stays 1.

- **Base = the previous snapshot the server sent on this socket.** WebSocket runs over TCP, so frames arrive
  complete and in order; a sent frame is an implicit ack. Snapshots skipped for a slow socket are never sent, so they
  never become a base.
- **Players:** with `base: <tick>`, each `players` entry is `{ id }` plus only the fields that changed since that
  tick. Nested objects (`pos`, `anim`, `appearance`) are sent whole when any part changed. A complete entry
  (a new player) replaces. Membership is always complete: a missing id means the player is gone. Without `base`,
  entries are complete (join, resync).
- **Loot:** `loot` (full list), `lootDelta: { from, add, remove, qty }` against the client's `lootVersion` `from`,
  or neither (unchanged). `add` also replaces an entry in place (item, position or tier changed); `qty` holds
  `[id, qty]` for quantity-only changes. When the delta would be no smaller than the list (for example a new match
  regenerates all loot), the server sends the full list.
- **Exactness:** the server quantizes the snapshot (`quantizeDeep`, the same rounding as the wire, -0 → 0) before
  diffing, so its base holds exactly what the client decodes. The rebuilt players and loot equal the server's,
  including loot order (removals in place, additions appended, the order the World keeps). `server/Room.delta.test.ts`
  checks this on every snapshot of a full match and the next one with the real World.
- **Resync:** the client checks `base` against the tick it last applied and `lootDelta.from` against its
  `lootVersion` (and that omitted loot means its own version). On any mismatch, unknown id or invalid merged player,
  `SnapshotDeltaDecoder` drops the snapshot, forgets its state and NetClient sends `{ t: 'resync' }` (at most one per
  second while deltas keep failing; `resyncCount` counts them). The server resets that socket's encoder, so the next
  snapshot is full. Deltas already in flight are dropped by the client until it arrives.

## Bandwidth
Measured with `server/tools/bots.ts`, 6 headless clients plus sim bots (12 players), `LATENCY_MS=120 JITTER_MS=30`,
30 s, permessage-deflate on (server→client, context takeover, level 4):

| Format | JSON KB/s | Wire KB/s | Largest snapshot | Largest delta snapshot |
|---|---|---|---|---|
| M1 (full players, loot when changed) | 105.8 | 11.2 | 14.3 KB | n/a |
| `delta1` | 31.5 | 4.4 | 16.1 KB (match-start full loot list, once per match) | 2.8 KB |

Each client got 2 full snapshots in 30 s (join and match start) and no resyncs. The server tick also got cheaper:
16 delta clients average 0.96 ms per tick against 2.0 ms for the M1 format (less JSON to stringify). The target for
public play is < 10 KB/s per client. Next steps (ARCHITECTURE §13): interest management (nearby players and loot only,
which also removes the match-start loot peak) and a binary encoding.

## Environment (server)
| Var | Default | Meaning |
|---|---|---|
| `PORT` | 8797 | HTTP + WS port (`0` = random) |
| `HOST` | all interfaces | bind address |
| `NODE_ENV=production` | | serve `dist/` (MIME types, immutable `/assets/`, SPA fallback) |
| `DIST_DIR` | `dist` | static root in production |
| `BALANCE_OVERRIDE` | | inline JSON (`{...}`) or a path; deep-merged over balance.json (arrays replace), validated, fails fast |
| `LATENCY_MS` | 0 | added round-trip ms (half each direction), order preserved |
| `JITTER_MS` | 0 | extra random one-way delay per message (order preserved, like TCP) |
| `SEED` | random | World seed |
| `MAX_CONNS_PER_IP` | 32 | 0 = unlimited |
| `ALLOWED_ORIGINS` | production: `self`; dev: `*` | WebSocket Origin policy: comma list of `*`, `self` and exact origins (`https://play.example.com`). Invalid entries fail startup. See "Origin policy" |
| `TRUST_PROXY` | | `1` to use `X-Forwarded-For` for the per-IP cap and accept `X-Forwarded-Host` for `self` |

### Origin policy
Browsers always send `Origin` on a WebSocket upgrade, and pages cannot forge it. Without a check, any web page could
open game sockets from its visitors' browsers (a free bot farm that also burns the visitors' per-IP slots). It is not
authentication: non-browser clients can send any Origin, and every edge check above still applies to them.

| Entry | Accepts |
|---|---|
| `*` | anything, including no Origin (dev default) |
| `self` | Origin whose host:port equals the request `Host` (or `X-Forwarded-Host` with `TRUST_PROXY=1`); default ports are normalised, the scheme is not compared (TLS usually ends at the proxy) |
| `https://host[:port]` | that exact origin (normalised: lowercase host, default port dropped; no path) |

**Production default: `self`.** `npm start` serves the client and `/ws` from one origin, so nothing needs configuring.
A missing or `null` Origin is rejected unless `*` is set. Set an explicit list only when the client is served from
another origin (CDN or separate domain), e.g. `ALLOWED_ORIGINS=self,https://play.example.com`. `ALLOWED_ORIGINS=*` in
production logs a startup warning. Headless tools send the http(s) form of their WS URL as Origin by default
(`server/testClient.ts`), so `server/tools/bots.ts` passes `self`; use `--origin` for a listed origin.

`GET /healthz` returns `{ ok, connections, joined, tick, phase, matchId, avgTickMs, maxTickMs, droppedTicks, bytesOut }`.

## Testing under lag (QA)
```sh
# server with 120 ms RTT and 30 ms jitter, fast countdown, non-default port
PORT=8790 LATENCY_MS=120 JITTER_MS=30 BALANCE_OVERRIDE='{"match":{"countdownSeconds":3}}' npx tsx server/index.ts
# client against it (second terminal)
PORT=8790 npx vite --port 5180
# headless load: 8 bot clients for 30 s
npx tsx server/tools/bots.ts --url ws://127.0.0.1:8790/ws --clients 8 --seconds 30
```
Open several tabs on the Vite URL for multi-client manual tests. Packet loss is not simulated: on TCP, loss shows up as
latency spikes, which `JITTER_MS` approximates.

## Deploy requirements (build-engineer)
One Node ≥ 20.19 process: `npm run build && npm start`. One port serves the static client and `/ws`. Reverse proxies must
pass WebSocket upgrades on `/ws` (and allow idle sockets ≥ 30 s), and must forward the original `Host` header (nginx:
`proxy_set_header Host $host;`) or set `TRUST_PROXY=1` with `X-Forwarded-Host`, otherwise the default `self` origin
check rejects every browser. If the client is hosted elsewhere, set `ALLOWED_ORIGINS` to its origin. SIGTERM closes sockets (1001) and exits within 3 s.
Single room per process: scale by running more processes/ports.
