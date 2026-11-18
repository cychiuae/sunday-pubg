# M2a "Arsenal & Stance" test report (2a-D1)

Owner: qa-tester. Build: working tree 2026-11-18 (no git). Plan: [TEST_PLAN.md](TEST_PLAN.md). Bugs: [bugs/](bugs/).

## Summary

| Suite | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | see "Run log" |
| Unit + integration | `npx vitest run` | see "Run log" |
| E2E | `npm run e2e:local` | see "Run log" |

New QA files for M2a:
- `tests/sim/m2a-acceptance.test.ts`: acceptance criteria without an exact owner test (15 tests).
- `tests/sim/m2a-edge.test.ts`: exploratory edge cases (25 tests, including 8 seeded all-bot island matches and two
  `it.fails` for BUG-010).
- `tests/render/prone-hitbox-match.test.ts`: posed chibi vs sim hitbox (BUG-008; two `it.fails` that turn red once
  the bug is fixed, so whoever fixes it flips them to `it`).
- `tests/static/no-hardcoded.test.ts`: M2a balance keys added to the hard-coded-number scan; item-name strings.
- `tests/e2e/m2a.spec.ts` (10 tests), `tests/e2e/m2a-soak.spec.ts` (60 s soak), `tests/e2e/m2a-latency.spec.ts`
  (100 ms RTT), `tests/e2e/settings-seg.spec.ts` (segmented settings show one selection),
  `tests/e2e/support/drive.ts` (walk/pickup helpers).
- Updated: `tests/e2e/support/observer.ts` (unpacks the M2a anim bitmask, new PlayerState fields, grenades),
  `tests/e2e/support/stack.ts` (QA ports 8800-8999 / 5300-5399 only), `tests/e2e/gameplay.spec.ts` (armor -> vestTier,
  new guns), `tests/sim/zone-collapse.test.ts` (vest instead of armor), `tests/integration/pvp-over-ws.test.ts`
  (explicit timeouts on wall-clock tests).

## Update 2026-11-18 (M2b Phase D)
The M2a pass was stopped part-way; it is completed in the M2b round (see [M2b-test-report.md](M2b-test-report.md)):
- All six bugs are closed: BUG-005 not applicable (stance.md AT7/AT7b); BUG-006, BUG-007, BUG-008, BUG-009 and BUG-010
  fixed and verified (notes in each bug file).
- QA residue: map fixtures typed `IslandMapData` after the MapData union; the four `it.fails` (BUG-008 x2 with precise
  `setFromObject(mesh, true)` bounds, BUG-010 x2) are plain `it`; the prone title says 0.6 m; the stale BUG-007 note
  is an assertion; `tests/static/sim-purity.test.ts` also forbids `src/shared/kits/**` in the sim import closure.
- M2a E2E (`m2a.spec.ts`, `m2a-latency.spec.ts`, `m2a-soak.spec.ts`) now runs through rooms, the carrier drop and the
  first-person camera: on-foot FOV is the FP vertical FOV (50.5 deg), scoped FOV = 8x magnification of it (6.75 deg),
  and the unscoped view is `firstPerson` (not a third-person boom). Results: M2b report "Run log".
- The pacing note below is the M2a measurement; M2b pacing (both maps) is in the M2b report.

## Bugs filed in this pass
| Bug | Severity | Owner | Title |
|---|---|---|---|
| [BUG-008](bugs/BUG-008.md) | major | game-designer + graphics-designer | Crouched and prone chibis stick out above their hitboxes |
| [BUG-010](bugs/BUG-010.md) | major | game-developer (tech-lead for the rule) | A > 200 ms input stall refires semi-auto guns and drops server ADS |
| [BUG-005](bugs/BUG-005.md) | minor | level-designer + game-designer | Headroom can never fire on the island ("hut roof" case unreachable) |
| [BUG-006](bugs/BUG-006.md) | minor | network-engineer | Server integration tests wait longer than their Vitest timeout (flaky under load) |
| [BUG-007](bugs/BUG-007.md) | minor | narrative-designer | Stale M1 `item.vest.*` strings in en.json |
| [BUG-009](bugs/BUG-009.md) | minor | ui-ux-designer | "Helmet" label overflows its HUD cell at 960x540 |

## Traceability

