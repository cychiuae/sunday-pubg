# Netcode (M1, M2a, M2b)

Owner: network-engineer. Architecture and decisions: [ARCHITECTURE.md §5-6, §15.4](ARCHITECTURE.md),
[ADR 0001](../adr/0001-stack-and-netcode.md), [ADR 0006](../adr/0006-m2b-rooms.md) (rooms).
Code: `src/shared/protocol/messages.ts`, `server/` (`RoomManager.ts`, `GameRoom.ts`, `Session.ts`), `src/net/`.

**M2b in one paragraph.** A socket says `hello` (not `join`), lands in the room browser, and creates or joins a
room. Each room owns its own World per match, created at the map lock, and its own tick loop. Snapshots, events and
the delta encoder are unchanged but scoped to the room; every `welcome` starts a new World, so NetClient resets its
delta decoder and snapshot buffer. See "Rooms (M2b, implemented)" at the end. Where this file says "join" in the M1
sections below, read "the room's World adds the member" (at the lock, or on a mid-match join).

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
| C→S | `hello` (M2b) | `name`, `protocolVersion`, `clientToken?`, `caps?` | first and once; name ≤ 64 raw chars, sanitised to 1..16 code points; `caps` ≤ 8 strings of ≤ 16 chars, unknown ones ignored (`delta1` = delta snapshots); a token that is not 16-64 `[A-Za-z0-9_-]` makes the session anonymous (not an error). Replies `hello` (`ServerHello`) |
| C→S | `join` (legacy) | `name`, `protocolVersion`, `caps?` | M1/M2a handshake; still decoded only to answer `error bad_version` and close |
| C→S | lobby requests (M2b) | see "Rooms (M2b, implemented)" | `listRooms`, `createRoom`, `joinRoom`, `leaveRoom`, `setRoomSettings`, `startMatch`, `cancelCountdown`, `setReady`, `vote`, `kick` |
| C→S | `input` | `input: PlayerInput` | M1 fields required, numbers finite, `seq` safe int ≥ 1, `selectSlot ∈ {-1,0,1,2,3}`; M2a `ads` coerced (only `true` counts, absent = false), `stanceToggle` absent → `null`, anything but `'crouch'`/`'prone'`/`null` drops the frame as bad; unknown fields stripped |
| C→S | `ping` | `clientTime` | allowed before `hello` (the only other frame that is) |
| C→S | `resync` | | delta clients: "send the next snapshot in full"; max 1/s (burst 3), ignored outside a World or without `delta1` |
| S→C | `welcome` | `WelcomeInfo` (M2b: `roomId`) | at each match start (the lock) and on a mid-match join |
| S→C | `snapshot` | `WireSnapshot` | `delta1` clients: delta-encoded (below). Others (M1 format): full players, `loot` omitted when the socket already has `lootVersion`. `grenades` (M2a) is always the full list. `anim` is a bitmask on the wire (M2a, below) |
| S→C | `events` | `tick`, `serverTime`, `SimEvent[]` | public events are shared by every joined socket; private events (`actionFailed`) go only to their own player, in order, inside that player's frame (an opponent's `noAmmo` is an information leak). Unknown or malformed events are filtered by the client decoder and logged (rate-limited) by NetClient |
| S→C | `pong` | `clientTime`, `serverTime` | in a match: the room World's `timeMs` + wall time since its last tick; otherwise the shared server clock (each World continues it through `timeOriginMs`) |
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
(M2a removed `armorBefore`; see "M2a protocol".) The validator table in `messages.ts` is keyed by `SimEventType` and the enum lists use `satisfies Record<Union, 1>`, so
a new event type or enum value in `types.ts` is a compile error until the decoder learns it, instead of a silent
client-side filter.

## M2a protocol (`PROTOCOL_VERSION` 2, ADR 0004)
A v1 client gets `error bad_version` and is closed. There is no mixed-version play.

