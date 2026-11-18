# M2b "Office, Drop, Rooms & First person" test report (Phase D)

Owner: qa-tester. Build: working tree 2026-11-18 after the C-gate (PROTOCOL_VERSION 3, `M2B_FIELDS_REQUIRED`), no git.
Plan: [TEST_PLAN.md](TEST_PLAN.md). Bugs: [bugs/](bugs/). M2a report (updated in this round): [M2a-test-report.md](M2a-test-report.md).

## Summary

| Suite | Command | Result (final run, see "Run log") |
|---|---|---|
| Typecheck | `npx tsc --noEmit -p .` | exit 0 |
| Unit + integration | `npx vitest run` | 87 files, 1676 passed, 2 expected-fail (BUG-011, BUG-012), 1 skipped (owner), 0 failed |
| E2E | `npm run e2e:local` | see "Run log" |

New QA files for M2b:
- `tests/sim/m2b-edge.test.ts`: real-office exploratory and gap tests (13 tests: monitor-top gap, ping-pong net,
  glass and walls, aboard zone damage, camera QA 2 and 9, maps 18 on the shipped balance; 2 `it.fails` for
  BUG-011 / BUG-012).
- `tests/server/m2b-rooms-qa.test.ts`: rooms.md / maps.md gaps on RoomManager + the real World (11 tests, including
  rejoin after disconnect, kick cooldown by token, host leaving mid-match).
- `tests/e2e/m2b-rooms.spec.ts` (3 browser contexts), `tests/e2e/m2b-fp.spec.ts`, `tests/e2e/m2b-office.spec.ts`.
- Ported to M2b (hello, rooms, carrier drop, first person, new `/healthz`): `tests/integration/pvp-over-ws.test.ts`,
  `tests/e2e/support/{observer,game,stack,drive}.ts`, and the specs `boot`, `join`, `match-loop`, `netcode`,
  `gameplay`, `settings`, `m2a`, `m2a-latency`, `m2a-soak`.
- Residue fixed: map fixtures typed `IslandMapData` (kind), BUG-008 / BUG-010 `it.fails` -> `it`, prone title 0.6 m,
  stale BUG-007 note replaced by an assertion, and a sim-purity check that `src/shared/sim/**` never reaches
  `src/shared/kits/**`.

## Bugs filed in this round
| Bug | Severity | Owner | Title |
|---|---|---|---|
| [BUG-011](bugs/BUG-011.md) | minor | level-designer + graphics-designer (game-developer if a sim flag is chosen) | A sprint-jump from either office perch touches down on a monitor top (plateau gap rule broken) |
| [BUG-012](bugs/BUG-012.md) | minor | game-developer | The prone pitch clamp applies one tick after the prone transition starts |

Closed in this round (verification notes in each file): BUG-005 (not applicable, stance.md AT7/AT7b), BUG-006,
BUG-007, BUG-008, BUG-009, BUG-010.

## Traceability

Status: **pass** = the listed test ran and passed in the final run; **bug** = a filed bug; **manual** = needs a human
(TEST_PLAN.md "M2b additions"); **report** = measured with the headless pacing tool (section "Pacing"). Abbreviations:
`W2b` = `src/shared/sim/World.m2b.test.ts`, `In` = `src/shared/sim/indoor.test.ts`, `Rm` = `server/rooms.test.ts`,
`RmW` = `server/rooms.world.test.ts`, `Cfg` = `server/config.test.ts`, `Bal` = `src/shared/balance.test.ts`,
`Of` = `src/game/levels/office.test.ts`, `Nav` = `src/shared/sim/nav.test.ts`, `Bot` = `src/shared/sim/bots.test.ts`,
`Cam` = `src/game/camera.test.ts`, `CG` = `src/game/ClientGame.m2b.test.ts`, `VmA` = `src/render/viewmodelAnim.test.ts`,
`DP` = `src/game/dropPrediction.test.ts`, `RL` = `src/ui/roomLogic.test.ts`, `UI` = `src/ui/m2b.test.ts`,
`QE` = `tests/sim/m2b-edge.test.ts`, `QR` = `tests/server/m2b-rooms-qa.test.ts`, `E-R` = `tests/e2e/m2b-rooms.spec.ts`,
`E-FP` = `tests/e2e/m2b-fp.spec.ts`, `E-O` = `tests/e2e/m2b-office.spec.ts`. Numbers are the line of the `it(`.

