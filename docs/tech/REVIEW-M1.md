# Code review: M1 Phase B

Reviewer: tech-lead. Date: 2026-11-18. Scope: the whole codebase against [ARCHITECTURE.md](ARCHITECTURE.md),
CLAUDE.md and [ADR 0001](../adr/0001-stack-and-netcode.md). Decisions that came out of this review:
[ADR 0002](../adr/0002-m1-netcode-and-boundary-clarifications.md). Contract changes:
ARCHITECTURE.md §12 "Contract revision 1".

Line numbers are as of this review. game-developer was editing `src/shared/sim/` at the same time, so lines there
may drift.

**Overall:** the code is in good shape. The dependency rules hold (checked with grep, results below). The sim is
deterministic and pure. The network edge is defensive: decode never throws, inputs are clamped and rate-limited,
there is a guard around every handler, and slow sockets are skipped and then closed. Per-frame DOM writes are diffed,
and the renderer's hot path allocates almost nothing. Most findings are about enforcement, a few contract gaps (now
in revision 1), and one sim behaviour that a hidden tab can trigger.

## Follow-up status (2026-11-18, after Contract revision 1 landed)

Checked by reading the code. "Fixed" means the code that the fix describes is in place, with the file:line given.
Revision 1b decisions are in [ADR 0003](../adr/0003-low-health-signal-and-typed-bot-tuning.md).

| Item | Status | Evidence / what remains |
|---|---|---|
| M1 input starvation | **Fixed** | `World.ts:547` caps the repeat at `MAX_INPUT_REPEAT_TICKS`; test `World.test.ts:167`. |
| M2 lint | Open | No ESLint/Prettier config and no `lint` script in `package.json` or `ci.yml` (build-engineer). |
| M3 Renderer `BALANCE` | **Fixed** (injection) | `main.ts:35` passes `BALANCE`. Remaining: graphics-engineer drops the `Renderer.ts:10` import and the `?? BALANCE` at `:112`. |
| M4 context loss | **Fixed** (restore) | `Renderer.ts:129,357` rebuilds state on restore. Never-restored case: revision 1b #14 `getGraphicsStatus`/`setGraphicsStatus` (ADR 0003 §5). Remaining: producer, consumer, Playwright test. |
| m1 heal status timing | Deferred to M2 | As planned. |
| m2 World + Predictor test | Open | `prediction.test.ts:117` still uses `stepMovement` on both sides. |
| m3 revision 1 producers | **Fixed** in code | `hudBuilder.ts:98-100,160`, `simEvents.ts:57-63,155`, `messages.ts:366`, `loot.ts:20`, `ui/settings.ts:70`, `Ui.ts:355`. Waiting: game-designer's `clientFeel`, `bots.ai`, `items.medkit.preferAtOrBelowHp` numbers in balance.json. |
| m4 prop heights | **Fixed** | Mirror deleted (`PropLayer.ts:7` imports `DOCK_DECK_HEIGHT`); model-versus-collider test `render/m1fix.test.ts:53`. |
| m5 low-HP thresholds | **Decided** (ADR 0003) | `player.lowHpThreshold` → `HudLocalView.lowHpThreshold` (Ui) and `main.ts` → `AudioEngine` `lowHealthHp`. The revision 2 event is dropped. Remaining: hudBuilder producer, Ui consumer, game-designer number. |
| m6 dev tool in sim | Open (lint) | Needs the M2 lint exemption for `sim/tools/`. |
| m7 hard-coded coast | **Fixed** | `World.test.ts` no longer uses `heightAt(0, -133, …)`. |
| m8 bot loot literals | **Fixed** | `BOT_AI.lootScore*` in `bots.ts`; typed in `BotAiBalance` (revision 1b). |
| m9 death card | **Fixed** | `Ui.ts:290` reads `hud.deathScreenSeconds`. |
| m10 `npm start` | **Fixed** | `package.json:16`, BUILD.md table row. |
| m11 bot-kills-human test | Open | Fails again on 2026-11-18 05:13 (`World.test.ts`, "past its loot phase…"), together with three `zone.test.ts` timeline tests, after the balance.json retune (`zone.phases[0].waitSeconds` 60 → 75). |
| Nits | **Fixed** except allocations | `hud.ts` cast gone; heavy-hit/vignette now fractions (`ui/logic.ts`); title (`index.html:11`, `Ui.ts:167`); `NetClient` `LogLimiter` (`NetClient.ts:104`); `MAX_MOVE_LEN`/`MAX_MOVE_INPUT_LEN = 1 + 1e-9`; `ALLOWED_ORIGINS` closed (see the nit). Allocations: no action unless profiled. |