**Input.** `ads` is held: a non-boolean is coerced to `false` rather than dropping the frame, because a wrong held bit
is harmless and the next input corrects it. `stanceToggle` is an edge, and a bad value is treated like any other
malformed input (the frame is dropped and counts toward the bad-frame limit). `server/validate.ts` repeats both rules
and the `selectSlot` range before the World sees the input. Jitter-buffer merges keep the newer `ads` (held) and
the later non-null `stanceToggle` (an older request survives a null, like `selectSlot`).

**Snapshot validation** (`messages.ts`; every field table is keyed by the shared type, so a new field is a compile
error until it has a check):

| Where | Field | Check |
|---|---|---|
| `PlayerState` | `vestTier`, `helmetTier` | integer 0..3 (`armor` is gone) |
| | `stance`, `stanceFrom` | `stand` / `crouch` / `prone` |
| | `stanceProgress` | number in [0, 1] |
| | `weapon` | any `WeaponId` or `'grenade'` |
| | `anim.ads`, `anim.cooking` | boolean |
| `LocalPlayerState` | `vest`, `helmet` | `null` or `{ tier 1..3, durability > 0 }` |
| | `grenades` | integer ≥ 0 |
| | `cookExplodesAt` | number or `null` |
| | `throwRecoveryMs` | number ≥ 0 |
| | `ammo` | includes `ammo_sniper` |
| | `movement` | adds `stance`, `stanceFrom`, `stanceMs ≥ 0`, `adsMs ≥ 0` |
| | `activeSlot` | 0..3 |
| `LootState` | `item`, `durability?` | any `ItemId` (`vest` is gone); durability > 0 when present |
| `WorldSnapshot` | `grenades` | required list of `{ id, ownerId, pos, vel, explodesAt, inWater }` |

**Events.** `damage` carries `vest`/`helmet` (`null` or `{ tier 1..3, absorbed ≥ 0, broken }`) and an optional
integer `grenadeId`. `armorAfter`/`armorBefore` are gone. `cause` adds `explosion`. `kill.weapon` and
`weaponSwitch.weapon` may be `'grenade'`, and `weaponSwitch.slot` may be 3. `pickup.durability?` is a number. The new
events are `stanceChange`, `grenadeCook`, `grenadeThrown`, `grenadeBounce` (surface `terrain`/`prop`/`water`/`edge`)
and `explosion`. All of them are public. `actionFailed` adds the actions `swap`/`stance` and the reasons
`noGrenades`/`tooDeep`/`noHeadroom`, and it stays private.

**`anim` bitmask on the wire.** `encodeQuantized` (server frames) packs each `PlayerState.anim` into an integer:
bit i is set when `ANIM_BITS[i]` is true. The order is `moving, sprinting, airborne, dropping, inWater, firing,
reloading, healing, ads, cooking`. `decodeServerMessage` expands it back before validation, and it also accepts the
object form. A mask outside `[0, 2^10)` fails the snapshot. The 10 booleans cost about 175 B of JSON per player, and
the mask costs 1-4 B. This saving is what keeps a full 16-player snapshot under the 8 KB budget once the M2a fields
and grenades are added. In-memory types do not change, and the delta base still compares objects. The bit order is
protocol: append only, and bump the version.

**Grenades on the wire: full list in every snapshot (not delta-encoded).** They are few (usually 0-3, never more
than about 10), short-lived (fuse ≤ 4 s), and almost always moving. In flight, every field but `id`/`ownerId`/
`explodesAt` changes each snapshot, so a delta would save little. A grenade costs about 145 B of JSON after
quantisation, and permessage-deflate removes most of the repeated key names. A full list also makes a grenade's
disappearance implicit (absent = exploded or removed), with no remove bookkeeping and no resync risk. ClientGame
re-anchors its extrapolation on every list. If the measured bandwidth ever needs it, the next step is to omit
resting grenades whose state is unchanged since the base.

