# Map 1: island01

Data: `src/game/levels/island.ts` (`ISLAND`, generated deterministically at module load with a seeded mulberry32 helper).
Registry: `src/game/levels/index.ts` (`MAPS`, `getMap(id)`). Tests: `src/game/levels/island.test.ts`.
Name keys: `map.island01.name`, `poi.<id>` (narrative-designer owns the display text).

## At a glance
| | |
|---|---|
| Players | 12 target, 16 max (`balance.json` `match`) |
| Island radius | 110 m (sand meets sea), coastline wobble +-4 m |
| World radius | 135 m hard boundary in shallow water |
| Base height | 2.5 m, beach band 18 m wide |
| Hills | 4, highest 10 m (summit) |
| Props | ~350 placements, 10 kinds, all instancing-friendly |
| Player spawns | 24, every 15 deg on the sand ring at r = 100 m (~26 m apart) |
| Loot spawns | ~77: ~51 common / ~19 rare / 7 epic |
| Zone centres | 8 candidates, all within 42 m of the centre |

Axes: north = -Z (yaw 0 looks north), east = +X. Compass angles below are clockwise from north.

## Top-down sketch
Roughly 4 m per character horizontally and 8 m per line. `s` = some of the 24 player spawns, `^` = hill,
`O o` = rocks, `Y` = palms, `H` = hut, `c` = crates, `T` = tiki torch, `u` = umbrella, `B` = boat, `==` = dock.

```
                               N (-Z)
                      ~~~~~~~~~~~~~~~~~~~~~
                     :::s:::::::::::::s:::
                 ::::      LONG BEACH     ::::
              :::        (open sand,         s::
           s::  WRECK      no POI)          ROCKS  ::
         ::   B  dw  dw  c                O  o  O    ::
        :   b    c  c   dw               O  o   O  o  s:
      ::   O    c       ^^^^^^^           ^^^^^^^^      ::
     s:          ^^ W BLUFF ^^          ^^ NE RIDGE ^^    :
    :              ^^^^^^^^^              ^^^^^^^^        :s
    :                                                      :
   s:                  ^^^^^^^^^^^^^^                      :
   :                 ^^   SUMMIT     ^^           DOCK      :
   :                ^^  T c (0,0) c   ^^        H  c c c  T :========
  W:                 ^^  10 m  O     ^^          c   c H  T :=======  E (+X)
   :                   ^^^^^^^^^^^^^^                      s
   s:  VILLAGE                                             :
    :  H    H    H                                         :
    :    T  c  T                                           :
     :  H    H    H                ^^^^   GROVE          :s
      ::                         S KNOLL  YYYY YYY YY   ::
       s:                          ^^^^   YY YYYY YY   :
        ::          TIKI BAR                         ::
          ::      u  u H u  u                      s:
           s::     T   T   T                     ::
              :::                              :::
                 ::::s                    s::::
                     :::::::::::::::::::::
                               S (+Z)
```

## Points of interest
| id | Where (compass, r) | XZ centre | Radius | Character | Loot (E/R/C) |
|---|---|---|---|---|---|
| `summit` | centre | (0, 0) | 22 | Exposed 10 m hilltop. Four-torch beacon, a sparse ring of low rocks and 4 crates. Long sightlines both ways. | 4 / 4 / 1 |
| `grove` | 145 deg, 58 m (inland SE) | (33.3, 47.5) | 20 | ~30 palms and 12 bushes. Close-range jungle fights, no long sightlines. | 3 / 2 / 1 |
| `dock` | 95 deg, 90 m (E) | (89.7, 7.8) | 18 | Harbour. Main dock (3 x 14 m) and a short dock out over the sea, boathouse and fish shed, ~10 cargo crates on the quay. | 0 / 4 / 1 |
| `village` | 245 deg, 78 m (SW) | (-70.7, 33.0) | 22 | Six huts in a ring around a torch-lit plaza with crates. Hut-to-hut fights. | 0 / 3 / 2 |
| `wreck` | 310 deg, 92 m (NW) | (-70.5, -59.1) | 16 | Shipwreck cove: big beached hull (boat at scale 1.8), overturned rowboat, washed-up crates and driftwood, framing rocks. | 0 / 2 / 2 |
| `rocks` | 35 deg, 90 m (NE) | (51.6, -73.7) | 16 | Boulder field on the shore (rocks at scale 1-2, up to 3 m radius). Large hard cover, broken sightlines. | 0 / 1 / 3 |
| `tikibar` | 195 deg, 94 m (S) | (-24.3, 90.8) | 14 | Beach bar: one hut facing the sea, umbrellas, torches, a few crates. Mostly open sand. | 0 / 1 / 3 |

