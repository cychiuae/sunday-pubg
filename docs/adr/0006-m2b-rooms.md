# ADR 0006: M2b rooms: room browser, codes, waiting room, a new World per match, and the map vote in the room

- Status: Accepted
- Date: 2026-11-18
- Owner: tech-lead
- Related: [ADR 0005](0005-m2b-maps-indoor-office-and-carrier-drop.md) (maps, drop),
  [NETCODE.md "Rooms (M2b proposal)"](../tech/NETCODE.md) R1-R8 (network-engineer), [rooms.md](../design/systems/rooms.md)
  (game-designer), [UI.md §12](../ui/UI.md) (ui-ux-designer), [maps.md](../design/systems/maps.md) §1,
  [ARCHITECTURE.md](../tech/ARCHITECTURE.md) §15

## Context
M1 has one shared lobby per server process. The director asked for a room browser, private rooms with a code, a
waiting room with a host, and many rooms on one server. The map vote from maps.md now runs inside each room.

The network-engineer's proposal (R1-R8) and rooms.md disagree in two places: whether votes reset after a match, and
whether the map resolves at Start or at the lock. The director ruled on the open questions Q1-Q7 on 2026-11-18. This
ADR records the result.

Contract code:
- [`types.ts`](../../src/shared/types.ts): `RoomId`, `MemberId`, `RoomSettings`, `RoomSummary`, `RoomState`,
  `RoomMember`, `RejectCode`, `ROOM_CODE_ALPHABET`, `normalizeRoomCode`, `MapVoteOption`, `RoomMapMode`, `MapPickVia`
- [`contracts.ts`](../../src/shared/contracts.ts): `RoomsView` and friends, `ServerHello`, the `INetClient`,
  `NetHandlers`, `IClientGame` and `UiCallbacks` room methods, `CLIENT_TOKEN_STORAGE_KEY`
- [`events.ts`](../../src/shared/events.ts): the `room*` GameEvents and `mapVoteLocked`
- [`balance.ts`](../../src/shared/balance.ts): the `rooms` block

## Decision

### 1. Server shape: accept R1 and R6
- One process, one `RoomManager`, and up to `MAX_ROOMS` `GameRoom`s.
- The per-socket edge moves to `Session`.
- Each room keeps its own self-correcting tick timer. The event-loop delay monitor refuses `createRoom` with
  `server_busy` while p99 > 20 ms.
- A waiting room has no World, so it costs no CPU and sends no snapshots.

### 2. A new World per match (Q1: accepted), created at the map lock
Room lifecycle (rooms.md "States"):
```
waiting ──Start / all-ready / public timer──▶ countdown (room-owned; vote open)
countdown ──host Cancel or below the start minimum, before the lock──▶ waiting
countdown ──at lockAt = countdownEndsAt - match.mapVoteLockSeconds──▶ LOCK:
      resolve map (pin > fixed > vote > rotation), seed = mixSeed(roomSeed, matchSerial),
      runtime = cache[mapId] ?? prepareMap(map, balanceForMap(base, mapId)),
      world = createWorld({ map, balance, seed, botNames, runtime, timeOriginMs: roomNow,
                            matchStart: { countdownMs: lockSeconds x 1000, fillBots, matchId } }),
      addPlayer(each member) → welcome { playerId, mapId, matchId, roomId } to each member
World countdown (drop route already in MatchState) ──▶ playing ──▶ results ──▶ World reports `finished`
      ──▶ room drops the World ──▶ waiting (ready flags reset, votes persist, public timer restarts)
```
- **Why the World starts at the lock and not at Start.** rooms.md and maps.md keep the vote open until 3 s before
  the end of the countdown. The World needs its map at creation (colliders, zone, nav, route). Creating it at the
  lock means:
  - the map, route and welcome reach clients during the last 3 s, which hides the client's map build (ADR 0005 §5);
  - Cancel is a pure room operation, because there is no World to throw away.