Status: **pass** = the listed test ran and passed in the final run; **manual** = needs a human (TEST_PLAN.md
"M2a additions"); **bug** = a filed bug. File abbreviations: `W2a` = `src/shared/sim/World.m2a.test.ts`, `W` =
`src/shared/sim/World.test.ts`, `St` = `src/shared/sim/stance.test.ts`, `Gr` = `src/shared/sim/grenade.test.ts`,
`Cb` = `src/shared/sim/combat.test.ts`, `Inv` = `src/shared/sim/inventory.test.ts`, `Lt` = `src/shared/sim/loot.test.ts`,
`Bal` = `src/shared/balance.test.ts`, `QA` = `tests/sim/m2a-acceptance.test.ts`, `QE` = `tests/sim/m2a-edge.test.ts`,
`E2E` = `tests/e2e/m2a.spec.ts`. Numbers after a file are line numbers of the `it(`.

### combat.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Rifle falloff 19 / 15.675 / 12.35 / miss at 151 m | Cb:11, W:217 | pass |
| 2 | Standing target: y 1.0 head 34.2, y 0.7 body 19 | W:239 (head), QA "AT2" (both) | pass |
| 3 | Three rifle headshots kill; two leave 31.6 | QA "AT3" | pass |
| 4 | Shotgun point-blank leaves 1 HP; second kills | W:258, Cb:92 | pass |
| 5 | Shotgun 5 head + 4 body vs helmet_2 + vest_2: 33 / 17.6 / 75.9, one event | W2a:111 (routing), QA "AT5" (exact numbers on an observed 5/4 split) | pass |
| 6 | Semi-auto pistol one shot; sniper bolt 1000 / 1400 ms | W:273, W2a:45; QE "input stalls" | pass (BUG-010 fixed; its two QE tests are plain `it` now) |
| 7 | Reload 3/12 + 5 -> 8/12, 0 | W:284, Inv:22 | pass |
| 8 | Swap during reload keeps mag | W:300 | pass |
| 9 | Bandage 70->75, refused at 75, medkit 30->100 | W:339, Inv:10 | pass |
| 10 | Fire cancels heal; Q during reload | W:355, W:312 | pass |
| 11 | Full inventory pickup drops slot-2 gun with mag | W:381, Inv:38 | pass |
| 12 | Light ammo 170+30 takes 10; sniper 18+5 takes 2 | Inv:55, Inv:99, QA "AT12 (world)" | pass |
| 13 | ADS spread 0.8 / 1.2522 / release | St:195, Cb:41 | pass |
| 14 | ADS blocks (reload, swap, heal, fists, grenade) | St:206, W2a:154, QE "ADS blocked while healing ... reloading" | pass |
| 15 | ADS vs sprint: 3.25 m/s, release resumes sprint | St:219, QE (same test), E2E "ADS while sprinting" | pass |
| 16 | Spread combinations (sniper prone 0.072, LMG 2.808) | Cb:41 | pass |
| 17 | LMG fire slow 2.75 m/s, back to 5.0 after 300 ms | W2a:145, St:226, QE "LMG fire slow stacks with ADS ... switch" | pass |
| 18 | Sniper rules vs helmets/vest at 10 m and 250 m | W2a:56, Cb:79, Bal:149, QE "sniper headshot vs helmet_3" | pass |
| 19 | Shots-to-kill table | W2a:78 | pass |
| 20 | DMR 42 / 73.5 at 40 m, 33.6 at 180 m+ | W2a:135 | pass |
| 21 | Cross-references to stance/armor/grenades | (below) | n/a |
| 22 | Pacing 330-480 s, no gun > 35 %, rifle 15-30 % | `matchReport` (game-designer 2a-D3); QA run in "Pacing" below | see Pacing |