### maps.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | office, office, island01 -> office | In:466, Rm:678 | pass |
| 2 | Tie 50 % +- 5 % over 1000 seeds, stable per seed | In:469 | pass |
| 3 | random wins -> uniform over both | In:478 | pass |
| 4 | No votes: island01, office, island01; first match island01 | In:487, Rm:814 | pass |
| 5 | `MAP=office` pins and the vote shows locked; `MAP=bogus` one warning | Cfg:66, Rm:831 | pass |
| 6 | `?map=office` sets the vote; `?map=xyz` no vote | RL:169 (parse), QR:258 (server), E-R:82/125 (`?room=CODE&map=office` counted as an office vote) | pass |
| 7 | Vote after the lock does not change the map; map id from the lock on | Rm:678, QR:183 | pass |
| 8 | Voter disconnecting before the lock leaves the tally | QR:216 | pass |
| 9 | Mid-match joiner gets the running map; can vote; vote persists | QR:236, Rm:766 | pass |
| 10 | Office drop: drone y 25, lands ~2.25 s later, no damage, also on a desk | W2b:419, E-R:144 (3 clients), E-O:70 | pass |
| 11 | Plateau walk-off / jump-off 0; 9 m fall 5.8; island 6.7 m 20.2 | In:242, In:248, QE:348 (shipped office threshold 18) | pass |
| 12 | Radius 140 covers the floor; phase radii and times | In:351 | pass |
| 13 | 1000 seeds: centres inside the 15 m inset, nested circles | In:372, Of:214 | pass |
| 14 | Outside the circle: dps, no slow, prone allowed | In:398 | pass |
| 15 | Glass stops shots (surface glass), blocks walking, grenades bounce, blast and bot sight blocked | In:174, In:260, In:278, In:319; QE:187 (real office glass wall, 5 shots, 0 damage) | pass |
| 16 | Grenade straight at a wall: normal velocity reversed x restitution | In:308; QE:209 (real office wall, 4 speeds) | pass |
| 17 | Every desk block >= 2 routes; rises <= 0.35 / 0.95; plateau gaps <= 3 or >= 6 m | Of:265, Of:275, Of:302; QE:97 | **bug** BUG-011 (perch -> monitor top 3.8 m, 0.585 m up); routes and rises pass |
| 17b | 0.945 m jump step: 50 / 50 trials; bot climbs without stalling | In:182, Bot:373, Bot:380 | pass |
| 18 | Effective office balance = base + maps.office; island unchanged; bad keys fail; loot 7 / 8 / 6 / 12 | Bal:207, Bal:234, Bal:259; QE:348 (shipped weights) | pass |
| 18b | zoneTheme office sprinklers, island tide; missing/unknown fails; hud strings exist | Bal:226, Bal:234, UI:78 | pass |
| 19 | Nav graph deterministic; every spawn, loot and zone centre reachable both ways | Nav:253, Nav:260, Nav:275, Of:353, Of:360 | pass |
| 20 | Bots stuck < 2 %; climb to plateau loot in >= half the matches; zone deaths <= island + 0.5 | Bot:380 (stuck); matchReport office (see "Pacing") | pass (stuck); **report** for the rest |
| 21 | Office pacing median 330-480 s; no weapon > 35 % | matchReport office | **report** |