## Dependency check (grep, at review time)

| Rule | Result |
|---|---|
| sim imports only `src/shared/*.ts` and `sim/` | OK for runtime code. Test files and `sim/tools/matchReport.ts` import `src/game/levels/island` (allowed from now on, ADR 0002 §6). |
| sim uses no `Math.random`/`Date.now`/`performance.now`/DOM | OK. The only hit is `sim/tools/matchReport.ts:342` (`Date.now`, a dev tool; exempt). |
| render/ui/audio never import each other, `game`, or `net` | OK. `render/helpers.test.ts:3` imports `game/levels` (test-only, allowed). |
| render imports only `sim/terrain` from sim | OK. `PropLayer.ts:29` mirrors a sim constant instead, so render may now import `sim/colliders` (ADR 0002 §7). |
| game does not import `protocol` or `net` | OK |
| protocol imports only shared types | OK |
| server imports only allowed modules | OK (`shared/**`, `game/levels`, `content/strings`, `ws`, `node:*`) |
| Only composition roots import `BALANCE` | **Violated** by `src/render/Renderer.ts:10,91` (see M3) |

## Blockers

None. The loop works end to end in a real browser, the typecheck is clean, and the suite passes apart from the
in-progress test noted under "Test status".

## Major

**M1. A starved input queue repeats held input forever.** `src/shared/sim/World.ts:521-542` (`dequeue`). Owner:
game-developer.
When the tab is hidden, rAF stops, so ClientGame sends nothing. The World then repeats the last input's held fields
(move, sprint, **fire**) indefinitely. A player who alt-tabs while holding W keeps running into the sea. One who
alt-tabs while holding fire on the SMG keeps firing until the mag is empty. The blur handler (`InputController.ts:90`)
cannot help, because no further input is sent after it.
*Fix:* count consecutive starved ticks per player. After `MAX_INPUT_REPEAT_TICKS` (constants.ts, now 6) return
neutral held fields (no move, sprint or fire; keep yaw and pitch). Add a test: queue one input with fire and forward
held, step 10 ticks, and assert no movement or shots after tick 6.

**M2. No lint, so the dependency table is enforced only by review.** `package.json:9-22` has no `lint` script, and
there is no ESLint or Prettier config. Owner: build-engineer.
ARCHITECTURE §3 asks for `no-restricted-imports` overrides per folder. Without them, one stray import (for example,
audio importing `src/ui`) passes typecheck and CI.
*Fix:* ESLint flat config with `@typescript-eslint` (strict). Use per-folder `no-restricted-imports` that mirror the §3
table, including the exemptions for test files and `sim/tools`. Add `no-restricted-globals`/`no-restricted-properties`
for `Math.random`, `Date.now` and `performance.now` in `src/shared/sim/**` (excluding `tools/`). Add `npm run lint`
to `build` and CI. Add Prettier with the current style (2 spaces, single quotes, width 120).

**M3. Renderer reads `BALANCE` directly.** `src/render/Renderer.ts:10,91`. Owner: graphics-engineer.
This breaks "Code receives balance by injection; only composition roots import BALANCE" (ARCHITECTURE §9). Tests and
`BALANCE_OVERRIDE` experiments cannot change the renderer's numbers (bob height, scatter, player height).
*Fix:* Contract revision 1 #10. Accept `balance?: Balance` as the 4th constructor parameter (falling back to
`BALANCE` is fine for now). tech-lead then passes it from `main.ts`.

**M4. The renderer has no recovery after WebGL context loss.** `src/render/Renderer.ts:107` calls `preventDefault()`
on `webglcontextlost`, but nothing listens for `webglcontextrestored`. Owner: graphics-engineer.
Integrated GPUs lose the context on driver resets and sleep or wake. The screen then stays black for the rest of the
session while the game keeps running.
*Fix (M1-acceptable):* on `webglcontextrestored`, call `gl.dispose()` and rebuild GPU resources. Alternatively, show
a "graphics reset, reload" message through a new `IRenderer` status flag (ask tech-lead). The minimum is a test that
simulates loss with `WEBGL_lose_context` in Playwright (qa-tester).

