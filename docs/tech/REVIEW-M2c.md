# Code review: M2c "Fresh Every Match & Bigger Arsenal" (Phase D)

Reviewer: tech-lead. Date: 2026-11-18. Scope: the M2c build against
[ADR 0007](../adr/0007-m2c-layouts-levels-melee-rockets-smoke-scopes.md) and [ARCHITECTURE.md](ARCHITECTURE.md) §16:
G-sim, G-client (including the switch to the shared action step), network N1 + N2, render Phase 2, UI, audio, art A1
and the level generator. Line numbers are as of this review; builders were still tuning, so some may drift.

**Tree:** `npx tsc --noEmit -p .` is clean. `npx vitest run`: 104 of 105 files pass (2,097 tests, 1 skipped, 1 todo).
The 4 failures are all in QA's `tests/sim/m2b-edge.test.ts`: BUG-011 (2), BUG-012 (1) and the office loot-weight pin.
QA is updating that file; they are not M2c regressions.

**Verdict:** the architecture held. Every concept has one shared rule, the sim is pure, and the wire format matches
ADR 0007 §9 with real budget tests. There are two must-fix items before the milestone closes. Both are verification gaps
on hard guarantees from the brief, not known bugs.

## Conformance checks (grep and read; all pass)
| Check | Result |
|---|---|
| Sim purity (`src/shared/sim/**`): no `three`, DOM, render, ui, audio, net or `src/game` imports; no `Math.random`, `Date.now` or `performance.now` | Pass. The only `performance.now` hit is a doc comment (`movement.ts:78`). |
| The sim never imports the layout generator | Pass: the World gets the applied map (`server/layoutLock.ts`, `GameRoom.ts:506`). |
| Generator determinism (`src/game/levels/layout/**`): no `Math.sin/cos/atan2/hypot/pow/random`, no time; trig through `detmath` | Pass. `layout/office.ts:174` is a detmath port of `indoorGeometry.ts`, and the tests deliberately keep the Math-based geometry as an independent check. |
| `effectiveWeapon` is the one stat rule | Pass. The sim uses the cached `effWeapon` (`sim/levels.ts:17`). Client ADS uses `adsSpecOf` (`game/ads.ts:31`) and the crosshair uses the sim's `effectiveSpreadDeg` with the predicted level and scope (`ClientGame.ts:1637`). No direct `weapons[id].damage/adsZoom/...` reads remain outside `balance.ts`. |
| `segmentBlockedBySmoke` / `pointInSmoke` are the one visibility rule | Pass: bots (`bots.ts:813`), `smokeView.ts:82`, `ClientGame.ts:639` and `:1059`, name tags and glint through `PlayerView.smokeHidden` (`PlayerViews.ts:596`). |
| `rocketPosAt` is the one path rule | Pass: sim sweep (`sim/rockets.ts:56-57`), `rocketsView.ts:69`, audio dead-reckoning (`AudioEngine.ts:841`). |
| Scope rules have one implementation | Pass: `scopePickupPlan` / `scopeCyclePlan` in `sim/scopes.ts`. The client re-plans the running T switch with the same function (`m2cPrediction.ts:predictedScopes`). |
| Shared action step | Pass. The throwable cycle, melee wind-up and T switch run in the client Predictor through `sim/actions.ts` and reconcile by input seq. `m2cPrediction.ts` only derives views and events. |
| Rows codec, carry-forward, `localPatch` | Pass. Coverage types make a new field a compile error (`protocol/rows.ts:41-52`). Rows go only to clients that advertise `CAP_ROWS`. Carried lists compare by value against the per-socket base (`delta.ts:36`, `:149`). `localPatch` falls back to a whole `local` when a key disappears (`delta.ts:84`). The decoder rebuilds exactly (round-trip asserted in every budget test). |
| Gated validators | Pass: `M2C_FIELDS_REQUIRED = PROTOCOL_VERSION >= 4` (`messages.ts:514`). The fields that stay optional for good are documented at `:510`. |
| Snapshot budgets (ADR 0007 §9) | Pass. 24-player worst case 7,959 B (objects 16,619 B); 16-player 4,634 B; worst delta (M2a method) 3,464 B. All asserted in `protocol/m2c.test.ts:505-578`. |
| Render budgets (LV13b) | Pass (RENDERING.md §11.4). Office worst seed: 121 calls at medium with 12 players and 4 clouds. Island worst seed: 90 calls; 75 with 8 clouds. |
| Layout lock | Pass. Repeat avoidance only against the same map (`GameRoom.ts:505-506`); LRU keyed `map:seed:version`; `layoutMs` and `navMs` logged with a 250 ms warning (`layoutLock.ts:35`, `GameRoom.ts:540`). The server builds without decor (`server/app.ts:75`). The client checks version and hash and throws in dev and tests (`layoutClient.ts:49`, `:67-74`). |
| File ownership | No edits to other owners' files found in the M2c files. |

