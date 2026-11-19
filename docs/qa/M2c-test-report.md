# M2c "Fresh Every Match & Bigger Arsenal" test report (Phase 3)

Owner: qa-tester. Build: working tree 2026-11-18 after the M2c C-gate (PROTOCOL_VERSION 4, rows snapshots, balance v7),
no git. Plan: [TEST_PLAN.md](TEST_PLAN.md). Bugs: [bugs/](bugs/). Earlier milestones: [M2b-test-report.md](M2b-test-report.md).

## Summary

| Suite | Command | Result (see "Run log") |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | exit 0 |
| Unit + integration | `npx vitest run` | 107 files, 2138 passed, 1 expected-fail (BUG-015), 1 skipped, 0 failed |
| E2E full suite | `npm run e2e:local` (59 tests, 27.5 min) | 41 passed, 6 failed, 12 did not run (serial dependents); every failure is harness steering / timing (see Run log). Not a clean run. |

New QA files for M2c:
- `tests/sim/m2c-gaps.test.ts` (26 tests): acceptance criteria with no exact owner test (armor tier 4, loot M2c, combat
  23-28, melee 9, rpg 8 bystander, smoke 6 / 7 / 10 / 14, scopes 9 / 10, levels 12 / 14).
- `tests/sim/m2c-layout-qa.test.ts` (5 tests): layout.md AC 2-3 measured over 202 seeds per map (1 `it.fails`: BUG-015).
- `tests/e2e/m2c-layout.spec.ts`: REVIEW-M2c MF2, layouts built in Chromium vs Node for 12 seeds on both maps.
- `tests/e2e/m2c.spec.ts` (7 tests, island, `LAYOUT_SEED=4821`, two browsers), `tests/e2e/m2c-office.spec.ts` (4 tests,
  office, `LAYOUT_SEED=4821`), `tests/e2e/m2c-seeds.spec.ts` (6 tests: 3 random seeds per map, screenshots + draw calls).
- Support: `tests/e2e/support/layout-node.ts`, `tests/e2e/support/office-panes.ts`, `stack.ts` (`layoutSeed` option).
- Updated: `tests/sim/m2b-edge.test.ts` (BUG-011 / BUG-012 flipped to `it`; the monitor detail test rewritten for
  `noStand`; the office loot pin replaced by a structural check, the designer owns the numbers).

## Bugs
| Bug | Severity | Owner | Status |
|---|---|---|---|
| [BUG-011](bugs/BUG-011.md) | minor | level-designer + graphics-designer | **closed** (fixed: thin screens are `noStand`; 0 of 2880 perch jumps land) |
| [BUG-012](bugs/BUG-012.md) | minor | game-developer | **closed** (fixed: clamp on the toggle tick) |
| [BUG-013](bugs/BUG-013.md) | minor | game-designer | **closed** (balance v7: island rifle 20-27 %, office 19-26 %) |
| [BUG-014](bugs/BUG-014.md) | minor | game-developer | **closed** (hook fields verified in the browser) |
| [BUG-016](bugs/BUG-016.md) | - | - | **closed, not a bug** (QA harness: B had been killed by repeated knife swings before the smoke check) |
| [BUG-015](bugs/BUG-015.md) | minor | level-designer (+ game-designer for wording) | **closed** (fixed: 2 candidates; AC 2 rewritten) |

## Traceability

