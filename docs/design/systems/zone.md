# System: The Tide (shrinking zone) (MVP)

Numbers: `balance.json` section `zone`. Server-authoritative. The server broadcasts the zone state, and the client only interpolates it for display.

## Purpose
Forces rotation and encounters, paces the match to about 6-8 minutes, and guarantees it ends by 8:40.

## Rules
- At match start, current = {centre (0,0), radius `startRadius`}. Phase index i = 0.
- Each phase i: pick target `{c_i, r_i = phases[i].radiusFraction * startRadius}` at the **start of its wait**, so players see the next circle immediately.
  - Wait `waitSeconds` (no movement), then shrink over `shrinkSeconds`: centre and radius lerp linearly from the previous circle to the target.
  - Outside damage during the whole phase (wait and shrink) = `phases[i].dps`, applied as `dps * damageTickMs/1000` every `damageTickMs`.
    "Outside" means horizontal distance from the centre > radius. Ignores armor. Can kill. Kill credit uses `match.killCreditWindowSeconds`.
- Target centre selection: sample a uniform random point within distance `(R_prev - r_i)` of the previous centre, so the new circle lies fully inside.
  Accept it if `heightAt(point) >= landCheckMinHeight`. Try up to `landCheckMaxTries` times. If none is accepted, use the point at 50% of the way from
  the previous centre toward the origin. For the **last phase**, first try the `MapData.zoneCenters` that satisfy the containment constraint, picking one at random.
- After the last phase: hold for `finalCollapseDelaySeconds`, then shrink to radius 0 (same centre) over `finalCollapseSeconds` with `finalCollapseDps`.
- Use the match RNG (seeded per match) so tests can be deterministic.

## Timeline (default values, M1-fix schedule)
| Phase | Wait | Shrink | Ends at | Radius after | DPS |
|---|---|---|---|---|---|
| 1 | 0:00-1:15 | 1:15-2:00 | 2:00 | 87.5 m | 1 |
| 2 | -3:00 | -3:45 | 3:45 | 65 m | 2 |
| 3 | -4:40 | -5:20 | 5:20 | 47.5 m | 4 |
| 4 | -6:00 | -6:30 | 6:30 | 27.5 m | 6 |
| 5 | -6:55 | -7:20 | 7:20 | 13.75 m | 10 |
| 6 | -7:40 | -8:00 | 8:00 | 5 m | 15 |
| Collapse | -8:20 | -8:40 | 8:40 | 0 | 25 |

Worst-case rotation (far edge of the old circle to the nearest edge of the new one) is 2 x (R_prev - r): 75 m in phase 1 (about 15 s at walk
speed, inside the 75 s wait) and at most 45 m afterwards. Every match is guaranteed to end by 8:40.

## Why this schedule (M1-fix pacing)
Measured with the reworked bots on the old schedule (12 players, 40 matches, `matchReport.ts`): median match 287 s, alive at the start of
P2/P3/P4/P6 = 11/7/3/2, and only 33% of matches reached the final phase. The old phase 3 shrank to 30 m at 3:40-4:15 with about 7 players
alive, about 20 m apart. That is inside the bots' avoid and engage ranges, so the field collapsed in phase 3 or 4. Making only the radii gentler
moved the median to about 300 s, because time was too short as well as the circle being too small.

Design rules for the new schedule:
1. **Keep spacing at or above about 30 m until about 5:00.** Average spacing is about sqrt(pi R^2 / alive). Phase 2 holds 65 m and phase 3 holds
   47.5 m, which keeps 8 or 9 survivors about 30 m apart. The 30 m "forced together" circle now arrives at about 6:30, not 4:15.
2. **Match the tide to the bot eagerness ramp.** Bots reach full eagerness at about 6:30 (`bots.lootPhaseSeconds` 90 + `bots.eagernessRampSeconds` 300).
   Phase 4, the first tight circle, ends at the same moment, so bots become hungry for fights when the circle forces them together.
3. **Long middle, short end.** Phases 1-3 take 5:20 (vs 4:15) and give room to loot, rotate and pick fights. Phases 5-6 and the collapse are short
   (20-25 s steps), because at 14 m or less everyone is already in range, and waiting longer adds no decisions.
4. **Shorter final hold** (`finalCollapseDelaySeconds` 45 -> 20). The 5 m circle forces the last fight on its own, and the hard cap stays under 9 min.
5. DPS per phase is unchanged, so the cost of standing in the tide is the same as before.

Expected result (to be confirmed with `matchReport.ts`): median match about 6-7 min, about 5 alive at the start of P4, and more than 50% of matches reaching P6.
If the median is still below 5:30, the next lever is the bots, not the tide: raise `bots.eagernessRampSeconds` (300 -> 360) before shrinking anything.
If matches regularly hit the 8:40 collapse, shorten the phase 2 and 3 waits by 10 s each.

## States
`Waiting(i)` -> `Shrinking(i)` -> `Waiting(i+1)` ... -> `FinalHold` -> `Collapsing` -> `Closed`. A match end (winner) stops the zone.

## Network payload (minimum, for network-engineer)
`{ phase, state, stateEndsAt (server ms), current: {x,z,r}, target: {x,z,r}, dps }`. Send it on change and in each snapshot (it is small).

## Edge cases
- A player exactly on the edge counts as inside (`<=`).
- Dropping players also take zone damage, but they are always inside at the start because spawns lie within the island.
- Bots use the *target* circle plus `bots.zoneSafetyMargin` for decisions.

## UI / audio / VFX
UI: phase label, countdown to the next state change, a minimap with the current ring (solid) and the target ring (dashed white), an "outside the tide" warning with
direction to safety, and a blue tint while outside. Audio: a warning sting `warningSecondsBeforeShrink` before each shrink, a rising-water loop while shrinking,
a damage tick sound while outside. VFX: an animated translucent water wall at the current radius with foam at its base.

## Acceptance tests
1. With default data, the phase 1 shrink begins at t = 75 s and the radius at t = 97.5 s is (125 + 87.5)/2 = 106.25 m.
2. Every target circle lies inside the previous one (distance between centres + r_i <= R_prev), checked over 1000 seeds.
3. A player outside during phase 3 loses exactly 4 HP per second, with vest and helmet durability unchanged (M2a armor pieces).
4. A player with 100 HP outside during collapse dies within 4 s.
5. With a fixed seed, the zone sequence is identical across runs.
6. Phases end at 120 / 225 / 320 / 390 / 440 / 480 s; the collapse starts shrinking at 500 s and is closed (radius 0) at 520 s.
7. Pacing (headless, `matchReport.ts --matches 40`, 12 players): median match duration 330-480 s, minimum >= 270 s, and median alive at the
   start of P4 >= 4. This is a tuning target, not a unit test.