## Findings

### Must-fix
**MF1. The office stuck-rate guarantee (brief, LV14) is not measured anywhere.**
Owner: game-developer (tool), qa-tester (run).
- `matchReport.ts` takes `--layout-seed(s)` (`src/shared/sim/tools/matchReport.ts:102-109`) but reports no stuck-rate
  metric. LV14 is still `it.todo` (`src/game/levels/layout/layout.test.ts:884`).
- The brief makes "office nav stuck-rate under 2 %" a hard guarantee over 200 seeds. Per-match nav is new in M2c, and
  `gaps`/`pods` change the floor plan, so this is the main bot risk of the milestone.
- Fix:
  - Add a per-bot "stuck" counter to `matchReport` (no progress toward the nav goal for ≥ 2 s while not holding/fighting; the existing detour logic at `:244` is a natural hook). Print it overall and per seed.
  - QA runs `--map office --layout-seeds 200` nightly and 30 seeds in CI. Gate: < 2 % overall, ≤ 5 % for any seed (variety.md LV14).

**MF2. Cross-engine determinism is only tested in Node.** Owner: qa-tester (test), level-designer (data).
- The golden hashes (LV1) and my `detmath` golden values run in Vitest (V8) only. The point of ADR 0007 §1.4 is that
  browsers agree with the server, and the hash check in production only logs.
- The base island data still uses `Math.sin/cos/atan2/hypot` at module load (`src/game/levels/island.ts:133-139`),
  rounded to cm. The generator reads those spawns, zone centres and fixed props in accept/reject decisions
  (`layout/island.ts:231-232`, `:308`, `:764`). A 1-ulp engine difference before the cm rounding can flip a value at a
  .005 boundary. It is rare, but the brief requires every player to see the same layout.
- Fix:
  - QA: a Playwright test that loads the client, builds layouts for the 3 pinned golden seeds per map plus 20 random ones, and compares `layoutHash` with values computed in Node. Run it on Chromium, and on Firefox and WebKit where the runner has them.
  - Level-designer: compute the island base positions through `detmath` (`degToStep` + `detSin/detCos`), or freeze them as literals. Then the base data is engine-independent too.

### Should-fix
**SF1. Glass pane ids are numbered twice.** Owner: game-developer.
- `sim/colliders.ts:295-310` counts panes with its own counter. Render (`GlassLayer.ts`) and the layout tests use
  `glassPanes(map)`. They agree today because every glass kit part is a single box.
- A future glass cylinder, or the stacked-box merge (ADR 0005 T10) touching a glass part, would open one pane in the sim
  and another on screen. One rule per concept: build the collider `pane` ids from `glassPanes(map)`, or add a test over
  the 202 office seeds asserting the two id-to-geometry maps are equal.

**SF2. Rockets sweep as a ray, not with `rocket.collisionRadius`.** Owner: game-developer.
- `sim/rockets.ts:69-100` casts a zero-radius ray against props, glass and hitboxes. rpg.md "Firing and flight" step 3
  says the segment is swept with radius 0.12, so near-misses at about 0.1 m pass through today.
- Either inflate the hitbox and prop tests by the radius, or record the deviation in rpg.md (game-designer) and keep the
  ray. Either way, add a test with a rocket passing 0.1 m from a crate edge.

