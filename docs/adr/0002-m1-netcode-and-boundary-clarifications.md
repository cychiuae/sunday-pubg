# ADR 0002: M1 netcode and boundary clarifications (after the Phase B review)

- Status: Accepted
- Date: 2026-11-18
- Owner: tech-lead
- Related: [ADR 0001](0001-stack-and-netcode.md), [ARCHITECTURE.md](../tech/ARCHITECTURE.md) §3, §6, §12,
  [REVIEW-M1.md](../tech/REVIEW-M1.md)

## Context
Phase B landed and the builders raised open questions. Each one is small, but each one changes how two or more
owners work, so they are recorded together here.

## Decisions
1. **No `firePressed` edge field in `PlayerInput` for M1.** `fire` stays a held field. The client latches clicks
   shorter than one tick (`InputState`): it sends `fire = true` for at least one input, and it inserts a one-tick gap
   for a release and re-press inside one tick. The sim detects semi-auto trigger edges from the previous `fire`.
   The protocol does not change and `PROTOCOL_VERSION` stays at 1. Revisit this only if playtests show lost
   semi-auto shots during the server's input-merge drain.
2. **`getInterpolated` clamps and never extrapolates.** When `renderTime` is past the newest snapshot, remotes
   freeze at that snapshot. Hitscan uses current server positions, so extrapolated remotes would make players aim
   at positions the server never had. The 100 ms delay covers normal jitter. Bounded extrapolation (at most one
   snapshot interval, using velocity) is an M2 option, and it must come with lag compensation.
3. **`LATENCY_MS` (server dev knob) means added round-trip time**, applied as half in each direction. That matches
   `INetClient.rttMs`, so a QA run with `LATENCY_MS=100` should show `rttMs` of about 100 plus the base RTT.
   Do not rename it.
4. **Bounded input repeat.** When a human's input queue is empty, the World repeats the last held input for at most
   `MAX_INPUT_REPEAT_TICKS` (constants.ts, 6 ticks = 200 ms). After that it uses neutral held fields (no move, no
   sprint, no fire) and keeps yaw/pitch. Without this cap, a hidden tab (rAF paused) keeps its player running and
   firing forever.
5. **`npm start` runs `node --import tsx server/index.ts`** (build-engineer). This makes one process with no tsx
   CLI wrapper, so SIGTERM and SIGINT reach `server/index.ts`, which closes sockets with code 1001 and exits within
   3 s. A bundled server build is M2 work.
6. **Test-only imports of map data.** `*.test.ts`, `src/shared/sim/testkit.ts` and `src/shared/sim/tools/**` may
   import `src/game/levels/` (pure data that imports only `src/shared/types`). Non-test sim code must never import
   it, because the World gets its map by injection. Tests that need specific geometry should build a small fixture
   map, or derive coordinates from the map (for example, `ISLAND.playerSpawns[0]`). Hard-coded island coordinates
   break when level-designer edits the map. Dev tools in `src/shared/sim/tools/` are exempt from the determinism
   rule (`Date.now` for wall-clock reports is fine), but no sim module may import them.
7. **Render may import `src/shared/sim/colliders.ts`** (read-only, for constants such as `DOCK_DECK_HEIGHT` and
   collider dimensions). Render must not import the World or movement. This removes mirrored constants such as
   `PropLayer.DOCK_DECK_HEIGHT_MIRROR`, which drift.
8. **Contract revision 1** (ARCHITECTURE.md §12) is additive: every new field is optional, so producers and
   consumers can land in any order. `actionFailed` joins the `SimEvent` union in the same change that teaches
   `simEvents.ts` and protocol `isSimEvent` about it.

## Consequences
- The protocol and `PROTOCOL_VERSION` stay unchanged. Old clients ignore the new optional fields.
- The client may still predict a few metres of movement that a starved server never applied. Reconciliation
  snaps or smooths it, as it does today.
- Consumers must handle the optional fields being absent until the producers ship them.

## Alternatives considered
- A `firePressed` edge flag: it is more robust under input merging, but it changes the protocol and the sim fire
  logic for a case nobody has observed yet.
- Extrapolating remotes for up to 250 ms: it reduces freezes under packet stalls, but it worsens hitscan fairness
  when there is no lag compensation.
- Neutral input as soon as the queue is empty: that causes stutter under normal jitter. A small repeat window is
  the standard compromise.