## Minor

**m1. Client prediction uses snapshot status, but the server uses the status of the current tick.**
`src/game/ClientGame.ts:355,445` (`statusOf(local, true)`) versus `src/shared/sim/World.ts:605`. Owner:
game-developer.
When a heal starts or ends, the server applies `healMoveMultiplier` about 1 RTT before or after the client does. The
result is a small correction on every heal, which shows as a visible slide at high ping. It is acceptable for M1.
*Fix (M2):* predict the `healing` flag locally from `useHeal` edges and `healTotalMs`, or tag each pending input with
the status that was used.

**m2. No test drives the real World and the Predictor with the same inputs.** `src/game/prediction.test.ts:116` runs
`stepMovement` on both sides, so it does not cover the path through `World.sanitize` → `processPlayer` →
`toMovementInput`, or the Room's `sanitizeInput`. Owner: qa-tester (cross-module, `tests/`) or game-developer.
*Fix:* use a debug World with one human. Pass the same inputs through `server/validate.sanitizeInput` →
`world.applyInput` → `step`, and in parallel through `Predictor.apply`. Reconcile on `snapshotFor(id).local` and
assert that the correction is below 1e-6 for 300 ticks of walking, sprinting and jumping (not healing; see m1).

**m3. Contract revision 1 producers are missing.** These are the gaps the builders reported. Owners:
game-developer (sim fields, `simEvents.ts`, `hudBuilder.ts`, `tuning.ts`/`inventory.ts`/`bots.ts` casts),
network-engineer (`isSimEvent`/`isLoot` must validate the new optional fields and add the `actionFailed` case;
without it, `decodeServerMessage` silently filters the event, `src/shared/protocol/messages.ts:260-291`),
ui-ux-designer (`Settings.quality`, `playUiSound`), game-designer (`clientFeel`, `bots.ai`,
`items.medkit.preferAtOrBelowHp` numbers). See ARCHITECTURE §12 "Contract revision 1" for each one's job.

**m4. Prop colliders and models disagree, and the dock deck height is duplicated.** `src/render/PropLayer.ts:29`
(`DOCK_DECK_HEIGHT_MIRROR`), `src/shared/sim/colliders.ts` (prop collider table), RENDERING.md §6 (hut roof 3 m
versus 4.9 m, so shots pass through the roof; boat and rock heights also differ). Owners: game-developer (sim
heights, already in progress), graphics-engineer (import `DOCK_DECK_HEIGHT` from `sim/colliders`, now allowed, and
delete the mirror).
*Fix:* make `sim/colliders.ts` the single source of truth. Add a render test that compares each model's bounding
box top with the collider top, within a tolerance.

**m5. Two "low health" thresholds disagree.** `src/ui/hud.ts:30` (`LOW_HP = 0.3`, a fraction) and
`src/audio/cues.ts:252` (`lowHealthHp: 25`, absolute HP that assumes maxHp is 100). Owners: game-designer (decide
the number), ui-ux-designer and audio-designer (consume it).
The stripes and the heartbeat start at different HP, and the audio threshold breaks if `player.maxHp` changes.
*Fix (Contract revision 2):* add `clientFeel.lowHpFraction` to balance and a ClientGame-emitted
`localLowHealthChanged { low: boolean }` bus event that both Ui and audio consume. tech-lead adds it in revision 2.
Until then, set audio to 30 so the two agree.

**m6. The dev tool lives inside the sim folder.** `src/shared/sim/tools/matchReport.ts:18-22,342` imports
`game/levels`, `BALANCE` and `Date.now`. This is now allowed (ADR 0002 §6) on two conditions: no sim module imports
`tools/`, and the lint rule in M2 exempts that folder. Owner: game-developer (keep it out of production imports) and
build-engineer (lint exemption).

**m7. A sim test hard-codes island coordinates.** `src/shared/sim/World.test.ts:102` (`heightAt(0, -133, ISLAND)`).
Owner: game-developer.
The test breaks when level-designer moves the coast.
*Fix:* derive the point from map data (for example `-(ISLAND.islandRadius + k)` along an axis checked with
`heightAt < 0`), or use a fixture map from `testkit.ts`.

**m8. Bot loot scores are literals.** `src/shared/sim/bots.ts:416` (`medkit ? 30 : 22`) and nearby loot scoring.
Owner: game-developer (move them to `BOT_AI` so `bots.ai` can override them), game-designer (numbers).