**SF3. The smoke-arc kind is in the contract; it needs a producer and a consumer.** Owner: game-developer (client),
graphics-engineer.
- I added `GrenadeArcView.kind?` in this review (`contracts.ts`, your request).
- G-client: set it in `buildGrenadeArc` (`src/game/grenades.ts:202`), and use `items.smoke.cloud.radius` for `radius`
  when the selected throwable is smoke.
- Render: draw the lilac ring for `'smoke'`.

**SF4. Full-snapshot headroom at 24 players is thin, and a realistic 24-player delta is over the delta budget.**
Owner: network-engineer (watch).
- The 24-player worst case is 7,959 B, which leaves 233 B. The "all moving and aiming" 24-player delta measures
  4,455 B against a 4,096 B delta budget; the test bounds it at 6,144 B (`protocol/m2c.test.ts:577`).
- This does not ship: `match.maxPlayers` is 16, and every 16-player figure has a wide margin.
- Before anyone raises `maxPlayers`, apply the next compaction:
  - integer-quantised yaw/pitch in patches (mrad as integers), or
  - patch rows for the moving fields.

  Add a 16-player "all moving and aiming" delta assertion under 4,096 B now, so the shipped case has a hard number.

### Nits
| # | Owner | Where | Note |
|---|---|---|---|
| N1 | game-developer | `sim/levels.ts:11-30`, `game/ads.ts:52` | Module-level memo caches whose results are shared objects. They are deterministic, so they are allowed, but `Object.freeze` the cached results so a caller cannot mutate everyone's effective stats. |
| N2 | game-developer | `sim/clouds.ts:31-35` | `addCloud` sets `fadeAt` on the stored cloud in place. That is safe only because `World.ts:421` copies clouds into each snapshot (the delta base would otherwise not see the change). Note the invariant on `addCloud`, or return new objects. |
| N3 | game-developer | `sim/melee.ts:113-118` | The sweep runs a 48-step ternary search per candidate. Pre-filter candidates by feet distance ≤ range + sweepRadius + player radius before the search (cheap; matters with 16 players in the final circle). |
| N4 | graphics-engineer | `render/SmokeLayer.ts:358` | Recomputes the fade fraction from `fadeAt`/`fadeMs` for the dissolve. It is cosmetic and consistent with `smokeRadiusAt`, but a `fade` field on `SmokeCloudView` (ClientGame, one rule) would remove the copy. I can add it to the contract on request. |
| N5 | graphics-engineer | `render/PlayerViews.ts:595` | `s.sight ?? sightOf(...)` is dead code since the gate (`PlayerState.sight` is required). Drop the fallback. |
| N6 | audio-designer | `audio/AudioDirector.ts:191` | The sniper bolt sound uses the L1 `fireIntervalMs`, so an L4 sniper (1,120 ms) bolts later than it fires. Use the level from the shot when the shooter is known, or ask me for an optional `shotFired.level`. |
| N7 | network-engineer | `protocol/m2a.test.ts:488` | The per-grenade object bound was loosened from 160 to 180 B. It is justified in the comment (+17 B for `kind` in the object format; rows are about half), so this is not a hidden regression. Recorded here so the next change has to justify itself again. |
| N8 | game-developer | `sim/World.ts` (1,778 lines), `sim/bots.ts` (2,632 lines) | Both keep growing. M3: split bots by behaviour (`bots/melee.ts`, `bots/rpg.ts`, `bots/smoke.ts`) and move the projectile step out of `World.ts`. Not now. |

## Contract changes made in this review
- `GrenadeArcView.kind?: M2cThrowableId` (`src/shared/contracts.ts`), and `radius` is documented as the cloud radius
  for a smoke throw (SF3).

## Follow-ups owned by tech-lead
- After MF1 and MF2 land: re-run the 200-seed office stuck rate and the browser hash test, then close the milestone in
  ARCHITECTURE §16.
- On request: `SmokeCloudView.fade` (N4) and `shotFired.level` (N6).

## Final sign-off (2026-11-18)

**Verdict: approved. M2c is closed.** Every must-fix and should-fix is closed in the code, not only reported.