- **Sim API additions** (game-developer). These replace the balance hacks in R1:
  - `WorldOptions.timeOriginMs?: number`: `timeMs = timeOriginMs + tick x SIM_DT x 1000`, so the room's server clock
    never jumps back.
  - `WorldOptions.matchStart?: { countdownMs: number; fillBots: boolean; matchId: number }`. When present, the World
    skips its lobby (ignores `match.minHumansToStart`) and enters `countdown` with `countdownMs` on its first step.
    It fills bots up to `match.targetPlayers` only when `fillBots`, and starts `MatchState.matchId` at `matchId`.
  - `WorldOptions.runtime?: MapRuntime` (ADR 0005 §6).
  - `World.finished: boolean`, true once results have ended.

  Without `matchStart`, the World behaves exactly as in M1 and M2a, so every existing test stays valid.
- **Cancel.** Only the host can cancel, and only before the lock (`bad_state` after it). Below the start minimum
  before the lock, the countdown cancels by itself. After the lock the match runs whatever happens; the World's own
  end rules apply.
- **Joins.**
  - During the countdown before the lock: a member, then a participant at the lock.
  - After the lock and before `playing`: `addPlayer` makes them a participant, so they start aboard (drop.md).
  - During `playing` or `results`: they spectate (`local = null`) and are a waiting member afterwards.

  Nobody drops into a running match.

### 3. Identity (Q2: accepted)
- Lobby messages and `RoomState` use a room-scoped **`memberId`**, stable while the member stays in the room.
- `welcome.playerId` is the World id of the current match and changes every match.
- `RoomMember.status` tells the UI who is in the match. ClientGame maps the local member to the local player
  through `welcome`.

### 4. Room rules (Q3 and Q4: rooms.md wins)
- **Fill with bots** is a host toggle, default on (`rooms.fillWithBotsDefault`).
- **Start minimum:** `rooms.minHumansToStartWithBots` (1) humans with fill on, `rooms.minHumansToStartWithoutBots`
  (2) with fill off. A refused Start gets `reject too_few_humans`.
- **Auto-start:**
  - all humans ready with at least `rooms.autoStartAllReadyMinHumans` (2) humans (the host counts as ready);
  - public rooms also run a `rooms.publicAutoStartSeconds` (60) timer once they have
    `rooms.publicAutoStartMinHumans` (2) humans.

  `RoomState.autoStart { reason, at }` shows it.
- **After a match:** votes persist, ready ticks reset, and the settings and host are kept. `random` is a vote
  option.
- **Map resolution** is one pure function in the sim (`src/shared/sim/mapVote.ts`, game-developer):
  `resolveMapChoice({ pin, mode, votes, maps, previous, rng }) → { mapId, via }`. The GameRoom calls it at the lock
  with the room's seeded RNG.
  - The `MAP` pin wins.
  - Then a fixed map from the room settings.
  - Then the vote: plurality, with ties broken at random. If `random` wins, the map is uniform over all maps.
  - With no votes, rotation per room. The first match in a new room is `island01`.

  It has the maps.md acceptance tests 1-4.
- **Host migration:** to the oldest remaining human (by `joinedAt`, ties by the lower `memberId`), in any phase.
- **Closing:** the room closes when its last human leaves, and any running World is discarded.

### 5. Kick and the rejoin block (Q6: client token, not IP)
- The client generates a random token once (128 bits, base64url), stores it in localStorage at
  `CLIENT_TOKEN_STORAGE_KEY` (`'bsp.clientToken.v1'`), and sends it in `hello.clientToken`.
- The server blocks a rejoin of the same room by the same token for `rooms.kickRejoinBlockSeconds` (120), and
  rejects it with `kicked`.
- **It never keys on IP**, because the whole office shares one IP. Clearing storage defeats the block. That is
  accepted: it is a cooldown, not security.
- A missing or malformed token (not 16-64 chars of `[A-Za-z0-9_-]`) is treated as a fresh anonymous token for that
  session.

### 6. Protocol: accept R3, R4 and R5, with these changes
- **`PROTOCOL_VERSION` is 3** (bumped at the C-gate, ADR 0005 §1). `hello` replaces `join`. A legacy `join` gets
  `error bad_version`.
- **`hello`:**
  - Client sends `{ t: 'hello', name, protocolVersion, clientToken?, caps? }`.
  - Server replies with `ServerHello` (`contracts.ts`): `maps`, `pinnedMap`, and `limits` taken from
    `balance.rooms` plus `MAX_ROOMS`.