The north beach between `wreck` and `rocks` is deliberately empty ("Long Beach"): open sand with the longest sightlines on the map.

## Terrain
- Hills (centre XZ, radius, height): summit (0, 0) r34 h10; NE ridge (42.1, -35.4) r20 h7; W bluff (-50.2, -13.5) r22 h6; S knoll (4.2, 47.8) r14 h4.
  Every hill ends at least 13 m inside the worst-case inner beach edge (88 m), so the sand band stays flat and readable.
- Interpretation notes for `game-developer` (heightAt):
  - Coastline radius = `islandRadius + amplitude * n(angle)` with n in [-1, 1]. `frequency` is dimensionless: sample 2D noise on a circle of radius
    `frequency` in noise space (about 3-5 bumps around the island). All on-land data is kept inside `islandRadius - amplitude - 1` = 105 m.
  - Hill falloff suggestion: `height * 0.5 * (1 + cos(pi * d / radius))` for d < radius, added on top of `baseHeight`.
  - The beach band slopes from `baseHeight` at its inner edge down to 0 at the coastline, then continues below 0 under water out to `worldRadius`.
    The shallow ring should stay wadeable (depth around 0.5-1 m) so the world edge is the visible wall or foam at 135 m and not deep water.

## Sightlines and cover
Characters are 1.3 m tall, so a 1 m crate or a scale-1 rock (about 1.5 m radius) is full crouch-free cover.
- Open and risky: the beach ring, Long Beach, the summit crown, and the dock decks. You can be seen from 60-100 m.
- Medium: the inland jungle, with scattered palms, bushes and rocks between the POIs. Cover every 10-15 m.
- Close: the grove (dense palms), the village (huts), and the boulder field at `rocks`.
- Hard rule: every pair of prop footprints keeps a 2 m gap. Player radius is 0.45 m, so nothing is a dead end or a stuck pocket.

## Risk and reward (loot)
Follows `docs/design/systems/loot.md`.
- Beach ring: 36 common spawns in the gaps between player spawns. Gaps alternate between 2 points and 1 point, so every player spawn has exactly
  3 loot points 13-16 m away (at most about 21 m after placement nudges and the 3 m `spawnJitter`). Everyone can find a weapon within about 30 s.
- Epic loot only at `summit` (4) and `grove` (3). Both are inland and at least 42 m from any spawn, so nobody lands on epic loot, and both are where
  rotations meet. The summit is the exposed, high-reward pick. The grove is the safer but crowded one.
- Rare loot sits mostly at the coastal POIs (dock 4, village 3, wreck 2, rocks 1, tikibar 1) and at 2 inland points.
- Commons are spread along the ring, plus a few at each POI and 2 inland.

## Spawns
- 24 points at r = 100 m, at 7.5 + 15k degrees. They are always on sand, whatever the shoreline noise is (sand spans 96-106 m in the worst case).
- Palm clusters sit in the gaps between spawns, so each spawn lands on open sand with shade on both sides.
- No prop footprint comes within 2.5 m of a spawn.
- Suggestion for `game-developer` and `network-engineer`: with N players, pick a random rotation offset and take every (24 / N)-th spawn. At 12 players
  that puts players about 52 m apart. With the drop (30 m height, 8 m/s fall, 9 m/s steer) each player can steer about 30 m, so nobody can land on
  a neighbour's spot before the neighbour does.

