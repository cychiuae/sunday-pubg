# Code review: M2b "Office, Drop & Rooms" (Phase D2) and the C-gate

Reviewer: tech-lead. Date: 2026-11-18. Scope: the Phase C deliverables against
[ADR 0005](../adr/0005-m2b-maps-indoor-office-and-carrier-drop.md), [ADR 0006](../adr/0006-m2b-rooms.md) and
[ARCHITECTURE.md](ARCHITECTURE.md) §15, plus the C-gate flip. Line numbers are as of this review. Builders were still
editing during the review, so some line numbers may drift.

## C-gate (done in this pass)
| Item | Done |
|---|---|
| `MapData = AnyMapData`; `kind` and `carrier` required | `types.ts` |
| Field blocks merged with `extends`: `MovementState` ← `DropMovementFields`, `MovementStepResult` ← `DropStepFields`, `PlayerState` ← `PlayerDropFields`, `LocalPlayerState` ← `LocalDropFields`, `MatchState` ← `MatchMapFields`; `SimEvent \| DropSimEvent`; `WelcomeInfo.roomId` required | `types.ts` |
| `ImpactSurface` and `GrenadeContactSurface` `\| 'glass'`; `Surface \| FloorMaterial` | `types.ts` |
| `CameraView.view/subjectId/roll`, `FrameView.viewmodel/reducedMotion`, `HudView.rooms/drop/zoneTheme/cameraView/cameraFovDeg`, `spectate.view`, `HudMinimapView.route` required; room methods required on `INetClient` and `IClientGame` (`NetHandlers` hooks stay optional for test doubles) | `contracts.ts` |
| Required balance: `maps` (base only; a merged balance has none), `rooms`, `bots.nav`, `match.mapVoteLockSeconds`, `zone.indoorCenterInset`, `movement.stances.pronePitchMin/MaxDeg`. The FP keys and `fpRecoil` are in `ClientFeelBalance`. `adsCameraDistance` and `adsCameraShoulderOffset` are removed. `match.dropHeight` and `spawnJitter` are optional | `balance.ts` |
| `PROTOCOL_VERSION = 3`; `M2B_FIELDS_REQUIRED = true` (network-engineer's file, flipped on request; a test pins the pair) | `constants.ts`, `protocol/messages.ts` |
| main.ts: `defaultRoomName`, all ten room `UiCallbacks` forwarded, `balance` passed to `AudioEngine`, `audio.setGrenades` after `setListener`, the initial map typed as the union | `src/main.ts` |

**After the gate:** `tsc` has 16 errors and `vitest` has 8 failing tests, all in other owners' files. They are listed
in the residue table below. My own files (`src/shared/*`, `main.ts`) are clean, and `balance.test.ts` and
`maps.test.ts` pass.

### Residue per owner
| Owner | File:line | Error | Fix |
|---|---|---|---|
| game-developer (sim core) | `sim/World.ts:534`, `:536`; `sim/World.test.ts:97` | `match.dropHeight` is now optional | The drop-less test World reads it with a fail-fast check (throw if absent when `drop: false`) |
| game-developer (sim core) | `sim/movement.test.ts:28,66,174,186` | `MovementState` literals lack `dropPhase` and `dropMs` | Use `initialMovementState` or add the two fields |
| game-developer (sim core) | `sim/World.ts:122-123,363,367,1257,1274,1327` | not errors, but now-redundant `& MatchMapFields` / `& PlayerDropFields` intersections and the movement cast | Drop them |
| game-developer (client) | `game/testFixtures.ts:212` | welcome fixture with optional `roomId` | Make `roomId` required in the fixture |
| game-developer (client) | `game/drop.ts:36-42` | not errors, but `Partial<…Fields>` casts are now redundant | Read the fields directly |
| network-engineer | `net/NetClient.test.ts:113,126`; `protocol/messages.test.ts:125` (tsc and runtime); `protocol/m2b.test.ts` "…fails the shape check only before the gate allows it" | welcome fixtures lack `roomId`; one test asserts pre-gate behaviour | Add `roomId`; invert or remove the pre-gate test |
| network-engineer | `server/config.ts:58` `levelById` | known residue | Return `MapData` from `getMap` |
| graphics-engineer | `render/cameraRig.test.ts:6`, `render/m2b.test.ts:41`, `render/viewmodelAnim.test.ts:338` | `CameraView` and `FrameView` fixtures lack `view`, `subjectId`, `roll` and `reducedMotion` | Fill the fixtures |
| qa-tester | `tests/sim/m2a-acceptance.test.ts:21`, `tests/sim/m2a-edge.test.ts:24` | map fixtures spread to `Partial`, losing `kind` | Build the fixture as `IslandMapData` with `kind: 'island'` and `carrier` |
| qa-tester | `tests/integration/pvp-over-ws.test.ts` (2 failing), e2e observer | still send `join` (v2) | Use `testClient` `quickPlay()` |
| qa-tester | `tests/render/prone-hitbox-match.test.ts` (2), `tests/sim/m2a-edge.test.ts` BUG-010 (2) | `it.fails` now pass (BUG-008 and BUG-010 fixed) | Turn them into plain `it` and close the bugs |

## Boundary and determinism checks (grep, all pass)
| Check | Result |
|---|---|
| Sim imports only `src/shared/*.ts` and `sim/` (no kits, no render) | Pass |
| `Math.random`, `Date.now`, `performance.now` in sim | None |
| render, ui and audio do not import `src/game`, `src/net` or each other | Pass |
| `BALANCE` outside composition roots | `navTestkit.ts` (test kit, allowed), `matchReport.ts` (tool). Audio's fallback is gone (`AudioDirector.ts:98`) |
| REVIEW-M2a follow-ups | M1 fixed (`sim/actions.ts`; `actionPrediction.ts` is down to 172 lines), M2 fixed (`predictGrenadeArc` `out` buffer), M3 fixed (timed `solveThrowPitch` test), M5 fixed (`main.ts` and audio), M7 fixed (`dangerMargin` read, with a default), L5 fixed (`validate.ts` imports `MAX_MOVE_INPUT_LEN`) |

## Jump physics change (sim core): trapezoid integration, apex 1.056
`movement.ts:314,357,437-446`: on gravity ticks, `py += (vyStart + vyEnd) / 2 · dt`, and the landing speed is
`sqrt(vyStart² + 2g·Δh)`, capped at terminal velocity. Drop phases keep constant-speed Euler (`vyStart === null`).
- **Correct.** With constant gravity, the trapezoid rule is exact at tick boundaries. Apex = v²/2g =
  6.5² / 40 = 1.05625 m. The highest sampled tick is at t = 1/3 s: 6.5 · 0.333 − 10 · 0.111 = 1.0556 m, so the
  0.945 m step has 0.11 m of margin, as maps.md 2.4 assumes. maps.md 17b passes (`indoor.test.ts:182`, 50 trials).
  The jump tick integrates gravity too, so the first-tick displacement is exactly v0·dt − g·dt²/2.
- **Determinism and prediction:** one shared step; no new state; reconciliation is unaffected.
- **Side effect (expected):** every jump is about 0.1 m higher than the M1 explicit-Euler jump, on the island too.
  See L4.
- Findings: L2 (landing speed while rising) and L3 (loose apex test) below.

## Findings, ranked

### Medium
**M1. Required balance blocks still have hard-coded default copies in the sim.** Owner: game-developer (bots).
- Where:
  - `nav.ts:46` `BOT_NAV_DEFAULTS` and `:57` `navTuning` (`{ ...BOT_NAV_DEFAULTS, ...n }`);
  - `bots.ts:371` `BOT_DROP_DEFAULTS` and `:378` `botDropTuning`;
  - `bots.ts:325` `BOT_M2A_DEFAULTS.ads.scopedFireMinProgress: 0.9`.
- Why it matters: `bots.nav` is now required. A second copy of the numbers in code silently wins whenever a key is
  misspelt in data, and the two sets drift.
- Fix: read `b.bots.nav` directly and delete `BOT_NAV_DEFAULTS` (tests build balance through `balanceWith`). Ask
  tech-lead to make `bots.drop` and `bots.ads.scopedFireMinProgress` required too, since game-designer has shipped
  them, then delete the defaults.

**M2. `findPath` and `pathLength` bypass the per-tick nav budget.** Owner: game-developer (bots).
- Where: `nav.ts:918,941`. Bot code correctly uses `requestPath` everywhere today (`bots.ts:877,1203,1625,1867`).
  But `pathLength` (zone urgency, ADR 0005 §6) is exported unbudgeted, so the first caller that uses it from a bot
  breaks the `maxPathsPerTick` guarantee without any test failing.
- Fix: either budget `pathLength` (return `'wait'` like `requestPath`) or mark both `@internal` for tools and tests.
  Add a test: 16 bots with fresh goals on one tick perform at most `maxPathsPerTick` searches.

**M3. The legacy `server/Room.ts` (6 lines) is still in the tree.** Owner: network-engineer.
- Where: `pvp-over-ws.test.ts:12` imports `SILENT_LOGGER` from it, and nothing else uses it.
- Why it matters: it is dead code next to `GameRoom.ts`, a trap for the next reader.
- Fix: move `SILENT_LOGGER` to `server/common.ts` and delete `Room.ts`.

**M4. Measure the office costs before the playtest.** Owner: game-developer, graphics-engineer.
- Sim: the arc-preview and throw-solve budgets from REVIEW-M2a M2 and M3 are tested on the island only. Repeat
  `solveThrowPitch` p95 and one `buildGrenadeArc` on the office (about 1,300 collider parts).
- Render: `matchReport.ts --map office` for the server tick, and a draw-call count with every desk block in view.
- Budgets: §11.

### Low
**L1. Redundant interim casts and intersections.** Owner: game-developer. `World.ts:122-123,363,367,1257,1274,1327`
and `game/drop.ts:36-42`. They are in the residue table. They compile, but they hide the merged contract.

**L2. Landing speed while rising onto a ledge.** Owner: game-developer (sim core).
- Where: `movement.ts:441-446`.
- What happens: when a player lands while still moving up (stepping onto a raised top on the way up, so
  `prevY < ground`), the impact speed is `sqrt(vyStart² + 0)`. That reports the upward speed as an impact speed.
  It is harmless for damage (always below `fallDamageMinSpeed`), but the land sound and dip are louder than they
  should be.
- Fix: `vyStart > 0 ? 0 : …` (only the downward component).

**L3. The apex test is loose.** Owner: game-developer. `movement.test.ts:118-120` accepts 0.85x to 1.05x of the
apex. With the exact integrator, assert `|maxY − apex| <= g·dt²/8` (about 3 mm), so a regression to Euler is caught.

**L4. Island jump heights rose by about 0.1 m.** Owner: level-designer (check), qa-tester. Recheck the island's
intentional "not jumpable" props (hut roofs, the boat, crate stacks) against the 1.056 m apex. Nothing is expected to
change, but it was never checked against this number.

**L5. `bots.drop` is still optional in the type.** Owner: tech-lead. It was not on the gate list. It ships in
balance.json, so make it required in the next shared pass, together with M1.

## Contract notes recorded with this review
- ADR 0005 §6 now lists the bots agent's nav additions as contract: `NavBudget`, `requestPath`, `startNode`,
  `nodePos`, `plateauNodes`, `isReachableNode`, and `NavPath.route` and `climbs`.
- The ARCHITECTURE §15.1 "C-gate" column is now history: those changes are in.

## Follow-up (2026-11-18, final shared-types pass)
- **M1 (shared side) and L5: done.** `bots.drop` and `bots.ads` (with `scopedFireMinProgress`) are required in
  `Balance` and in `validateBalance`. Tests are in `balance.test.ts`. The bots code reads them without defaults.
- `clientFeel.deathCamKillerRange` is in `ClientFeelBalance` and `CLIENT_FEEL_KEYS`. `tuning.test.ts` passes.
- Nothing else from this review is open on tech-lead's side. M2-M4 and L1-L4 belong to the owners named above.