### drop.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Same seed same route; headings uniform | W2b:66 | pass |
| 2 | Jump window >= 150 / 90 m; entry/exit/eject rules per map | W2b:81, W2b:93 | pass |
| 3 | Route in the match state from the lock; late joiner receives it | RmW:218, Rm:678 | pass |
| 4 | First playing tick aboard at the carrier; rays, blasts, zone do not touch aboard players | W2b:194; QE:226 (real office, 500 dps zone) | pass |
| 5 | Fire/reload/heal/pickup/slot/stance do nothing aboard | W2b:236 | pass |
| 6 | Jump before noJumpUntil ignored; after it freefall at the carrier, zero horizontal velocity | W2b:270, CG:251, E-FP:74 (Space presses before the door are ignored) | pass |
| 7 | Nobody jumps -> ejected at the eject point | W2b:295, CG:346, DP:108, E-R:144 (C never pressed anything and left last) | pass |
| 8 | Island freefall 30, deploy at y <= 42, chute 8, lands ~7.6 s, no damage | W2b:356, E-FP:74 (HP 100 after landing) | pass |
| 9 | Manual deploy at 600 ms not 400; reach 81 / 123 m | W2b:386 | pass |
| 10 | Office: drone y 25, freefall 15, deploy y <= 10, ~2.25 s, no damage, also on a desk | W2b:419, E-O:70 | pass |
| 11 | Dropping players cannot be hit, fire, pick up, heal | W2b:465 | pass |
| 12 | Bot drop spread, > 80 % land within 10 m, cautious later than aggressive | Bot:112, Bot:134, Bot:213, Bot:222 | pass |
| 13 | Pacing: median match 330-480 s, landing <= 20 s island / <= 10 s office, no weapon > 35 % | matchReport island and office | **report** |

### rooms.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Defaults (12, Vote, bots on, Public); max humans outside 1..16 rejected | Rm:324, QR:130 | pass |
| 2 | Fill on 1 human -> 12 (11 bots); fill off 1 refused, 2 -> 2; 14 humans -> no bots | Rm:661, QR:151, QR:172 | pass |
| 3 | 3 humans all ready -> countdown; 1 ready alone nothing | Rm:731 | pass |
| 4 | Public 60 s timer; private never; resets on leave | Rm:744 | pass |
| 5 | Countdown 10 s; map and route 3 s before the end; host Cancel | QR:183, Rm:661, Rm:710 | pass |
| 6 | Host migration in waiting, countdown, mid-match; last leaving closes | Rm:608, QR:317, E-R:252 (UI: B gets Start, room closes when the last tab closes) | pass |
| 7 | Mode Office no vote; Vote per room; rotation per room; MAP pins all | QR:201, Rm:814, Rm:831 | pass |
| 8 | Mid-match join spectates, not in standings; after results in the waiting room | Rm:766, QR:272, E-FP:233 | pass |
| 9 | After results: same host, settings, votes; ready reset | Rm:766, E-R:234 (same code, host, votes 2/1) | pass |
| 10 | Full room `roomFull`; private never listed; code case-insensitive | Rm:423, Rm:476, Rm:364, E-R:82 (lower-case code, empty list) | pass |
| 11 | Kick: no rejoin for 120 s, then can | Rm:639, QR:297 (same token refused until 120 s, then admitted) | pass |

### camera.md
| # | Criterion (short) | Test(s) | Status |
|---|---|---|---|
| 1 | Camera at the eye point within 0.06 m (exact at full ADS / bob off); forward = aimDirection | Cam:72, Cam:85, CG:382 | pass |
| 2 | Full ADS, 0 spread: the shot hits the point under the screen centre (stand, crouch, prone) | QE:252 (real office, all 3 stances, < 1e-6 m) | pass |
| 3 | Mode table (carrier, FP jump/landing, death, spectate FP + V chase, results) | CG:233, CG:261, CG:454, Cam:161, Cam:167; E-R:144 (carrier then FP), E-FP:74, E-FP:233 (V chase and back), E-R:234 (results view) | pass |
| 4 | 80 deg h at 16:9 = 50.5 v; clamps 70-100; 21:9 same vertical | Cam:36, Cam:45; E-FP:167 (50.53 / 67.67 / 43.00 measured) | pass |
| 5 | ADS FOV identical at slider 70 and 100 (rifle 32.8) | Cam:50; E-FP:207 (32.87 at slider 70) | pass |
| 6 | Sight anchor within 1 px of the centre at blend 1 for every gun | VmA:355 | pass |
| 7 | Scope overlay at adsProgress 1, viewmodel hidden, gone on release | VmA:392, `tests/e2e/m2a.spec.ts` (sniper scope view) | pass |
| 8 | Recoil leaves pitch/yaw unchanged; viewmodel back within 90 ms; spread unchanged | Cam:132, VmA:154, CG:401 | pass |
| 9 | Prone pitch [-30, +45] for humans and bots; +70 entry -> +45 by the first prone tick; no correction | In:447, In:454, CG:432, QE:285, QE:315 (bots, 88 prone samples); QE:301 | **bug** BUG-012 (clamp one tick late); the rest pass |
| 10 | Reduced motion and head-bob-off effects | Cam:85, Cam:132, CG:382, CG:401, VmA:201 | pass |
| 11 | Viewmodel never intersects a wall | VmA:346 (own pass) | **manual** (face a wall; screenshots `m2b-office-*.png` show no clipping in the runs) |
| 12 | Freefall and chute FP; canopy visible looking up in the chute only | VmA:312, VmA:392, E-FP:74 (FP in both phases; `m2b-fp-chute-look-up.png`) | pass (screenshot for the canopy is **manual** review) |

