# ADR 0001: Stack and netcode model for M1

- Status: Accepted
- Date: 2026-11-18
- Owner: tech-lead

## Context
M1 is a browser battle royale with 1+ humans and bots (up to 16 players) on one island. It is played locally or
over a LAN in development. Five agents build the client and server in parallel, so the boundaries must be simple
and strict. Cheating matters (PvP), but bandwidth and latency budgets matter less than fast iteration at this stage.

## Decision
1. **Stack:** TypeScript (strict), Vite, Three.js, Node with `ws` run by `tsx`, Vitest, and Playwright. The project
   is a single npm package with relative imports. There is no physics engine. Movement and collision are a small
   custom layer in `src/shared/sim` (cylinders against simple prop colliders and a height function).
2. **Authoritative server.** One `World` (`src/shared/sim/World.ts`) runs on the server at 30 Hz. It owns movement,
   combat, inventory, loot, the zone, the match state machine, and bots. Clients only send inputs.
3. **Transport:** JSON text frames over one WebSocket at `/ws`. Messages are `join`/`input`/`ping` from the client
   and `welcome`/`snapshot`/`events`/`pong`/`error` from the server. Snapshots are full state at 20 Hz (loot only
   when it changes). Sim events are sent on the tick they happen.
4. **Client prediction for local movement only.** The client and server use the same pure `stepMovement`. The
   client reconciles on each snapshot by resetting to the server state and replaying unacknowledged inputs. Combat
   and inventory are not predicted.
5. **Remote interpolation** 100 ms behind the estimated server clock (ping/pong clock sync).
6. **Hitscan without lag compensation.** Rays test against targets' current server positions. Lag compensation is
   future work.
7. **Client module isolation.** Renderer, Ui, and AudioEngine depend only on `src/shared`. ClientGame is the only
   emitter on a typed `EventBus<GameEvents>` and produces `FrameView`/`HudView` each frame (see `src/shared/contracts.ts`).

## Consequences
- Cheating is limited to input manipulation. Speed and teleport hacks are impossible because the server moves the player.
- JSON costs about 4 KB per snapshot at 16 players, which is about 80 KB/s per client. That is fine for M1 and needs a
  binary/delta encoding before public internet play.
- Without lag compensation, players must lead targets by about 100 ms plus half the RTT. That is barely noticeable on
  LAN and will feel bad above about 80 ms RTT. It is the first netcode item after M1.
- Shot, damage, and reload feedback lags by about 1 RTT for the shooter.
- Sharing the sim makes it easy to unit test (headless, seeded) and keeps prediction exact. It also forbids DOM,
  Three.js, and nondeterminism in `src/shared/sim`.

## Alternatives considered
- **Colyseus:** it gives schema delta sync and rooms, but adds a framework and its own state model on top of our
  sim. We need only one room in M1. We can revisit it when we need matchmaking.
- **Rapier (WASM):** it gives robust physics, but WASM loading on the server and client, determinism concerns, and
  extra size are not justified for capsule-vs-cylinder movement on a heightfield.
- **Peer-to-peer / client-authoritative:** this is unacceptable for PvP.
- **Binary protocol now:** it is premature, because JSON is debuggable in devtools and the message types are
  isolated in `src/shared/protocol/`, so we can swap the encoding later.
- **Lag-compensated hitscan now:** it needs a server-side position history and a rewind per shot. We deferred it to
  keep M1 small.