Status: **pass** = the listed test ran and passed in the final run; **manual** = needs a human (TEST_PLAN.md "M2c
additions"); **bug** = filed. Abbreviations (number = line of the `it(`): `Lv` levels.test, `Me` melee.test,
`Rk` rockets.test, `Sm` smoke.test, `Sc` scopes.test (all `src/shared/sim/`), `Bt` `src/shared/sim/bots.m2c.test.ts`,
`Bg` `src/shared/sim/bugs.m2c.test.ts`, `WC` `src/shared/sim/World.m2c.test.ts`, `M2` `src/shared/m2c.test.ts`,
`Pr` `src/shared/protocol/m2c.test.ts`, `Ly` `src/game/levels/layout/layout.test.ts`, `LL` `server/layoutLock.test.ts`,
`CG` `src/game/ClientGame.m2c.test.ts`, `MC` `src/game/m2cClient.test.ts`, `HB` `src/game/hudBuilder.test.ts`,
`UI` `src/ui/m2c.test.ts`, `RD` `src/render/m2c.test.ts`, `RP` `src/render/procedural/m2c.test.ts`,
`AU` `src/audio/m2c.test.ts`, `QG` `tests/sim/m2c-gaps.test.ts`, `QL` `tests/sim/m2c-layout-qa.test.ts`,
`QB` `tests/sim/m2b-edge.test.ts`, `E-C` `tests/e2e/m2c.spec.ts`, `E-CO` `tests/e2e/m2c-office.spec.ts`,
`E-L` `tests/e2e/m2c-layout.spec.ts`, `E-S` `tests/e2e/m2c-seeds.spec.ts`.

### levels.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | L1 effective stats equal `weapons.<id>` | M2:138 | pass |
| 2 | Rifle body L1-L4 19 / 20.52 / 22.04 / 23.75; reload 2400 / 2040 | Lv:20, Lv:37 (World) | pass |
| 3 | Pistol L4 25: 4 body hits kill, 3 leave 25 | Lv:27 | pass |
| 4 | Shotgun L4 pellet 11, spread 5.46, pump 765, point blank leaves 1 | Lv:27 | pass |
| 5 | Sniper L4 body 96; head vs helmet_3 dead, vs helmet_4 8 HP; bolt 1120 | Lv:27, QG:61 | pass |
| 6 | DMR L4 48.3, two body leave 3.4, 320 ms | Lv:27 | pass |
| 7 | Knife L4 42.5 / 280 / 80 | M2:148, Me:184 | pass |
| 8 | 10,000 rolls per tier match `levels.lootTiers`; common never L4 | Lv:58 | pass |
| 9 | Dropped on death / swap / upgrade swap keeps level and mag | Lv:70, Lv:85, Me:167 (melee on death), Sc:116 (gun + scope on death) | pass |
| 10 | Upgrade swap rules; L1 rifle into the empty slot | Lv:85, QG:287 | pass |
| 11 | Validation (length 3, L1 1.1, fists override) | M2:98 | pass |
| 12 | Remote held level and ground pickup level in the snapshot | QG:450, Pr:271; E-C:169 (HUD badge "2" = server weaponLevel 2) | pass |
| 13 | Bot takes an L2 rifle over its L1 | Bt:151 | pass |
| 14 | L4 design invariants in balance | QG (levels.md 14 block, last test) | pass |

### melee.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Knife 34 at 100 ms; holding 100 / 450 / 800, third kills | Me:50 | pass |
| 2 | Machete vs vest_2: 3 hits; 37.6 / 13.4 after 2 | Me:67 | pass |
| 3 | Paddle head 117; helmet_1 leaves 13 | Me:79 | pass |
| 4 | Paddle knockback ~7 m/s, >= 2.5 up; prone horizontal only | Me:92 | pass |
| 5 | Sweep 0.7 / 0.8 m off; never a headshot | Me:115 | pass |
| 6 | Reach 2.1 m: knife out, machete in | Me:128 | pass |
| 7 | Crate blocks | Me:137 | pass |
| 8 | Nearer of two targets | Me:145 | pass |
| 9 | Swap or death during the wind-up: no damage | Me:158 (swap), QG:304 (death) | pass |
| 10 | Melee pickup swaps and drops with level; death drops it | Me:167 | pass |
| 11 | Knife breaks glass; rifle through the opening; intact pane stops a pistol | Me:205, Bg (walking through a broken pane); E-CO knife test: in one browser run the knife broke office pane 34 (`glassBroken` cause melee, `brokenPanes [34]`) | pass (sim); browser: break observed once, walk-through not achieved (harness steering in the office) |
| 12 | Knife L4 cycle 280, hit 80 ms | Me:184 | pass |
| 13 | Bots: machete hit within 1 s; empty SMG -> knife | Bt:52, Bt:66 | pass |
| 14 | Kill feed names weapon and level | QG:254 (kill event `knife`, level 3), UI:306 (feed routing) | pass |

### rpg.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Level shot lands ~53.8 m | Rk:37, M2:225 | pass |
| 2 | Air burst after 120 m | Rk:50 | pass |
| 3 | Direct hit 40 + 110, dead | Rk:60 | pass |
| 4 | Direct on vest_2: 76 / 39 then 5, vest gone | Rk:60 | pass |
| 5 | L4 direct: vest_2 dead; vest_3 2.5 | Rk:86 | pass |
| 6 | Splash 63.25 at 3 m; crate 0; helmets unchanged | Rk:99 | pass |
| 7 | Dud at 3 m: 40, no explosion | Rk:129 | pass |
| 8 | Arming 5.4 / 5.8 m; self damage; bystander 1 m from a direct hit | Rk:140, QG:330 (bystander) | pass (the "shooter moves 3 m toward the blast" self-kill variant is not separately tested) |
| 9 | Glass: glassBroken then explosion; blast through the opening | Rk:159 | pass (sim); the browser rocket-on-glass test never ran (blocked by the melee step's walking) - **manual** |
| 10 | Reload 3800 / 3040 ms | Rk:176 | pass |
| 11 | Determinism | Rk:187 | pass |
| 12 | Client draws from `rocketFired` within 0.2 m | MC:221 (closed form `rocketPosAt`), CG:231 | pass |
| 13 | Bots fire at 25 m, never at 8 m | Bt:81 | pass |

### smoke.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Throw speed 15, pitch 8, first contact 8 m | Sm:36 | pass |
| 2 | Not cookable; deploy 1800 ms after release | Sm:55 | pass |
| 3 | Cancel with 1 | Sm:81 | pass |
| 4 | Radius over time (0 / 3.25 / 6.5 / 3.25 / gone) | M2:197 | pass |
| 5 | Bot LOS through and beside a cloud; inside rules | M2:208, Bt:123 | pass |
| 6 | Rifle shot through a cloud hits for full damage | QG:361 | pass |
| 7 | Frag inside a cloud: 79.5 at 3 m | QG:369 | pass |
| 8 | 13th cloud fades the oldest | Sm:92 | pass |
| 9 | Water deploy at y = 0 | Sm:102 | pass |
| 10 | Late join receives the cloud at full radius | QG:383 (sim snapshot), Pr:162 (carry-forward), MC:270 | pass |
| 11 | Client: name tag hidden behind a cloud; body markers hidden, kills shown; victim arc | CG:252, MC:279, UI:268, `ClientGame.m2c.test.ts` (alive / dead / camera-subject cases); E-C smoke test + "smoke.md 11" test | pass: both browsers report `smokeHidden: true` for the other with a cloud on the line (2 runs) |
| 12 | Bot throws on Retreat, cloud near the 4 m point | Bt:100 | pass |
| 13 | Death drops two stacks | Sm:106 | pass |
| 14 | Determinism | QG:397 | pass |

### scopes.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Defaults unchanged | Sc:22, M2:138 | pass |
| 2 | Rifle + 4x: zoom 4, 345 ms, 0.674 deg, 2.76 m/s | Sc:30, M2:161 | pass |
| 3 | DMR / sniper scope numbers | Sc:30, M2:161 | pass |
| 4 | Hip cone and damage unchanged | Sc:30 | pass |
| 5 | Pickup rules incl. `scopePouchFull` | Sc:49, MC:29 | pass |
| 6 | DMR + 4x goes to the pouch | Sc:61 | pass |
| 7 | T: 600 ms exchange, remove, refusals | Sc:70, MC:178; E-C:186 (T to the pouch and back, server sight) | pass |
| 8 | Scope travels with the gun; spare drops | Sc:116 | pass |
| 9 | Remote sight `scope_4x`; glint at 4x, none at 2x | QG:419 (sight); glint is render **manual** | pass (sight) |
| 10 | 10,000 rolls: scope weights; tier rules | QG:429 | pass |
| 11 | Bot mounts a 4x and engages at 55 m; ignores pouch-only scopes | Bt:138 | pass |
| 12 | Validation | M2:119 | pass |

### layout.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Server and client builds give the same layout (hash) | Ly:345 (golden + rebuild), E-L:26 (Chromium vs Node, 24 map/seed pairs, layoutHash and the full-layout digest equal), E-C:95 (two browsers, no mismatch) | pass |
| 2 | Tier totals exact; per-group rules (rewritten after BUG-015) | Ly:460 / Ly:599, QL (202 seeds: 51/19/7 + 12 guaranteed, 50/20/8 + 16; island POI groups exact, beach ring 12 x 2 + 12 x 1 alternating; office epic / rare / guaranteed exact, plain commons sum 34) | pass |
| 3 | Every group >= ceil(use x 1.5) and >= use + 1 candidates | QL (measured over 202 seeds, every group) | pass (BUG-015 fixed) |
| 4 | Loot >= 2 m apart, outside colliders, reachable | Ly:460, Ly:484, Ly:599 | pass |
| 5 | Cover parity (min >= 0.8 x max footprint) | Ly:534 / Ly:822 (LV15 fairness band) | pass via LV15 (the 0.8 footprint ratio itself is not asserted separately) |
| 6 | Hard guarantees over 200 seeds | Ly:442-866 (LV3-LV13), nav walk (LV14), E-S (budgets) | pass (see LV rows) |
| 7 | `LAYOUT_SEED=4821` same layout on two runs; Esc panel and results show 4821 | LL:102 (a pin always hits), E-C:95 ("Layout #0x000012D5" = 4821 on both browsers' pause overlay) | pass (pause); results screen **manual** |
| 8 | Pacing with random layouts: median 330-480 s; zone deaths <= fixed + 0.5 | matchReport `--layout-seeds 30` (section "Pacing") | pass |

### grenades.md 20-26 (throwable slot)
| # | Test(s) | Status |
|---|---|---|
| 20 | Sm:119; E-C:207 (4 cycles smoke <-> frag in the HUD) | pass |
| 21 | Sm:137 | pass |
| 22 | Sm:151 (G while cooking ignored; the key-1 drop rule is the M2a test W2a:395) | pass |
| 23-24 | Sm:161 | pass |
| 25 | Sm:173 | pass |
| 26 | Sm:137 (refused `noGrenades`); wheel skip: UI unit | pass |

### combat.md, loot.md, armor.md (M2c items)
| Spec # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| combat 23 | TTK table at L1 and L4 | Lv:27, M2:148 (per-weapon numbers); full table not parametrised | partial (spot values pass) |
| combat 24 | Revolver 3 body / 2 head; mag 6, 2600 ms; 22.8 at 60 m+ | QG:186 | pass |
| combat 25 | Double barrel per click; 120 at 1 m; two barrels vs vest_4; 2800 ms reload; 8-25 mean at 8 m | QG:205, QG:233 (mean 20.29) | pass |
| combat 26 | Knife kill names knife + level; rocket direct names rpg | QG:254, Rk:60 | pass |
| combat 27 | Key 3 melee slot (fists when none) | QG:268 | pass |
| combat 28 | Equal-level pickup fills the empty slot | QG:287 | pass |
| combat 29 | Pacing: median 330-480; no weapon > 35 %; melee and RPG kills > 0 | matchReport (section "Pacing") | pass |
| loot 8 | 10,000 rolls per tier, island and office merged | QG:112 | pass |
| loot 9 | Epic never yields the low items; epic-only items | QG:112 | pass |
| loot 10 | RPG spawn extras, melee, smoke qty 2, scope qty 1 / no level | QG:142 | pass |
| loot 11 | Level frequencies; common never L4 | Lv:58 | pass |
| loot 12 | Activated points per tier = lootUsedPerTier | QL, Ly:460 / 599 | pass |
| loot 13 | Mean item counts within 15 % of the table | matchReport prints pickups, not the per-category means | **manual / not measured** |
| loot 14 | Guaranteed weapons with spawnChance 0; mix and levels | QG:160, Lv:127 | pass |
| armor 13 | vest_4 absorb 27.5 | QG:54 | pass |
| armor 14 | Sniper L1 / L4 head vs helmet_4 | QG:61 | pass |
| armor 15 | vest_4 swap and `betterArmor` refusal | QG:73 | pass |
| armor 16 | Rifle L1 vs vest_4: 10 hits -> 10 HP, 11th kills | QG:97 | pass |
| armor 17 | Tier 0-4 in snapshot; HUD and model show tier 4 | Pr:271, UI:131, RP:216 | pass (unit); screen check **manual** |
| armor 18 | vest_4 / helmet_4 never from common / rare | QG:112 | pass |

### variety.md LV1-LV17
| LV | Evidence | Status |
|---|---|---|
| LV1 | Ly:345, E-L:26 | pass |
| LV2 | Ly:389 | pass |
| LV3 / LV4 / LV11 | Ly:442, Ly:577 | pass |
| LV5 / LV6 | Ly:460, Ly:484, Ly:599 | pass |
| LV7 / LV8 | Ly:640 (office), Ly:484 (island ring) | pass |
| LV9 | Ly:667 | pass |
| LV10 | Ly:499, Ly:706 | pass |
| LV12 | Ly:775 | pass |
| LV13 | Ly:517, Ly:823 | pass |
| LV13b | E-S (3 seeds per map; max draw calls sampled aboard, during the drop and while looking around): office 99-111 (<= 150), island 76-92 (<= 250), triangles <= 326k | pass for the sampled views (not an exhaustive worst-view search; 12 players, no clouds) |
| LV14 | Ly:865 (30 seeds, nav graph reachability); nav walk `matchReport --map office --layout-seeds 30 --nav-walk 120`: pooled 0.37 %, worst seed 2.62 % (0x98f01fc5), 0 seeds > 5 % | pass on 30 seeds; the 200-seed MF1 run is pending from the game-developer |
| LV15 | Ly:535, Ly:823 | pass |
| LV16 | Ly:887 | pass |
| LV17 | matchReport `--layout-seeds 30` both maps | pass |

### UI M2C-UI-01..42 (docs/ui/M2c.md)
Vitest-backed (owner `src/ui/m2c.test.ts`, `src/game/hudBuilder.test.ts`): 01 (UI:73), 05 (UI:90), 07 / 08 / 10 (UI:139-190),
11 (UI:217), 19 (UI:297, UI:336), 22 (UI:268), 27 (minimap rebuild: owner unit), 32 / 42 (UI:388), 33 (UI:235), 34 (UI:190,
MC:29), 38 (UI:256), 39 (UI:283) - **pass**.
Browser-checked by QA E2E: 02 (E-C:169 slot badge numeral = server level), 12 (E-C:207 key 4 cycles the slot within the
spec, timing not measured), 28 (E-C:77 look line after the lock, identical on two browsers; E-C:95 "Layout #" on pause),
36 (E-C:186 T switch reaches the pouch and back) - **pass**.
**Manual** (visual, layout, accessibility, reduced motion, touch; not automatable without hooks or pixel checks): 03, 04,
06, 09, 13, 14, 15, 16, 17, 18, 20, 21, 23 (name tags in smoke; BUG-014), 24, 25, 26, 29, 30, 31, 35, 37, 40, 41.

### Audio M2c §12
Every non-"(ear)" criterion (AC-SC1-2, AC-M1-4, AC-G1-3, AC-R1-2, smoke, look and level ACs) is covered by the owner's
`src/audio/m2c.test.ts` (AU:68-391) and `src/audio/AudioDirector.test.ts`; they pass in the unit run. The "(ear)" items
(AC-SC3, AC-M5, AC-G4 and the like) are **manual**.

### Art / narrative M2c
No numbered acceptance lists. Covered by owner tests: per-level models keep anchors and length ±10 % and differ per
level (RP:58), scopes on rails and eye points (RP:121, RP:132), new items and markers (RP:167-262), decor budgets
(RP:267), smoke volume (RD:172-245), glass shatter (RD:490), strings for every routed key (UI:320, UI:399). Visual
read of every level model, the colour-blind distinction and the copy: **manual** (screenshots in `test-results/shots/m2c-*`).

## Exploratory findings
- **Layout determinism across clients (MF2):** 12 seeds x 2 maps (0, 0xFFFFFFFF, 0x7FFFFFFF, 0x80000000, ...): Chromium and
  Node give identical `layoutHash` and identical digests of the whole layout (props, loot, picks, look, decor, lights).
  Two browsers in one room on `LAYOUT_SEED=4821`: same "Layout #0x000012D5", same look line ("Forecast: Sulky Skies"),
  no layout-mismatch log, no console errors.
- **Wire size** (`server/tools/measure-snapshot.ts`, rows format): 16 players, real match, 120 s: average 1267 B JSON /
  199 B on the wire per snapshot, 4.09 KB/s per client; busiest full snapshot without loot 3301 B (objects 7142 B).
  Synthetic worst case 16 players + 16 grenades + 16 rockets + 12 clouds + 12 panes: busiest full without loot 6245 B
  (< 8,192), largest delta 3969 B (< 4,096), 10.2 KB/s on the wire. At 24 players (above `maxPlayers` 16): busiest
  7195 B (< 8,192), largest delta 4526 B (NETCODE.md bounds 24-player aiming deltas at 6,144 B). The object format
  (clients without `rows1`) reaches 13,362 B in the 16-player worst case; only legacy clients use it.
- **Late join with live state:** on the real office, a player joining after a knife broke pane 34, with a cloud holding
  and a rocket in flight, gets all three (`brokenPanes`, `smokes`, `rockets`) in its first snapshot (QG:481); a viewer joining
  10 s after a smoke deploy gets the cloud (QG:383). The browser-level reconnect check (E-CO late-join test) did not run,
  because the office walking steps before it did not complete; the client side of late joiners is unit-tested (MC:270,
  CG:280, AU:254).
- **Monitor tops after the BUG-011 fix:** single-monitor screens are `noStand`; the 6 dual-monitor screens stay standable
  but nothing reaches them (0 of 5760 perch jumps).
- **Bots and glass:** 0.00 glass breaks per match in every pacing run (bots never break panes); not a criterion.

## Pacing
`npx tsx src/shared/sim/tools/matchReport.ts --matches 30 --variant both --map <id> [--layout-seeds 30]`:

| Map | Layouts | Variant | Median match | Top weapons | Rifle | Zone deaths / 30 |
|---|---|---|---|---|---|---|
| island01 | base | idle | 365 s | rifle 26.5 %, dmr 17.9 %, smg 12.3 % | 26.5 % | 28 |
| island01 | base | looter | 377 s | rifle 25.1 %, dmr 19.6 %, smg 17.4 % | 25.1 % | 3 |
| island01 | 30 seeds | idle | 364 s | rifle 21.4 %, smg 19.1 %, dmr 16.7 % | 21.4 % | 31 |
| island01 | 30 seeds | looter | 360 s | smg 23.9 %, rifle 20.2 %, dmr 15.0 % | 20.2 % | 3 |
| office | base | idle | 361 s | rifle 18.8 %, smg 16.2 %, shotgun 11.9 % | 18.8 % | 27 |
| office | base | looter | 377 s | rifle 26.1 %, smg 17.1 %, shotgun 11.6 % | 26.1 % | 20 |
| office | 30 seeds | idle | 360 s | rifle 26.1 %, shotgun 20.1 %, smg 18.5 % | 26.1 % | 27 |
| office | 30 seeds | looter | 392 s | rifle 20.8 %, smg 19.6 %, shotgun 15.8 % | 20.8 % | 13 |

Melee kills in every run; RPG kills on the island (0.6-1.0 %) and the office base run (0.3 %); no office layout run had
an RPG kill. Landing: island 18.3-19.3 s, office 7.9-9.1 s.

## Run log
2026-11-18, headless Chromium + SwiftShader, QA ports only (8800-8999 / 5300-5399). Load average 11-14 during the runs
(other agents' jobs).

| Run | Command | Result |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | exit 0 |
| Unit (final) | `npx vitest run` | `Test Files 107 passed (107)`, `Tests 2138 passed / 1 expected fail / 1 skipped (2140)`, 42.8 s |
| QA M2c Vitest | `npx vitest run tests/sim/m2c-gaps.test.ts tests/sim/m2c-layout-qa.test.ts tests/sim/m2b-edge.test.ts` | 26 + 5 + 14 tests pass (1 expected fail, BUG-015) |
| MF2 | `npm run e2e:local -- tests/e2e/m2c-layout.spec.ts` | 1 passed (24 map/seed pairs equal) |
| M2c island | `npm run e2e:local -- tests/e2e/m2c.spec.ts` | **7 passed** (twice: standalone and in the full run) |
| M2c seeds | `npm run e2e:local -- tests/e2e/m2c-seeds.spec.ts` | 6 passed standalone; in the full run 5 passed, 1 failed (my `jumpAndLand` helper waited for "aboard" after a slow page had already been auto-ejected; fixed) |
| M2c office glass | `npm run e2e:local -- tests/e2e/m2c-office.spec.ts` | 8 attempts: the drop test passes; the knife broke pane 34 in the browser once (`glassBroken` cause melee); the walk-through, the rocket break and the late-join step never completed because W-pulse steering through office furniture stalls or drifts. Covered in the sim instead (Me:205, Rk:159, Bg glass walking, QG late-join test) |
| E2E full suite | `npm run e2e:local` (27.5 min) | 41 passed, 6 failed, 12 did not run. Failed: `m2a-latency` (could not reach a sniper at 100 ms RTT), `m2a` stance flow (Z did not reach prone on that run; earlier runs pass), `m2b-fp` on-foot (pointer lock not re-granted after closing Settings; the FP / eye 1.05 / FOV 50.53 / viewmodel checks before it passed), `m2b-office` climb (steering), `m2c-office` knife (steering), `m2c-seeds` office 4000000003 (helper bug, fixed) |
| E2E reruns | `npm run e2e:local -- tests/e2e/m2a.spec.ts tests/e2e/m2a-latency.spec.ts tests/e2e/m2b-fp.spec.ts tests/e2e/m2c-seeds.spec.ts` (6.7 min) | 9 passed, 3 failed, 9 did not run. Passed: m2c-seeds 6/6 (office worst 111 calls), m2b-fp drop and on-foot (the earlier pointer-lock failure did not recur), m2a HUD. Failed: `m2a-latency` (again could not reach a sniper), `m2a` "slot 4 / G refused" (the "No throwables" toast did not show within 3 s on this run; it passed in the full run), `m2b-fp` rifle (the walk to the rifle ended 113.8 m away). |

**Conclusion on E2E:** no fully clean run was achieved. The new M2c flows on the island are stable (7/7 twice), MF2 and the
seeds spec pass, and the M2b rooms flows pass. The remaining failures are the walking helpers (`walkTo` / `fetchLoot`: W
pulses plus side-steps) and timing on a loaded machine; random per-match layouts make paths less predictable than in M2b.
Recommended next step for QA: pin `LAYOUT_SEED` in the older specs and replace W-pulse steering with nav-path following
(needs a path hook, see BUG-014), or move those flows to observer-driven headless clients.

## Closing round (after BUG-014 / BUG-015 fixes)
- `tests/sim/m2c-layout-qa.test.ts`: the BUG-015 `it.fails` is a plain `it`; AC 2 checks the rewritten per-group rules.
  6 / 6 pass.
- `window.__game` M2c fields are used by the E2E: `layout.hashMatched` (true on both browsers, client hash = server hash,
  E-C "same pinned layout" test), held `weaponLevel` and `localSlots[0].level` (= server level), `selectedThrowable`,
  `smokes`, per-player `smokeHidden`, `brokenPanes` (office spec).
- Older specs made deterministic: `LAYOUT_SEED=baseline` in m2a, m2a-latency, m2b-fp, m2b-office; office walking follows
  nav paths (`support/nav.ts`, `support/office-path.ts`). Root cause of the m2a-latency / m2b-fp walking failures was in
  QA's specs: their "only snipers / only rifles" loot overrides zeroed only the M1/M2a item ids, so the new M2c items kept
  their weights and the target guns became rare (fixed with `zeroLoot()` built from balance.json). The m2a "No throwables"
  failure was also the spec: the toast lives about 2 s after a server round trip and polling missed it (a MutationObserver
  records it now; a browser repro showed the toast on every press).
- **Final unit run:** `npx vitest run` -> 107 files, 2150 passed, 1 skipped, 0 failed; `npx tsc --noEmit -p .` exit 0.
- **Final full E2E run** (`npm run e2e:local`, 60 tests, 36.3 min): **54 passed, 3 failed, 3 did not run**; the BUG-016
  `test.fail` failed as expected. Failed: `gameplay` (a one-shell shotgun reload ended before the reload bar was checked;
  spec now accepts a finished reload), `m2b-office` stance step (test timeout 120 s under load; raised to 240 s),
  `m2c-office` knife step (the walker drifts away from the first nav point even on a nav path: harness). Reruns of
  gameplay + m2b-office after those spec fixes: see below.
- **Still open:** no game bug. The office glass E2E (m2c-office) remains a harness problem: W-pulse
  steering does not hold a course in the office even along nav paths. Covered in the sim (Me:205, Rk:159, `bugs.m2c`
  glass walking, QG late-join test) and observed once in the browser (pane 34 broken by a knife). A server-side test
  hook that places the player (dev only, e.g. `E2E_SPAWN='{"x":..,"z":..}'`) would make it deterministic; request for
  the network-engineer if wanted.
- **Rerun after the spec fixes** (`npm run e2e:local -- tests/e2e/gameplay.spec.ts tests/e2e/m2b-office.spec.ts`): gameplay
  passed; m2b-office drop passed, the climb walk failed this time (office steering, same harness problem as m2c-office;
  it passed in the final full run), 2 dependents did not run.
- **BUG-016 resolution:** not a game bug. The melee step held LMB 500 ms per try, swinging up to 3 times and killing B; a
  dead player is never smoke-hidden. The spec now clicks once per swing, asserts exactly one hit and B alive before the
  smoke check, logs `alive` / `spectateTargetId`, and the `test.fail` is gone.
  `npm run e2e:local -- tests/e2e/m2c.spec.ts` twice: **8 / 8 and 8 / 8**; `smokeHidden: true` both ways on both runs
  (eye-to-head segment 0.36 m from the centre of the 6.5 m cloud, B alive, no spectate target).
- **m2b-office rerun** (stance timeout raised to 240 s): drop passed; the climb walk stalled 10.5 m before the ramp
  (office steering), so the stance step did not run. Office walking stays the one open harness problem.