## Rotation routes
1. Ring road: walk the beach ring. It is fast and flat but fully exposed from the jungle edge. Good early, deadly late.
2. Spokes: from each coastal POI, walk straight inland to the summit (about 90 m, or 18 s at walk speed). The W bluff and NE ridge give high-ground
   cover on the west and north-east spokes.
3. Jungle belt: an inner loop at r = 40-70 m through the grove, past the S knoll, around the bluff and the ridge. This is the safe rotation while the
   tide closes.

## Zone (the tide)
The zone starts at r = 125 around (0, 0), so the whole island is inside. The 8 final-centre candidates are (0, 0) and points 36-42 m out at
30, 90, 140, 200, 250, 310 and 355 degrees. All of them are on grass or hill, well inside the coast, which means they pass `landCheckMinHeight`.
Late circles therefore land on the summit flanks, the jungle belt or the grove edge, never on open beach or water.

## Pacing (12 players, about 7-8 minutes)
- 0:00-0:30: drop and loot the beach (3 commons per spawn). Hot drops at the dock and the village.
- 0:30-1:45: push to a POI for rares. The first fights happen between neighbouring spawns and at the coastal POIs. Tide 1 closes to 77 m, so the
  outer beach goes.
- 1:45-3:05: rotate through the jungle belt. The epic summit and grove become contested.
- 3:05 onward: the circles sit inland around the hills. The final fights happen around rocks, palms and crates.

## Props and performance
About 350 placements of 10 kinds. Rough split: palms ~135, bushes ~75, rocks ~60, crates ~45, driftwood ~25, umbrellas ~14, tiki torches ~16,
huts 9, boats 2, docks 2. Every kind is a repeated model, so `graphics-engineer` can draw each kind with one InstancedMesh (plus an outline pass).
That is about 10-20 draw calls for the whole prop set.

Scale assumptions at scale 1 (also used for the layout footprints in `propFootprint()`):
| Kind | Size | Layout footprint |
|---|---|---|
| palm | trunk radius 0.3 m | circle 0.45 |
| rock | about 1.5 m radius | circle 1.5 |
| bush | about 0.9 m radius | circle 0.9 |
| crate | 1 x 1 x 1 m | circle 0.75 |
| hut | 4 x 4 m, door on local +Z | circle 2.9 |
| dock | 3 x 14 m, long axis on local Z, origin at centre | 5 circles of r 1.6 along Z |
| umbrella | about 1.2 m canopy radius | circle 1.2 |
| boat | rowboat 1.5 x 4 m, long axis on local Z | 2 circles of r 1.0 |
| tikiTorch | thin pole | circle 0.25 |
| driftwood | log about 2.4 m long, along local Z | 2 circles of r 0.6 |

`rotY` follows Three.js `rotation.y`: local +Z points toward (sin rotY, cos rotY). Docks and huts at the coast face the sea.
Prop scale ranges: palms 0.85-1.35, rocks 0.5-2.0, huts 0.9-1.2, the wreck hull 1.8, the short dock 0.75.

Note for `game-developer`: the docks stand over water. The dock deck should be walkable (collider top at deck height), or else treated as a solid
pier wall. Everything else sits on land.

## QA checklist (`qa-tester`)
- Walk the full beach ring and confirm the coastline matches the 105 m on-land limit. Look for props whose base floats over water where the coast
  dips by 4 m.
- Dock: walk to the end of both docks, jump off, and wade back. Confirm you cannot get stuck between the dock pilings and the beach.
- World edge: wade out to 135 m in several directions. The boundary should be clear (wall or foam) and must never trap a player.
- `rocks` boulder field and the village hut ring: try to wedge the character between props. The 2 m gaps are designed to make this impossible.
- Summit: run up and down all slopes. Check that `stepHeight` 0.3 handles the 10 m hill, and that loot sits on the slope, not inside it.
- Spawns: for every spawn, confirm it is on open sand with no prop collider within 2 m, and that 3 loot points are within 25 m.
- Spawn camping: from the summit, check whether you can see and shoot a fresh spawn on the beach (about 100 m, past rifle `falloffEnd` 110 m).
  Expected: possible but weak. Report it if it feels oppressive.
- Loot: no loot inside a prop collider (`loot.md` edge case).