### stance.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Crouch transition 6 ticks; crouch walk 2.75 | St:48 | pass |
| 2 | Crawl 1.25; in 0.18 m water 0.75 | St:59 | pass |
| 3 | Crouch + sprint starts crouch_stand; 7.2 only after settle | St:65 | pass |
| 4 | Space: jump / crouch->stand / prone->crouch | St:74, E2E "C crouch, Z prone, Space ..." | pass |
| 5 | Z at 0.3 m, C at 0.6 m refused tooDeep | St:87, W2a:203 | pass |
| 6 | Prone into > 0.2 m water forces prone_stand (700 ms) | St:96, QE "prone, crawling into deep water" | pass |
| 7 | Headroom under a raised collider (C ok, Space refused, Z falls back) | St:110 (synthetic slab); QE "hut ...", "raised palm ..." | pass (rule); BUG-005 closed as not applicable (stance.md AT7b) |
| 8 | No shots during a transition; pistol click dropped | W2a:169 | pass |
| 9 | ADS stays 0 during a transition, ramps after | St:206, QA "AT9 (world)" | pass |
| 10 | Crouch hitbox: 0.9 head, 0.4 body, 1.0 miss | St:168, `tests/render/prone-hitbox-match.test.ts` | pass (BUG-008 fixed) |
| 11 | Prone box rays, yaw 0 and 90 | St:174, QE "prone hitbox vs a crawling target" (World yaw), `tests/render/prone-hitbox-match.test.ts` | pass (BUG-008 fixed; prone height 0.6 m) |
| 12 | During stand_prone the standing cylinder applies | St:186 | pass |
| 13 | Eye lerp 0.70 at 300 ms into stand_prone | St:152, `src/game/camera.test.ts`:58, E2E (settled eye 1.05 / 0.72 / 0.35) | pass |
| 14 | Requests while airborne/dropping ignored; spawn standing | St:144, QA "AT14" | pass |
| 15 | Z 100 ms into stand_crouch ignored | St:144 | pass |
| 16 | Prediction equals server (no correction) | St:237, `src/game/prediction.test.ts`:144, E2E (lastCorrection 0.000 m), `m2a-latency` at 100 ms RTT | pass (BUG-010 fixed) |
| 17 | Heal and reload continue through C and Z | W2a:189 (heal), QA "stance.md AT17 (reload half)" | pass |

### armor.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | vest_2 55: hits 30 / 100 / 10 -> 82 / 22 / 15, break event | Cb:24, W:247, QA "AT1 (world)" | pass |
| 2 | Head hit never touches vest; body never helmet | QA "AT2" | pass |
| 3 | Zone and fall damage leave armor unchanged | W:481 (zone), QA "AT3" (fall), `tests/sim/zone-collapse.test.ts` | pass |
| 4 | Grenade 50 vs vest_1 35 + helmet_3 75 -> 15 / 65 / 20 / 75 | QA "AT4" | pass |
| 5 | vest_1 at 20 -> pick vest_2, vest_1 drops with 20 | W2a:235, Inv:71 | pass |
| 6 | Same or lower tier refused betterArmor | W2a:247, Inv:71, QE "helmet swap ... picking it back up is refused" | pass |
| 7 | helmet_1 at 12 worn at 12 | W2a:247, Inv:71 | pass |
| 8 | Death drops armor with durability; destroyed piece drops nothing | W:434, Inv:117, QA "AT8" | pass |
| 9 | Tiers public, durability owner-only | W2a:209, `src/shared/protocol/m2a.test.ts`:137 | pass |
| 10 | vest_3: 9 rifle hits leave 4 HP, 10th kills | W2a:258 | pass |
| 11 | durability < 100 f / (1 - f), tier matches id | Bal:141 | pass |
| 12 | Same-tick placement by hp + vest + helmet | W2a:268 | pass |

### grenades.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Throw speeds by pitch; first contact 8.0 +- 0.5 m | Gr:29, Gr:47 | pass |
| 2 | Prone throw 13.2 | Gr:43 | pass |
| 3 | Cook-out at 3500 ms; vest_2 leaves 28 / 7 | W2a:302, QE "cook-out in hand with vest_3 survivor" | pass |
| 4 | Release after 1000 ms cook: 2500 ms fuse | W2a:326 | pass |
| 5 | Falloff 120 / 102 / 79.5 / 57 / 34.5 / 12 / 0 | Gr:179, W2a:343 | pass |
| 6 | LOS: crate blocks, bush and players do not | W2a:343 | pass |
| 7 | Vest absorbs 31.8, helmet untouched | W2a:343 | pass |
| 8 | Self-damage and kill credit | W2a:370 | pass |
| 9 | Kill after owner's death credits owner | W2a:382, QE "shot dead while cooking" | pass |
| 10 | Swap after 1000 ms cook drops a 2 m/s grenade | W2a:395, Gr:63, QE "switching to fists", "EMPTY gun slot" | pass |
| 11 | Death while cooking drops at the eye | W2a:409, QE "shot dead while cooking", "disconnect while cooking" | pass |
| 12 | Bounce events, ~35 % rebound, rest within 4 contacts, none below 2 m/s | Gr:72, QA "AT12 (world)" | pass |
| 13 | Water: one water contact, seabed rest, 79.5 +- 1 at 3 m | Gr:96, QA "AT13 (world)" | pass |
| 14 | Determinism | Gr:142, W2a:459 | pass |
| 15 | Slot 4 with 0 grenades refused; last throw auto-switches | W2a:421, E2E "slot 4 and G ...", QE "cooking the last grenade into a cook-out" | pass |
| 16 | Carry limits (3 full, 2 + 2 -> 3 and 1 left) | Inv:90, QA "AT16 (world)" | pass |
| 17 | Match end removes live grenades, no explosion | W2a:436 | pass |
| 18 | While cooking Q/R/E do nothing; stance works | W2a:447, QE "a stance toggle mid-cook" | pass |
| 19 | Bot throws at a covered target 8-30 m | W2a:520, QE bot matches (22 throws in 8 matches) | pass |