- **Messages.** As R3: `listRooms`, `createRoom`, `joinRoom { roomId } | { code }`, `leaveRoom`, `setRoomSettings`,
  `startMatch`, `setReady`, `vote` and `kick`, plus **`cancelCountdown`** (host, before the lock). Server messages:
  `roomList`, `roomListDelta`, `roomJoined`, `room`, `roomLeft` and `reject`.
- **`RoomState` is the shape in `types.ts`.** It nests `settings: RoomSettings` and adds `lockAt`, `map { id, via }`,
  `autoStart`, `votes` (the tally) and `botSeats`. Each `members[]` entry carries its own `vote`.
  `RoomSummary` never carries the code.
- **Room names (Q5: agreed).** `name: null` means the client renders `room.create.name.default` with `hostName`.
  The server stores sanitised text, capped at `rooms.nameMaxLength`.
- **Codes:** `ROOM_CODE_ALPHABET` (28 symbols), length 5, from `crypto.randomInt`, with the 10-minute reuse cooldown.
  Every side parses codes with `normalizeRoomCode` in `types.ts`.
- **Rate limits and caps:** as R4, with these changes:
  - Failed code lookups are limited per IP (20 per minute). That is a brute-force guard, not identity, so a shared
    office IP is fine at that rate.
  - The create limit per IP is raised to 20 per minute, because a whole office shares one IP.
- **Room list:** sent only to subscribed browser sessions, batched every 500 ms into one shared `roomListDelta`.
  NetClient applies the deltas and hands ClientGame the full list (`onRoomList`).
- **Snapshots, events and the delta encoder** are unchanged and scoped to the room. On every `welcome`, NetClient
  resets the delta decoder and the snapshot buffer.

### 7. Client
- `INetClient` gains the room methods, and `NetHandlers` gains `onHello`, `onRoomList`, `onRoomJoined`, `onRoom`,
  `onRoomLeft` and `onReject` (all optional until the C-gate).
- ClientGame turns them into `HudView.rooms: RoomsView` (UI.md §12.10, adapted to `memberId`) and the room
  GameEvents.
- Ui calls the `UiCallbacks.on*Room*` intents. main.ts forwards them to the `IClientGame` methods of the same names.
- Screen selection (`title | connecting | connectionLost | browser | room | match | results`) is derived by Ui from
  `rooms.location`, `phase` and `local` (UI.md §12.1).
- **Deep links:**
  - `?room=CODE` is parsed with `normalizeRoomCode`; after name entry, the client sends `hello` and then
    `joinRoom { code }`.
  - `?map=<id>` sends a `vote` right after joining a vote room.

  Ui keeps `?room=` in sync with `history.replaceState`.

### 8. Env (Q7: accepted)
- `MAX_ROOMS` (8), `MAX_CONNECTIONS` (`MAX_ROOMS x match.maxPlayers + 32`), `MAP` (pin) and `SEED` live in
  `server/config.ts`.
- An invalid `MAP` logs one warning and is ignored (maps.md 1.4.1).
- build-engineer documents all of them in the README.
- The single process stays the deploy unit.

## Consequences
- The World stays a single-match object, so no sim code learns about rooms. Rooms are server and client code plus
  one pure vote function.
- The World id changes every match. Anything that remembers players across matches (rooms, rejoin) uses
  `memberId`.
- The welcome now marks every match start. NetClient must reset per welcome, and ClientGame must reset per-match
  state and possibly the map.
- The last 3 s of the countdown carry the map build. A slow client may show `RoomView.mapLoading` at the drop,
  which is acceptable.
- Kick blocking is weak by design.

## Alternatives considered
- **One persistent World per room with `setMap` (R8 Q1b).** Rejected. Colliders, zone, nav, loot and the RNG all
  depend on the map, so a deep reset path would duplicate construction.
- **Create the World at Start and resolve the map then (R4).** Rejected. It contradicts the vote-lock rule in
  maps.md and rooms.md, and makes Cancel discard a World.
- **Kick keyed on IP (R8 Q6).** Rejected by the director: the office shares one IP.
- **A shared tick scheduler for all rooms.** Rejected (R1). Separate timers spread the ticks out.
