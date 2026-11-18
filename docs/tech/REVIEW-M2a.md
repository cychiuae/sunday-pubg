# Code review: M2a "Arsenal & Stance" (Phase D2)

Reviewer: tech-lead. Date: 2026-11-18. Scope: everything Phase C delivered against
[ADR 0004](../adr/0004-m2a-stance-ads-grenades-armor.md) and [ARCHITECTURE.md](ARCHITECTURE.md) §14. Decisions from
this review: [ADR 0004 addendum](../adr/0004-m2a-stance-ads-grenades-armor.md#addendum-2026-11-18-phase-d2-review).
Line numbers are as of this review.

**Overall:** M2a is in good shape. `npx tsc --noEmit -p .` is clean and `npx vitest run` passes (63 files, 1145 tests,
after the contract edits below). The contract was followed closely:
- Stance, ADS and grenade physics each have one implementation in `src/shared/sim/`. Those functions are reused by
  World, prediction, the camera, the arc preview, bots and extrapolation.
- The prone box, transition hitbox, vest-only explosions, the private `actionFailed` and the protocol v2 gating all
  match ADR 0004.
- There is a World-vs-predictor equivalence test for stance and ADS (`stance.test.ts:236`, `prediction.test.ts:144`)
  and one for actions (`actionPrediction.test.ts:306`).

No High-severity defects were found. The findings below are about duplication, small per-frame and per-tick costs, and
tuning numbers that should be data. Most of them get more important in M2b, because the office map adds per-match
balance and many more colliders.

## Boundary and determinism checks (grep, all pass)
| Check | Result |
|---|---|
| `src/shared/sim/` imports only `src/shared/*.ts` and `sim/` | Pass. The only non-sim import is the type-only `GrenadeArcView` from `contracts.ts` (`grenade.ts:6`), which is allowed and was specified in §14. |
| `Math.random`, `Date.now`, `performance.now` in sim (non-test) | None |
| render, ui and audio import only `sim/terrain` and `sim/colliders` from the sim | Pass (`PropLayer.ts:7`, `Renderer.ts:15`, `visualTerrain.ts:7`, `Ui.ts:12`) |
| render, ui and audio never import `src/game`, `src/net` or each other | Pass |
| `src/game` never imports `protocol/` | Pass |
| Hard-coded player-facing English in `src/ui` | None found. Every label goes through `t()`. |
| `BALANCE` imported outside composition roots | `AudioDirector.ts:7` (fallback, see M5), `constants.ts:5` (allowed), `matchReport.ts` (tool) |

## Findings, ranked

### Medium

**M1. `actionPrediction.ts` is a second copy of `World.processPlayer`'s action rules.** Owner: game-developer.
- Where: `src/game/actionPrediction.ts` (374 lines). It copies `TIMER_EPSILON_MS` and `MAX_SHOTS_PER_TICK` by value
  (`:49`, `:51`) and re-implements swap, reload, heal, fire interval, trigger latch, cook, throw, cook-out and
  auto-switch.
- Why it matters: REVIEW-M1 m1 asked only for heal-status timing. The mirror now covers almost every action, against
  ADR 0004 "Consequences", where reload, heal and swap were not predicted. Every rule change (and M2b will bring some)
  must be made twice. The equivalence tests catch drift only in the scenarios they script.
- Fix: in M2b Phase C, move the pure action step into `src/shared/sim/actions.ts`. It needs
  `advanceTimers(state, dtMs, b)` and `applyEdges(state, input, now, b): { state, events }`, operating on a plain
  `ActionState`. `World.processPlayer` and the predictor would both call it, and the predictor keeps only the
  carry-over bookkeeping. Until then, export the two constants from the sim and import them. Keep
  `actionPrediction.test.ts:306` as the regression test.

**M2. The grenade arc preview rebuilds about 100 ticks of physics with fresh objects every frame.** Owner: game-developer.
- Where: `ClientGame.ts:897` calls `buildGrenadeArc` every rendered frame while the grenade slot is ready.
  `predictGrenadeArc` (`grenade.ts:227`) allocates one point plus about 6 objects inside `stepGrenade` per tick: with a
  3.5 s fuse, that is about 800 short-lived objects and 100 terrain and collider raycasts per frame.
- Why it matters: GC pauses while aiming a grenade, at exactly the moment you need a smooth frame. In M2b the office
  has hundreds of colliders, so each `raycastColliders` call costs more.
- Fix: (a) Recompute only when the eye, yaw or pitch moved past a small epsilon, or once per sim tick. Otherwise
  return the cached view. (b) Give `predictGrenadeArc` an optional `out: { points: Vec3[] }` that reuses its point
  objects. `GrenadeLayer` already copies into a typed buffer, so the renderer needs no change.

**M3. Bot grenade aim runs about 4000 grenade steps in one server tick.** Owner: game-developer.
- Where: `solveThrowPitch` (`bots.ts:1109`) does (75 / 2.5 + 1) + 8 = 39 arc predictions. Each runs up to
  `(fuseMs - cookMs) / 33` ticks, and every tick does a terrain and a collider raycast. This happens once per throw
  plan, which is acceptable, but it is unmeasured against the 5 ms server tick budget (§11). Several bots can start a
  plan on the same tick.
- Fix: add a timing test, `solveThrowPitch` p95 < 1 ms on the island, and repeat it on the office in M2b. Cheap
  improvements: seed the search from the closed-form no-bounce ballistic pitch and refine ±5° only, stop each arc at
  its first contact past the target distance, and allow at most `bots.nav.maxPathsPerTick`-style 1 solve per tick
  across bots.

**M4. Audio infers crouch and crawl footsteps from `stanceChanged` history.** Owners: game-developer (producer),
audio-designer (consumer).
- Where: `AudioDirector.ts:442-447`. It reads `stance` from the payload through an `as` cast, and otherwise falls back
  to the last `stanceChanged` for that player.
- Why it matters: a player who is already crouched or prone when they first come into view never sent you a
  `stanceChanged` event, so their crawl sounds like walking. The cast also bypasses the contract.
- Fix (contract done): `GameEvents.footstep.stance?: Stance` is added. game-developer sets it in the local footstep
  (`ClientGame.ts:687`, predicted `state.stance`) and the remote footstep (`derived.ts:260`, interpolated
  `PlayerState.stance`). audio-designer then reads `e.stance` directly, drops the cast, and keeps the map only as a
  fallback.

**M5. Audio still falls back to the global `BALANCE`, and main.ts does not inject it.** Owners: tech-lead (main.ts),
audio-designer.
- Where: `AudioDirector.ts:7,115` and `main.ts:38` (`new AudioEngine(bus, { lowHealthHp })` has no `balance`).
- Why it matters: today the values are the same. In M2b the balance becomes per-match (deep-merged per map, ADR 0005).
  Then audio's sniper bolt timing and grenade fuse would quietly use the base values.
- Fix: main.ts passes `balance` to `AudioEngine`, and in M2b calls `setBalance` on map change (ADR 0005 §4).
  audio-designer removes the `BALANCE` import and the `??` fallback, as ARCHITECTURE §9 asked for in M1. The main.ts
  edit is pending (see the end of this file).

**M6. The armor pickup prompt cannot show "31/55" for a tier the player has never worn.** Owners: game-developer
(producer), ui-ux-designer.
- Where: `hud.ts:226` caches `maxDurability` only from worn pieces (`:877`). `armorPromptDetail` (`logic.ts:368`) then
  prints "31" without the maximum.
- Fix (contract done): `interactPromptChanged.maxDurability?: number | null` is added. derived.ts fills it from
  `balance.items[item].durability` for armor ids and null otherwise. Ui uses it and keeps the cache only as a fallback.

**M7. Tuning numbers in code.** Owner: game-developer (code), game-designer (balance.json).
- `src/game/grenades.ts:22`: `DANGER_MARGIN_M = 2`, while balance.json already has `items.grenade.dangerMargin: 2`.
  The contract now types it as the optional `GrenadeBalance.dangerMargin`. Read `g.dangerMargin ?? 2`.
- `src/shared/sim/bots.ts:343`: `scopedFireMinProgress: 0.9` is behaviour tuning, not plumbing. The contract now types
  it as the optional `bots.ads.scopedFireMinProgress` (validated in [0, 1]). game-designer adds the key, and
  bots.ts reads it with 0.9 as the default.

### Low

**L1. `isHeadshot` (`combat.ts:57`) is the dead M1 stand-only head rule.** Owner: game-developer. Production code only
uses `rayHitbox`. A future caller would get the wrong answer for a crouched target. Fix: delete it and its two test
lines (`combat.test.ts:19-20`). `stance.test.ts` covers the head zones.

**L2. Ui has its own `isScopeSight`** (`ui/logic.ts:717`). Owner: ui-ux-designer. The shared one in `balance.ts` is now
a type guard (`sight is 'scope_4x' | 'scope_8x'`). Fix: import it and delete the copy.

**L3. Drop rarity table in sim code** (`loot.ts:35` `DROP_TIERS`). Owners: game-designer, game-developer. It is design
data (loot.md "UI") and the rest of the loot tables live in balance.json. Fix (when convenient): add the optional
`loot.dropTiers` (ItemId → tier). tech-lead adds validation when the designer asks. Cosmetic only, so Low.

**L4. Unnamed physics literals in `grenade.ts`.** Owner: game-developer. `:177` uses `n.y > 0.7` as the rest slope and
`:204` uses `89°` as the launch cap. Both come from grenades.md and are not tuning. Fix: name them as module constants
next to `SUPPORT_FACTOR`, so the spec link is visible.

**L5. `server/validate.ts:25` `MAX_MOVE_LEN` duplicates `movement.ts` `MAX_MOVE_INPUT_LEN`.** Owner: network-engineer.
The server may import `src/shared/**`. Fix: import the sim constant, so the bit-identical guarantee in its JSDoc
cannot drift.

**L6. An input stall while cooking throws the grenade.** Owner: none (accepted). After `MAX_INPUT_REPEAT_TICKS`,
`World.ts:597` neutralises `fire`, which releases a cooked grenade at the last yaw. This beats a cook-out in hand, and
it only happens on a stall of more than 150 ms. Recorded so QA does not file it as a bug.

## Contract edits made in this review (tech-lead, `src/shared/`)
| Edit | File |
|---|---|
| `interactPromptChanged.maxDurability?: number \| null` | `events.ts` |
| `footstep.stance?: Stance` | `events.ts` |
| `HudGrenadeDangerView.fuseRemainingMs?: number` | `contracts.ts` |
| `HudView.adsBlocked?: AdsBlockReason \| null`, `AdsBlockReason = 'reloading' \| 'healing'` ('sprinting' dropped; RMB already cancels sprint in the sim) | `contracts.ts` |
| `IAudio.setGrenades?(grenades: readonly GrenadeView[], serverTime: number)` (accepted, ADR 0004 A2) | `contracts.ts` |
| `LootState.tier` JSDoc: drops use the per-item rarity table, not 'common' | `types.ts` |
| `MovementState.adsMs` JSDoc: ADS never engages at `adsTimeMs` 0 | `types.ts` |
| `validateBalance`: `adsTimeMs > 0` for sighted weapons. Optional `items.grenade.dangerMargin` (>= 0) and `bots.ads.scopedFireMinProgress` ([0, 1]) | `balance.ts`, tests in `balance.test.ts` |
| `isScopeSight` is now a type guard | `balance.ts` |

Every new field is optional, so no producer or consumer breaks. Producers fill them in M2b Phase C at the latest.

**Pending, not done here:** the two `src/main.ts` lines (M5 `balance: BALANCE` for `AudioEngine`, and
`audio.setGrenades?.(view.grenades, view.serverTime)` after `audio.setListener`). The edit to main.ts was blocked by
the session's permission check, so it is left for an approved follow-up.