### M2a criteria re-checked under M2b (first person, rooms, carrier)
| Flow | Evidence | Status |
|---|---|---|
| Stance keys C / Z / Space, eye heights, server agrees, no correction | `tests/e2e/m2a.spec.ts`; E-O:162 on the office plateau (max lastCorrection 0.000 m) | see Run log |
| Grenade slot (4 / G refused without grenades; pickup, cook, throw, server explosion) | `tests/e2e/m2a.spec.ts` | see Run log |
| HUD gear cells (vest, helmet, stance icon) and BUG-009 overflow at 960x540 | `tests/e2e/m2a.spec.ts` | see Run log |

## Exploratory findings
- **Monitor tops (BUG-011, level-designer request):** 23 of 2880 sprint-jumps from each perch end grounded on a
  monitor top (11.025 m). The touchdown lasts 1-2 ticks at ~7.2 m/s and nobody can stay (0 of 150, even holding S),
  but a jump on that tick chains to a 12.08 m apex.
- **Prone pitch clamp (BUG-012):** clamped from the second tick of the transition; bots never out of range (88
  prone samples over 3 island + 3 office all-bot matches, 24 stance changes).
- **Glass:** a rifle through the meeting-room glass wall (z -46) stops on glass 5 of 5, 0 damage. Grenades thrown at
  the same wall at 6-18 m/s bounce and rest on the thrower's side.
- **Ping-pong net:** the net collider starts flush on the table top (no gap) and is 1.6 m tall; 40 prone / crouched
  crawls into it from either half never cross.
- **Zone damage aboard:** with the circle forced to 0 m at 500 dps, three players aboard the office drone keep 100 HP
  on every aboard tick.
- **Rejoin after disconnect:** the same client token rejoining mid-match is one member (no duplicate), spectates
  (`status: 'spectating'`, no local state) and is back in the waiting room after the match.
- **Kick cooldown by token:** same token refused `kicked` at 115 s, admitted after 121 s.
- **Prediction corrections:** on the island drop (single page) the hook shows corrections only of whole ticks of fall
  (1.000 / 2.000 m at 30 m/s, 0.267 / 0.533 m at 8 m/s) and each follows a long frame (a 937 ms frame before the 1.000 m
  one); median frame gap 47-68 ms, max 827-937 ms under SwiftShader. That is the server running ticks for a stalled
  client (input repeat budget 200 ms), not a drop prediction error: the owner test DP:75 (steady inputs) shows no
  correction, the office stance flow on the plateau showed 0.000 m, and walking at 100 ms RTT stays below the netcode
  limit (`netcode.spec.ts`). Real players below ~5 fps would see the same snaps.
- **Three WebGL pages at once** run at a few fps each: a 1 s freefall or 1.25 s chute can fall between two rendered
  frames, so the 3-client E2E checks only the first (aboard) and last (on foot) stages; the strict stage order is the
  single-page E-FP:74.
- **Mid-match join UI:** joining a room mid-match goes straight to the spectated match (no waiting-room screen), as
  rooms.md describes; the waiting room appears after the results.

## Pacing
(filled in below by the final runs)

## Load: 8 rooms
(filled in below)

## Run log
(filled in below by the final run)