**m9. UI death card length mirrors balance.** `src/ui/Ui.ts:40` (`DEATH_CARD_MS = 3000`) duplicates
`match.deathScreenSeconds`. ClientGame starts spectating from balance, so the card can close before or after the
camera switches. Owner: ui-ux-designer (read `hud.deathScreenSeconds` once game-developer fills it, Contract revision
1 #6).

**m10. `npm start` wraps the server in the tsx CLI.** `package.json:16`. Owner: build-engineer.
*Decision (ADR 0002 §5):* change it to `NODE_ENV=production node --import tsx server/index.ts`. That gives one process,
so SIGTERM reaches the graceful shutdown in `server/index.ts:51-52`. Update the BUILD.md table row.

**m11. One flaky or in-progress sim test.** `src/shared/sim/World.test.ts:454` ("an armed bot kills an idle human
in the open"; `killedAt` is -1, so the human is never killed within 10 s). It failed while game-developer was
changing bot pacing (`bots.ts`/`World.ts` modified 04:46). An earlier full run had one transient failure that did not
reproduce in three reruns. Owner: game-developer (finish the change and keep the test green). qa-tester should watch
for flakes in `server.integration.test.ts` under load.

## Nits

- `src/ui/hud.ts:522`: drop the `HudView & { cameraFovDeg?: number }` cast. The field is now in the contract.
  (ui-ux-designer)
- `src/ui/hud.ts:569,572`: damage arc "heavy" threshold `25` and vignette scale `40` are absolute HP. Express them as
  fractions of `maxHp`. (ui-ux-designer)
- `index.html:7`: `<title>Beach Survival PvP</title>` is player-facing and stale. Set `document.title = t('game.title')`
  in Ui ("Last One Dry"), or use the same string in index.html. (ui-ux-designer for Ui; build-engineer for index.html)
- `src/net/NetClient.ts:168`: `console.warn` on every malformed frame can flood the console at 20 Hz. Rate-limit it
  as the server does. (network-engineer)
- Move-vector normalisation runs three times (`server/validate.ts:29`, `World.ts:550`, `movement.ts:101`). The second
  `hypot` can return `1.0000000000000002`, so the server divides again and differs from the client by 1 ulp. That is
  harmless, but `len > 1 + 1e-9` in the sanitizers keeps client and server bit-identical. (network-engineer,
  game-developer)
- `LocalPlayerState.movement` is documented as "after applying `lastProcessedInputSeq`". With input repeat and merge
  it also includes repeated ticks. The doc comment in `types.ts` is tightened; no code change. (tech-lead, done)
- Per-frame allocations in `ClientGame.update` (`players.map`, `new Map(...)`, PlayerView objects) and in
  `SnapshotBuffer.sample` (a new players array). There are about 100 small objects per frame at 16 players, which is
  fine for M1. Pool them only if a profile shows GC pauses. (game-developer, network-engineer)
- ~~`ALLOWED_ORIGINS` is empty by default (any origin). Set it in the production deploy. (build-engineer)~~
  **Closed:** empty now means `self` in production and `*` in dev (`server/config.ts:62,81`, `server/origin.ts`).
  `*` in production logs a warning (`server/index.ts:37`). BUILD.md:29 still says "empty means any origin"
  (build-engineer: update it).

## Fixed in tech-lead files during this review

- `src/main.ts`: the rAF loop now schedules the next frame before running this one and catches and logs errors
  (rate-limited). Before, one throwing frame stopped the game permanently.
- `src/main.ts`: `audio.unlock()` now runs on every pointerdown and keydown (idempotent) instead of `once`. A context
  that stays suspended after the first gesture now recovers without relying on audio's document listeners.
- `src/main.ts`: wires `Settings.quality` → `renderer.setQuality` (only on change) and `UiCallbacks.playUiSound` →
  `audio.playUi`.
- `src/shared/balance.test.ts`: new tests for `validateBalance`, covering required keys and the optional revision 1
  sections.

## Test quality

The tests are broad (535 tests) and mostly behavioural: sim determinism by seed, reconciliation replay, protocol
decode of hostile input, Room rate limits and stalls, settings persistence, audio graph with a fake context. Gaps:
m2 (prediction against the real World), M1 (input starvation), the M4 context-loss path, and an E2E check that two
browser clients see each other move. qa-tester owns the last one in `tests/e2e`.