| Item | Status | Evidence |
|---|---|---|
| MF1 office stuck rate | Closed | `sim/tools/navStuck.ts` plus `matchReport --nav-walk`; in-match stuck samples in `matchReport.ts:353`. LV14 gates 30 seeds in Vitest (`layout.test.ts:885`, pooled < 2 %, every seed ≤ 5 %). My 200-seed run (`matchReport --map office --layout-seeds 200 --nav-walk 60`): pooled 0.25 %, worst seed 4.39 % (`0xbe2f86d6`), 0 seeds over 5 %. |
| MF2 cross-engine determinism | Closed | `tests/e2e/m2c-layout.spec.ts`: Chromium and Node agree on 24 map/seed pairs (`layoutHash` and the full digest). `island.ts`/`office.ts` use deterministic trig (`detTrig.ts`). |
| SF1 pane ids | Closed | `sim/colliders.ts:296-320` builds `pane` ids from `glassPanes(map)`. |
| SF2 rocket radius | Closed | Sphere sweep with `collisionRadius` (`sim/rockets.ts:75-79`); test `rockets.test.ts:203` (0.1 m hits, 0.2 m passes). |
| SF3 smoke arc | Closed | `buildGrenadeArc` sets `kind` and the cloud radius (`game/grenades.ts`); `GrenadeLayer.ts:336` draws it. |
| SF4 delta headroom | Closed | `rocketsDelta`/`smokesDelta` record deltas (now in ADR 0007 §9.2); 16-player "moving and aiming" deltas < 4,096 B (`protocol/m2c.test.ts:589`, `:596`). 24 players still needs the next compaction before `maxPlayers` rises (NETCODE.md). |

### Changes made in this sign-off
- `wallFrame` (`src/shared/maps.ts`) now uses `atan2Det`/`hypot2`. It feeds level data built at module load
  (`indoorGeometry.wallSolid` for a diagonal wall), and that data feeds the generator. Every wall today is
  axis-aligned, so the output is bit-identical to the Math version, signed zeros included. The golden hashes did not
  change. The sim's colliders still take `Math.sin/cos` of `rotY`. That is allowed: collision is server-authoritative,
  and client prediction tolerates 1-ulp differences.
- `src/shared/detmath.ts` gains `sinRad`, `cosRad`, `atanDet`, `atan2Det` and `hypot2`. They are bit-identical to
  `detTrig.ts` on 600k inputs except that `atanDet(-0)` is `-0`, as with `Math.atan`. Golden values are pinned in
  `m2c.test.ts`.
- `LAYOUT_FORMAT_VERSION` 1 → 2 (`src/shared/layout.ts`), because BUG-015 changed office seed `0x00000001`. The
  rule in the constant's comment applies. A stale tab paired with a new server now fails on version, not just on hash.
- ADR 0007 §1.4, §1.5 and §9.2 and ARCHITECTURE §16 record the record deltas, the helpers and the version history.

### Remaining nits (no blockers)
| # | Owner | Note |
|---|---|---|
| R1 | level-designer | Make `src/game/levels/detTrig.ts` a re-export of the detmath helpers (one rule per concept). |
| R2 | build-engineer / qa-tester | No nightly CI job runs the 200-seed nav walk yet. Add `matchReport --map office --layout-seeds 200 --nav-walk 60` (about 140 s). |
| R3 | game-developer | `sim/colliders.ts:310`, `:319`: a glass collider with no `glassPanes` entry silently gets no `pane` and becomes unbreakable. Assert instead (dev and tests). |
| R4 | network-engineer | `diffRecords` assumes both lists are sorted by id, and the decoder re-sorts. Document on `WorldSnapshot.rockets/smokes` that the sim emits them sorted by id, or sort in the encoder. |
| R5 | network-engineer | `server/layoutLock.test.ts:133` pins ` v1 ` in the log-line regex; use `v${LAYOUT_FORMAT_VERSION}` (fails since the bump to 2). |
| R6 | qa-tester | `tests/sim/m2c-layout-qa.test.ts` BUG-015 is `it.fails` and now passes (fixed); flip it to `it`. |
| — | as before | N1-N8 above stay open as M3 hygiene. |