### loot.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | spawnChance 1: one item + ammo extras | Lt:11 | pass |
| 2 | Frequencies within 2 % over 10,000 rolls | Lt:34, Lt:61 | pass |
| 3 | Rifle/sniper/LMG spawn ammo and mags | Lt:11, Lt:78, Lt:87 | pass |
| 4 | Epic never yields pistol/light/heavy/shell/vest_1/helmet_1 | Lt:49 | pass |
| 5 | Tier-3 armor never from common/rare | Lt:49 | pass |
| 6 | Spawned durability and grenade qty | Lt:78 | pass |
| 7 | No M1 `vest`; unknown ids rejected | Lt:103, Bal:116, `tests/static/no-hardcoded.test.ts` (no `item.vest.*` strings) | pass (BUG-007 fixed) |

### Production board criteria (2a-C*) checked by QA
| Task | Criterion | Evidence | Status |
|---|---|---|---|
| 2a-C1 | Prone hitbox along yaw; headroom rule (stance.md AT7 on a synthetic slab; AT7b: N/A on the shipped maps, BUG-005 decision); deep water auto-stand; determinism | St:110, St:174, QE, `src/game/levels/office.test.ts` stance gaps | pass |
| 2a-C2 | ADS blocked sprint/reload/heal/swap; sniper through helmet_2; tier swap drops old | St:206, W2a:56, W2a:235, QE | pass |
| 2a-C3 | Same seed same path; props block LOS; cook-out; kill credit | Gr:142, W2a:343/302/370 | pass |
| 2a-C4 | 16-bot match one winner; bots throw grenades and get sniper/dmr kills | W:734, QE "over 8 seeded matches" (throws 22, sniper 6 + dmr 17 kills, lmg 4) | pass |
| 2a-C5 | New binds work, Ctrl unbound, no rubber-banding at 100 ms | `src/game/input/InputState.test.ts`:187-218, E2E, `m2a-latency.spec.ts` | see Run log |
| 2a-C6 | Round trips, bad stanceToggle dropped, 8 KB budget | `src/shared/protocol/m2a.test.ts` | pass |
| 2a-C7 | Iron/red dot zoom; scope view after adsTimeMs; sensitivity scales | `src/game/camera.test.ts`, E2E (FOV 8.75, firstPerson, `.ui-scope.is-in`, scoped look) | pass; 60 fps scoped is **manual** |
| 2a-C10 | HUD vest/helmet/grenade/stance; settings persist | `src/ui/logic.test.ts`, E2E HUD + settings | pass |

## Exploratory findings (tests/sim/m2a-edge.test.ts, tests/render, E2E)
23 pass and 2 are expected failures documenting BUG-010. What they show:
- **BUG-010 (major):** an input gap over `MAX_INPUT_REPEAT_TICKS` (200 ms) while LMB is held makes the server inject
  `fire: false`; the next real input is a new trigger edge, so a semi-auto gun fires twice for one press (dmr sim
  test: 2 shots; E2E: one 120 ms click on the shotgun gave "mag 5 -> 3, shot events 0 -> 2"). The same neutral input
  resets server ADS while the client stays scoped.
- **BUG-008 (major):** the crouched chibi's head top is ~1.24 m against a 0.95 m crouch cylinder, and the prone head
  spans y 0.18-0.86 m against a 0.5 m prone box (`tests/render/prone-hitbox-match.test.ts`).
- Prone into deep water: one forced `prone_stand` (public `stanceChange`, `forced: true`), then Z there is refused
  `tooDeep`; no NaN in the movement state.
- Hut: a prone player against any hut wall can stand (no false `noHeadroom`); no hut part can be stood under
  (BUG-005).
- Cook-out survivor keeps the grenade slot and can cook again after `throwRecoveryMs`; a cook-out of the last
  grenade auto-switches to the last gun.
- Selecting an EMPTY gun slot while cooking is ignored (the cook continues, release throws). Selecting fists drops
  the grenade with the remaining fuse.
