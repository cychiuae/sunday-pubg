# Asset List

Owner: `graphics-designer`. Style: `docs/art/STYLE.md`. Everything is procedural for M1 (no files under
`public/assets/` yet).

Tris = colour mesh + outline hull, at scale 1. Budgets: character ≤ 1.5k colour mesh + ≤ 1.5k hull (A6, medium
preset ≤ 300k tris in view), prop ≤ 800 (colour mesh), all instanceable. Materials: everything shares `vertexColorToon()` + `outlineMaterial(t)`.

## Characters — `src/render/procedural/chibi.ts`
| Asset | Factory | Status | Tris | Notes |
|---|---|---|---|---|
| Chibi castaway | `createChibi({skin,outfit,hair})` / `createCharacter(appearance)` | done (M1), trimmed for A6 | 1.24–1.47k + 0.98–1.13k (avg 1.36k + 1.05k) | 6 skins × 10 outfits × 30 hair combos (max over all 1,800). 12 draw calls, or 2 after `chibiSkin` merge. Was 2.38–2.74k + 1.75–2.04k |

Chibi segment budget (colour tris per part, worst variant). Pivots, dimensions and hand sockets are unchanged.

| Part | Tris | Construction |
|---|---|---|
| head | 613–712 | Head sphere 14 × 10 (the roundest part, 252). Ears 5 × 3. Eyes are Z-pole "lens" spheres 10 × 3 (40 each). Highlights and blush are 6 × 2 and 7 × 2 lenses. Smile is a torus 3 × 6. Hair cap 12 × 5. Spikes are open cones. Bob shell 12. Bun 8 × 6. Ponytail capsule 2 × 6. Sunhat brim 16, crown and band 12 |
| torso | 212–284 | Capsule 3 × 10. Trim rings are open 12-sided bands (24 tris, were 128-tri tori). Pattern dots are 5 × 2 lenses (10 tris, were 20) |
| arm (each) | 126–140 | Shoulder ball 7 × 5, open tube 7 (tapers 0.055 to 0.05, both ends buried in the balls), hand ball 7 × 5. Short sleeve is a belled open tube whose top tucks into the shoulder |
| leg (each) | 80–96 | Open tube 8 (top at +0.03, inside every outfit's hip band even with the leg swung about 1 rad; bottom in the shoe), shoe 8 × 5. Shorts and knee wear are open tubes |

The outline hull reuses the same simplified pieces, so the limb hulls cost 80–140 tris each. The smile used to
render as a frown (an extra roll of PI on top of the `alongZ` flip). That is fixed.

## Props — `src/render/procedural/props.ts`
| Kind | Status | Tris | Size (scale 1) | Suggested collider for `game-developer` |
|---|---|---|---|---|
| palm | done | 320 + 320 (was 648 + 648) | 6.6 m, trunk r 0.32 at base | circle r 0.35 at base (the trunk leans, the crown is not solid) |
| rock | done | 100 + 100 | r ≈ 1.5, 1.4 m high | circle r 1.4, height 1.4 |
| bush | done | 224 + 160 (was 344 + 280) | r ≈ 0.9, 1.1 m high | none, or a soft r 0.7 (concealment, not cover) |
| crate | done | 204 + 12 | 1 × 1 × 1 | box 1 × 1 × 1 (can stand on top at 1.0) |
| hut | done | 376 + 296 | 4 × 4 walls, eaves 4.75, 5.1 m high, door +Z | box 4 × 4, height 5 |
| dock | done | 624 + 252 | 3 × 14, origin at centre, long axis Z, deck top 0.55 | walkable deck box 3 × 0.12 × 14, top y 0.55 |
| umbrella | done | 128 + 32 | canopy r 1.2 at 2.25 m | pole circle r 0.1 (canopy above head height) |
| boat | done | 404 + 260 | 1.5 × 4, long axis Z, 0.55 m high | 2 circles r 0.75 at z ±1.0, height 0.55 |
| tikiTorch | done | 166 + 56 + 11 flame | 2.45 m | circle r 0.12 |
| driftwood | done | 76 + 76 | 2.4 m along Z, 0.35 m high | 2 circles r 0.25 (step-over height) |

Palm trim: trunk segments and root flare are 6-sided and open-ended (their ends are buried in the flare, the
next segment, the crown or the ground). The crown ball is 6 × 4, coconuts are 5 × 3, and the 16 fronds are
flattened octahedra (8 tris each, were 20-tri ellipsoids). Bush: the two dark side lobes are detail-0
icosahedra. Bounds moved by at most 3 cm, and origins and trunk radii are unchanged. On island01
(133 palms, 74 bushes) the prop colour + hull total drops from 256k to 151k tris.

## Weapons — `src/render/procedural/weapons.ts`
| Id | Status | Tris (incl. hull) | Length | Muzzle (local) |
|---|---|---|---|---|
| fists | n/a (returns null) | – | – | – |
| pistol | done | 124 | 0.28 m | (0, 0.06, −0.205) |
| smg | done | 236 | 0.59 m | (0, 0.07, −0.37) |
| shotgun | done | 300 | 1.0 m | (0, 0.085, −0.64) |
| rifle | done | 272 | 1.0 m | (0, 0.075, −0.62) |

## Loot — `src/render/procedural/loot.ts`
| Item | Status | Tris (incl. hull + common glow) |
|---|---|---|
| pistol / smg / shotgun / rifle | done | 276 / 388 / 452 / 424 |
| ammo_light / ammo_heavy / ammo_shell | done | 408 / 396 / 372 |
| bandage / medkit / vest | done | 372 / 332 / 544 |
| unknown id | fallback mini crate | 368 |
| Tier glow common / rare / epic | done | disc + ring + rim / + beam / + ring2 + beam + 4 sparkles |

## Materials — `src/render/procedural/materials.ts`
| Asset | Status |
|---|---|
| 3-step toon gradient (`getToonGradient`) | done |
| Vertex-colour toon material (`vertexColorToon`, `toonMaterial`, `createToonMaterial`) | done |
| Inverted-hull outline (`outlineMaterial`, `addOutline`, `ensureOutlineNormals`) | done. Needs an on-GPU visual check by `graphics-engineer` (no headless GL was available) |
| Tiki flame (`flameMaterial`), loot glow materials | done |

## Owned by `graphics-engineer` (look specified in STYLE.md §10 and §13)
| Asset | Status |
|---|---|
| Terrain material, water + foam, sky gradient | todo (spec ready) |
| Muzzle flash, tracer, hit puff, impact puffs, death poof, pickup sparkles | todo (spec ready) |
| Tide wall | todo (spec ready) |

## Future (not in M1)
UI icon set (SVG, `public/assets/icons/`), glTF hero characters, dusk/night palettes, emotes, cosmetics.