**Remote stance.** `getInterpolated` lerps `stanceProgress` only while both bracketing snapshots show the same
transition (same `stance` and `stanceFrom`, with progress not going backwards). Otherwise it takes the newer value,
so a remote never blends two different transitions. NetClient does not interpolate or touch grenades:
`latestSnapshot().grenades` is the list as received.

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
- Interpolation buffer keeps 1 s. Positions/velY lerp, yaw/pitch shortest arc, discrete fields from the newer snapshot,
  and (M2a) `stanceProgress` lerps within one transition.
  Clamps at both ends (no extrapolation). A player moving > 8 m between two snapshots snaps (teleport/spawn).

## Snapshot deltas (`src/shared/protocol/delta.ts`)
Clients that join with `caps: ['delta1']` (NetClient, `server/testClient.ts`) get delta snapshots. Others get the M1
format (full players every snapshot). The capability is kept for tools and tests. Version gating is
`PROTOCOL_VERSION` (2 since M2a).

- **Base = the previous snapshot the server sent on this socket.** WebSocket runs over TCP, so frames arrive
  complete and in order; a sent frame is an implicit ack. Snapshots skipped for a slow socket are never sent, so they
  never become a base.
- **Players:** with `base: <tick>`, each `players` entry is `{ id }` plus only the fields that changed since that
  tick. Nested objects (`pos`, `anim`, `appearance`) are sent whole when any part changed (`anim` as its bitmask).
  M2a fields work the same way. A settled player with unchanged armor costs nothing, and during a stance transition
  `stanceProgress` (and on its first snapshot `stance`/`stanceFrom`) is added to the patch.
- **Grenades** are not delta-encoded (full list, see "M2a protocol"). **`local`** is always sent whole. A complete entry
  (a new player) replaces. Membership is always complete: a missing id means the player is gone. Without `base`,
  entries are complete (join, resync).
- **Loot:** `loot` (full list), `lootDelta: { from, add, remove, qty }` against the client's `lootVersion` `from`,
  or neither (unchanged). `add` also replaces an entry in place (item, position, tier or M2a `durability` changed); `qty` holds
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
public play is < 10 KB/s per client.

**M2a (PROTOCOL_VERSION 2, anim bitmask), same method** (6 clients, 12 players, 120 ms RTT, 30 ms jitter, 30 s):
`delta1` 31.8 KB/s JSON, **4.2 KB/s wire**, largest delta snapshot 2.0 KB, 2 full snapshots per client, no resyncs,
RTT p50 150 ms, input-ack p50 200 ms. The anim bitmask saves more than the new stance, armor and ADS fields cost.