- Shot dead or disconnected while cooking: the grenade drops and still explodes; a later kill credits the dead owner.
- A pin pull is refused during a stance transition (`isStanceSettled`), accepted after it.
- Grenades bounce off crate faces (surface `prop`) and never end up inside a hut.
- ADS: healing and reloading keep `adsMs` at 0; sprint + ADS walks at walk x adsMove; LMG fire slow stacks with ADS
  (5 x 0.5 x 0.55) and stops after switching guns.
- Prone sniper at 100 m with full ADS hits a prone target 5 of 5 times.
- Rapid C/Z/Space/sprint/ADS mashing for 600 ticks: no NaN, never negative timers, settles afterwards.
- Prone chibi footprint (x +-0.27, z -0.55..0.64) fits the 0.8 x 1.5 m box; the head mesh centre (z -0.23) sits just
  behind the head zone's back edge (-0.25), so the back of the visible head counts as a body hit (part of BUG-008).
- 8 seeded all-bot island matches: no NaN in any snapshot; 36 bots seen in helmets, 50 in vests, 22 grenade throws,
  22 explosions, 40 stance changes; kills by weapon `{"shotgun":21,"smg":33,"sniper":6,"rifle":25,"dmr":17,"lmg":4,
  "pistol":13,"fists":1}` (rifle 21 % of weapon kills). No grenade kill in 8 matches (not a criterion; noted for D3).

## Flakiness
- Full suite measured on a quiet machine: the slowest tests are wall-clock socket tests (pvp-over-ws fight 20.9 s,
  fire-rate hack 3.2 s, server integration "two clients join" 2.5-2.7 s, speed hack 2.2 s, transport 1.4-1.8 s). All
  sim tests are below 1 s (16-bot matches 0.4-1.0 s).
- Likely source of the one unexplained failure: `server/server.integration.test.ts` "two clients join ..." has the
  5 s default timeout but waits up to 6 s internally plus a 2.5 s input drive (BUG-006, network-engineer).
  The same risk existed in QA's `tests/integration/pvp-over-ws.test.ts` cheating-client tests (3.2 s of sleeps against
  5 s); QA gave them explicit 15-20 s timeouts.
- No test uses `Math.random` in assertions; the sim purity test also bans `Date.now` / `performance.now` in sim.
- Reproduction attempt: two full `npx vitest run` in parallel while `matchReport` ran (3 CPU-heavy jobs): both
  68 files / 1204 passed / 4 expected-fail, no timeouts. The flake did not reproduce here, so BUG-006 is a
  likely cause, not a proven one.
- E2E harness flakes found and fixed in QA files: `gameplay.spec.ts` walked into a palm trunk (the M2a loot tables
  moved the nearest gun) and, on a slow page, landed before W was held during the drop. Walking now side-steps when
  it stops making progress (`gameplay.spec.ts`, `support/drive.ts`), and W is held from the start of the drop.
- One unexplained observation (not reproduced in 2 reruns): in one `gameplay.spec.ts` run the freshly picked shotgun
  showed mag 1/5 before the test ever pressed LMB. If it recurs, check it against BUG-010.

## Requested test hooks
None needed for M2a: loot overrides (`BALANCE_OVERRIDE` loot tables) give the E2E player a sniper and grenades
through real pickups. A server-side loadout hook (e.g. `E2E_LOADOUT='{"slots":["dmr","lmg"],"grenades":3,
"vest":2,"helmet":3}'` applied on spawn, dev only) would make E2E for dmr/lmg/rifle ADS (4x scope, red dot) and armor
breaks cheap; owner network-engineer if wanted.

## Pacing
`npx tsx src/shared/sim/tools/matchReport.ts --matches 30 --variant both` (27 s wall, 2026-11-18 09:4x):
| Variant | Median match | Weapon kill share (top) | Rifle | Grenade kills / match |
|---|---|---|---|---|
| idle human | 362 s (294-436) | rifle 29.6 %, smg 27.0 %, dmr 17.1 % | 29.6 % | 0.03 (1 in 30) |
| looter human | 363 s (279-418) | smg 31.5 %, rifle 25.4 %, dmr 14.1 % | 25.4 % | 0 |
Pass against combat.md AT22 (median 330-480 s, no weapon above 35 %, rifle 15-30 %). Note for game-designer (2a-D3):
the rifle sits at the 30 % ceiling in the idle variant; bots throw ~1.3-1.8 grenades per match but grenades kill
almost nobody (1 kill in 60 matches); helmet_3 pickups are rare (11-14 per 30 matches).

## Run log
Superseded by the M2b round: see [M2b-test-report.md](M2b-test-report.md) "Run log" (the same commands, after the C-gate).