**Whole match with grenades** (`npx tsx server/tools/measure-snapshot.ts`: offline, real World, 16 players, one
delta client, wire estimated with the server's deflate settings):

| Scenario | Snapshots, JSON | Snapshots, wire | Total wire incl. events | Largest delta | Busiest full snapshot without loot |
|---|---|---|---|---|---|
| No grenades (seeds 7 / 11 / 23) | 30.1-31.4 KB/s | 3.0-3.3 KB/s | 3.3-3.6 KB/s | 2.1-2.5 KB | 5.9 KB |
| 3 grenades always live (`--synthetic-grenades 3`) | 38.1 KB/s | 4.1 KB/s | 4.7 KB/s | 2.8 KB | 6.3 KB |
| 10 grenades always live (`--synthetic-grenades 10`) | 57.7 KB/s | 6.4 KB/s | 7.3 KB/s | 3.8 KB | 7.3 KB |

The bots in this build threw no grenades in three seeded matches, so the grenade rows overlay synthetic ballistic
grenades (with their `grenadeThrown` and `explosion` events) on the real match. Ten grenades that are always live is
far beyond real play. The worst case built by `src/shared/protocol/m2a.test.ts` (16 players, all prone mid-transition,
ADS, armored, long names, 10 grenades, full format) is 7,840 B, under the 8 KB budget. Without the anim bitmask it
would be 10.3 KB.

Next steps (ARCHITECTURE §13): interest management (nearby players and loot only,
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
| `SEED` | random | M2b: room seeds become `mixSeed(SEED, roomSerial)` and each match's World seed `mixSeed(roomSeed, matchSerial)`, so a run is reproducible |
| `MAX_ROOMS` (M2b) | 8 | concurrent rooms; over it `createRoom` gets `reject max_rooms` |
| `MAX_CONNECTIONS` (M2b) | `MAX_ROOMS × match.maxPlayers + 32` | sockets per process (joined or not); over it the socket closes with 1013 |
| `MAP` (M2b) | | a level id pins every room's map (votes disabled, `RoomState.pinnedMap`); an invalid value logs one warning and is ignored (maps.md 1.4.1) |
| `MAX_CONNS_PER_IP` | 128 | 0 = unlimited. M2b (director): raised from 32 because the players are an office behind one NAT IP; 128 covers 8 full rooms plus browser tabs |
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

`GET /healthz` (M2b) returns `{ ok, rooms, connections, browser, listSubscribers, loopDelayP99Ms, loopDelayMaxMs,
perRoom: [{ id, phase, humans, visibility, matchId, mapId, tick, avgTickMs, maxTickMs, matchAvgTickMs,
matchMaxTickMs, ticks, droppedTicks, bytesOut }] }`. The loop delay comes from `perf_hooks.monitorEventLoopDelay`
(10 ms resolution, reported minus the resolution, so 0 = no delay) over 10 s windows; the value is the larger of the
current and the previous window. Tick times include the World step, inputs, and snapshot and event encoding.

## Testing under lag (QA)
```sh
# server with 120 ms RTT and 30 ms jitter, fast countdown, non-default port
PORT=8790 LATENCY_MS=120 JITTER_MS=30 BALANCE_OVERRIDE='{"match":{"countdownSeconds":3}}' npx tsx server/index.ts
# client against it (second terminal)
PORT=8790 npx vite --port 5180
# headless load: 8 bot clients in one room for 30 s (the first creates the room and presses Start every match)
npx tsx server/tools/bots.ts --url ws://127.0.0.1:8790/ws --clients 8 --seconds 30
# M2b: 64 clients over 8 public rooms (fits the default MAX_CONNS_PER_IP of 128), office only
npx tsx server/tools/bots.ts --url ws://127.0.0.1:8790/ws --rooms 8 --clients 64 --seconds 60 --map office
# M2b: three headless clients join a room you created in the browser (its code), without pressing Start
npx tsx server/tools/bots.ts --url ws://127.0.0.1:8790/ws --code BCD23 --clients 3 --no-start
```
Open several tabs on the Vite URL for multi-client manual tests (each tab is a separate browser identity only if its
`localStorage` differs: use separate browser profiles or a private window to test kick and rejoin). `bots.ts` ends
with the server's `/healthz` per-room tick times and loop delay. Use ports 8800-8999 for QA servers. Packet loss is not simulated: on TCP, loss shows up as
latency spikes, which `JITTER_MS` approximates.

## Deploy requirements (build-engineer)
One Node ≥ 20.19 process: `npm run build && npm start`. One port serves the static client and `/ws`. Reverse proxies must
pass WebSocket upgrades on `/ws` (and allow idle sockets ≥ 30 s), and must forward the original `Host` header (nginx:
`proxy_set_header Host $host;`) or set `TRUST_PROXY=1` with `X-Forwarded-Host`, otherwise the default `self` origin
check rejects every browser. If the client is hosted elsewhere, set `ALLOWED_ORIGINS` to its origin. SIGTERM sends `roomLeft closed` to every room member, closes sockets (1001) and exits within 3 s.
M2b: one process hosts up to `MAX_ROOMS` rooms (each with its own tick timer); the process stays the deploy unit. CPU
planning figure: about 1.3 ms per tick per busy room (8 humans + bots), so 8 rooms use about 30% of one core (see
"Rooms: load"). The process needs no sticky routing until there is more than one. New env vars: `MAX_ROOMS`,
`MAX_CONNECTIONS`, `MAP` (and `SEED` now seeds rooms). Startup fails fast if an indoor level fails
`validateIndoorMap` or a level id has no `maps.<id>` balance entry.

## Rooms (M2b, implemented)
Decisions: [ADR 0006](../adr/0006-m2b-rooms.md) (it amended the R1-R8 proposal that used to be here: votes persist,
the World is created at the map lock, kick keys on a client token, `cancelCountdown`, `too_few_humans`). Rules:
[rooms.md](../design/systems/rooms.md), map vote: [maps.md](../design/systems/maps.md) §1.

### Server shape
- `RoomManager` (one per process): sessions, the room table and codes, the room list, `MAX_ROOMS` /
  `MAX_CONNECTIONS`, per-IP guards, the prepared-map cache (`balanceForMap` + `prepareMap`, once per map id), the
  event-loop monitor, and the hello / lobby dispatch. A 100 ms housekeeping poll runs room timers, coalesced room
  broadcasts and the list flush.
- `Session` (one per socket): decoding, bad-frame counter, rate limiters, simulated lag, the 15 s hello timeout,
  name / client token / caps, and where the socket is (`new` → `browser` → `room`).
- `GameRoom`: members (`memberId`, room-scoped), host, settings, ready flags, votes, the kick blocks, the room-owned
  countdown and lock, and during a match one World with its own self-correcting 30 Hz timer, the per-member input
  jitter buffer, and the snapshot / event broadcast (the M1 `Room` match path, unchanged in behaviour). A waiting
  room has no World and costs nothing per tick.
- `server/common.ts` holds the shared server types, `EDGE`, `CLOSE`, `Logger` and `SILENT_LOGGER` (the M1
  `server/Room.ts` is gone).

### Lifecycle (ADR 0006 §2)
```
waiting --host Start | all ready (>= 2 humans) | public timer (60 s at >= 2 humans)--> countdown (no World, votes open)
countdown --host cancelCountdown, or below the start minimum, before lockAt--> waiting
countdown --lockAt = countdownEndsAt - mapVoteLockSeconds--> LOCK:
    resolveMapChoice({ pin, mode, votes, maps, previous, rng: room Rng }) -> balanceForMap -> cached prepareMap
    createWorld({ ..., seed: mixSeed(roomSeed, ++matchSerial), runtime, timeOriginMs: serverNow,
                  matchStart: { countdownMs: countdownEndsAt - now, fillBots, matchId: matchSerial } })
    addPlayer(each member) -> welcome { playerId, mapId, matchId, roomId, serverTime }
World countdown -> playing -> results -> World.finished -> the room drops the World -> waiting
    (ready flags reset, votes, settings and host kept, public timer restarts)
```
Room `phase` follows the World (`countdown` / `playing` / `results`). Joins: before the lock a plain member; after
the lock and before `playing` a participant (`addPlayer`, starts aboard); during `playing` / `results` a spectator
(`addPlayer` queues them, their snapshots have `local = null`), a waiting member after results. Host migration on any
leave: oldest `joinedAt`, ties by lower `memberId`. The last member leaving closes the room and discards its World.
Votes are accepted in any phase while the room is in vote mode and unpinned; after the lock they count for the next
match. The host has no ready tick (always `false`, counts as ready).

### Messages
Every lobby request may carry `rid` (safe integer 0..2^31), echoed in `reject` and `roomJoined`. Other successes show
up as the next `room` update.

| Dir | `t` | Payload | Rules / reject codes |
|---|---|---|---|
| C→S | `listRooms` | `subscribe` | browser only (`already_in_room`); `true`: `roomList` now, then shared `roomListDelta`s; entering a room unsubscribes |
| C→S | `createRoom` | `settings: Partial<RoomSettingsInput>` | browser only; missing keys take the `rooms` defaults; `bad_settings`, `max_rooms`, `server_busy` (loop p99 > 20 ms or no free code), `rate_limited` |
| C→S | `joinRoom` | exactly one of `roomId`, `code` | browser only; codes go through `normalizeRoomCode`: `bad_code`, `room_not_found`, `room_full` (every member counts, spectators too), `kicked` |
| C→S | `leaveRoom` | | `not_in_room`; reply `roomLeft left` |
| C→S | `setRoomSettings` | partial settings | host, waiting only: `not_host`, `bad_state`, `bad_settings` (map not in `hello.maps`, `maxHumans` outside `rooms.minMaxHumans..maxMaxHumans` or below the member count); names are sanitised and truncated to `rooms.nameMaxLength`, empty → `null` |
| C→S | `startMatch` | | host, waiting only; `too_few_humans` below `rooms.minHumansToStartWith(out)Bots` |
| C→S | `cancelCountdown` | | host, countdown before the lock (`bad_state` after it) |
| C→S | `setReady` | `ready` | waiting only (`bad_state`); a no-op for the host |
| C→S | `vote` | `choice: MapId \| 'random' \| null` | vote mode and no pin, else `bad_state`; unknown map `bad_settings` |
| C→S | `kick` | `memberId` | host; not self / unknown member `bad_state`; the target gets `roomLeft kicked` and its client token is blocked from that room for `rooms.kickRejoinBlockSeconds` |
| S→C | `hello` | `hello: ServerHello` | `maps`, `pinnedMap`, `limits` (`maxRooms` + the `rooms` balance) |
| S→C | `roomList` | `rev`, `rooms: RoomSummary[]` | the list as published at `rev` |
| S→C | `roomListDelta` | `from`, `rev`, `upsert`, `remove` | batched every 500 ms, encoded once, sent to subscribed browser sessions only; public rooms only (never the code). A client at another `rev` re-subscribes |
| S→C | `roomJoined` | `rid?`, `room: RoomState`, `memberId` | |
| S→C | `room` | `room: RoomState` | on change, at most 5/s per room (phase changes and the lock go out at once) |
| S→C | `roomLeft` | `reason` ∈ `left`, `kicked`, `closed` | `closed` = server shutdown |
| S→C | `reject` | `rid?`, `req` (the request's `t`), `code: RejectCode`, `retryAfterMs?` | non-fatal |

`input` and `resync` outside a World are ignored (a stale input right after a match is not a bad frame). Before
`hello`, anything but `hello` and `ping` is a bad frame.

**Rate limits** (token buckets per session; per IP where noted; over the limit: `reject rate_limited` with
`retryAfterMs`): `createRoom` 1 per 10 s, burst 2, plus 20 per minute per IP; `joinRoom` and `leaveRoom` 2/s, burst 5;
failed code lookups (bad or unknown code) 20 per minute per IP (a brute-force guard: 28^5 codes, so a guess hits
about 1 in 2 million with 8 rooms); `listRooms` 2/s, burst 4; `setRoomSettings` 4/s, burst 8; `setReady` and `vote`
4/s, burst 8; `startMatch` and `cancelCountdown` 1/s, burst 2; `kick` 2/s, burst 4. Identity is never an IP: the kick
block keys on the client token (ADR 0006 §5), which a cleared `localStorage` defeats (a cooldown, not security).

**Codes:** 5 characters of `ROOM_CODE_ALPHABET` from `crypto.randomInt`; never the code of an open room or of one
closed in the last 10 minutes; 20 tries, then `server_busy`. Room ids are `r` + a counter, never reused.

### NetClient
`connect(url, name)` sends `hello` with the token from `localStorage[CLIENT_TOKEN_STORAGE_KEY]` (created: 16 random
bytes, base64url; storage failures fall back to an unsaved token). Room methods send their requests with fresh rids;
requests made while connecting are queued behind the hello (the `?room=CODE` deep link). It applies list deltas and
hands the full list to `onRoomList`, re-subscribing on a `rev` gap and after leaving a room if the list was open. On
every `welcome` and on `roomLeft` it resets the delta decoder and the snapshot buffer.

### M2b snapshot fields and the wire budget
At the C-gate the snapshot gains `PlayerState.aboard` / `dropPhase`, `MovementState.dropPhase` / `dropMs`,
`LocalPlayerState.aboard` and `MatchState.mapId` / `route` / `aboardCount`, plus the `dropJump` and `chuteOpen`
events and `'glass'` impact and bounce surfaces. The tables in `messages.ts` validate them;
`M2B_FIELDS_REQUIRED` is true since the C-gate (`PROTOCOL_VERSION` 3; a test pins the pair), so they are required
(apart from the route in delta snapshots, which the decoder carries forward). The route is
checked for finite numbers and `startsAt <= noJumpUntil <= ejectAt <= endsAt`.

They would have pushed the worst-case full snapshot (`m2a.test.ts`: 16 players mid-transition, 10 grenades, long
names) from 7,840 B to about 8.7 KB, over the 8 KB budget. Three compactions keep it inside without relaxing the
budget:
1. Full-format players omit `aboard: false` and `dropPhase: null` (the decoder restores them; patches still carry a
   change back to the resting value).
2. `local` omits `aboard: false`, `movement.dropPhase: null` and `movement.dropMs: 0` in every snapshot.
3. Delta snapshots omit `match.route` while it equals the base's route (it is fixed per World); the delta decoder
   carries it forward, so it rides once per match per client.

Result: **8,134 B** for the worst case including a realistic route (budget 8,192; 58 B of headroom, so the next
snapshot field needs another saving: the obvious ones are route times as integers or interest management).

### Tests
- `server/rooms.test.ts` (fake sockets, fake clock, scripted World): hello and the edge, create / join by id and
  code, private rooms never listed, list deltas only to browser subscribers, a property test rebuilding the list from
  `roomList` + deltas after every flush, `room_full` / `max_rooms` / `server_busy` / `rate_limited` / `not_host`,
  code cooldown, host migration in waiting / countdown / mid-match, kick and the token block, Start / cancel / start
  minimum, all-ready and public-timer auto-start, the vote lock (map from votes, `matchStart`, `timeOriginMs`, welcome
  with `roomId`), rotation per room, the `MAP` pin, mid-match spectators, the return to the waiting room, and the M1
  match-path tests (jitter buffer, private events, slow clients, the fixed-step loop, lag).
- `server/rooms.world.test.ts` (real World, fake clock): two rooms on different maps play two matches each; every
  rebuilt snapshot equals its own room's World state (no cross-room leak), zero resyncs across World swaps, a mid-match
  joiner spectates then plays the next match; the carrier route on island01 and office rides once per match.
- `server/server.integration.test.ts` (real ws, no lag and 100 ms RTT + 20 ms jitter): 3 rooms × 3 clients play at
  once, the list subscriber sees the public rooms play and never the private one, bad and unknown codes, the deep
  link, the legacy `join`, `/healthz`, and shutdown (`roomLeft closed`, 1001). Every wait has its own timeout inside
  the test's timeout (BUG-006).
- `src/net/NetClient.test.ts`, `src/shared/protocol/m2b.test.ts`: the client side and every decoder.

### Rooms: load (2026-11-18)
`LATENCY_MS=120 JITTER_MS=30 SEED=42 MAX_CONNS_PER_IP=0`, `bots.ts --rooms 8 --clients 64 --seconds 60` (8 humans
per room plus sim bots, vote maps, carrier drop), bots and server on the same machine:

| Event loop p99 / max | Tick avg per room | Tick max | Dropped ticks | Wire per client | JSON per client |
|---|---|---|---|---|---|
| 9.7 ms / 25 ms | 1.19-1.34 ms | 6.8-31 ms | 0 | 3.8 KB/s | 32 KB/s |

Office only (`--rooms 2 --clients 6 --map office`): RTT p50 155 ms, input ack p50 200 ms, largest delta 2.0 KB,
wire 3.1 KB/s, tick avg 0.95 ms. Targets met (p99 < 10 ms, tick < 2.5 ms, no dropped ticks, wire unchanged from M2a).
The worst ticks (about 30 ms) are single match-start ticks; they are absorbed by the catch-up loop.
