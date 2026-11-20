# Asset List

Owner: `graphics-designer`. Style: `docs/art/STYLE.md`. Everything is procedural for M1 (no files under
`public/assets/` yet).

Tris = colour mesh + outline hull, at scale 1. Budgets: character ≤ 1.5k colour mesh + ≤ 1.5k hull (A6, medium
preset ≤ 300k tris in view), prop ≤ 800 (colour mesh), all instanceable. Materials: everything shares `vertexColorToon()` + `outlineMaterial(t)`.

## Characters — `src/render/procedural/chibi.ts`
M2a: a `stance` pivot (Group at the feet origin, between `root` and `body` / `legL` / `legR`) for crouch and
prone; `ChibiOptions.helmet` for helmet-safe hair; `CHIBI_STANCES`, `crouchLegAngle()`, `CHIBI_LEG_LENGTH`. No
change to the colour geometry, pivots or sockets otherwise.
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
Tris = colour + hull. Budget per gun (M2a): colour ≤ 620, hull ≤ 460 (unit-tested in `procedural/m2a.test.ts`).
Frame: origin at the grip, barrel -Z, +Y up. Children: `weapon` mesh (+ `outline`), `muzzle`, `sight` (eye point;
-Z = line of sight), and on red-dot guns a see-through `lens` mesh (`sightLensMaterial()`). `root.userData =
{ weaponId, sightType }`. M2b first-person pass: iron-sight eye points sit on the post tops (the front post tip is
the aim point) and 0.32–0.4 m behind the rear notch; red-dot eye points are 0.3 m behind the hood, so in
first-person ADS the hood frames the view (about 12° at the 50° viewmodel FOV). The red dot is now round and the
lens is see-through. The smg stock and yellow band were lowered to clear the sight line. Scope eye points are
unchanged.
| Id | Status | Tris | Length | Muzzle (local) | Sight | Eye point `sight` (local) | Rear aperture (local), radius |
|---|---|---|---|---|---|---|---|
| fists | n/a (returns null) | – | – | – | – | – | – |
| pistol | done, M2a iron sights | 104 + 56 | 0.28 m | (0, 0.06, −0.205) | iron | (0, 0.119, 0.445) | (0, 0.119, 0.045), 0 |
| smg | done, M2a iron sights | 160 + 112 | 0.59 m | (0, 0.07, −0.37) | iron | (0, 0.134, 0.39) | (0, 0.134, 0.07), 0 |
| shotgun | done, M2a bead + notch | 192 + 144 | 1.0 m | (0, 0.085, −0.64) | iron | (0, 0.139, 0.39) | (0, 0.139, 0.07), 0 |
| rifle | done, M2a red dot (replaces the M1 sight block) | 200 + 152 (+ lens 40) | 1.0 m | (0, 0.075, −0.62) | red_dot | (0, 0.165, 0.272) | (0, 0.165, −0.027), 0.03 |
| dmr | done (M2a) | 500 + 368 | 1.12 m | (0, 0.075, −0.715) | scope_4x | (0, 0.172, 0.18) | (0, 0.172, 0.10), 0.03 |
| lmg | done (M2a) | 380 + 212 (+ lens 40) | 1.11 m | (0, 0.075, −0.71) | red_dot | (0, 0.185, 0.262) | (0, 0.185, −0.038), 0.03 |
| sniper | done (M2a) | 596 + 440 | 1.32 m | (0, 0.075, −0.92) | scope_8x | (0, 0.178, 0.26) | (0, 0.178, 0.18), 0.036 |

## Wearables (M2a) — `src/render/procedural/wearables.ts`
Budget: colour ≤ 360, hull ≤ 300 each (unit-tested). One mesh + one hull, character outline width, shared toon
material: +2 draw calls per worn item. `getWearableGeometry(kind, tier)` exposes the geometry in the bone frame, so
`chibiSkin` can also merge it into the skinned mesh (rigid weight 1 on the bone) to save the draw calls.
| Asset | Factory | Tris | Attach |
|---|---|---|---|
| helmet tier 1 (denim bucket hat) | `createHelmetModel(1)` | 188 + 152 | `CharacterModel.head` (neck pivot) |
| helmet tier 2 (cobalt vented dome) | `createHelmetModel(2)` | 334 + 286 | `CharacterModel.head` |
| helmet tier 3 (slate shell, pink brow) | `createHelmetModel(3)` | 310 + 258 | `CharacterModel.head` |
| vest tier 1 (open-front denim) | `createVestModel(1)` | 156 + 96 | `CharacterModel.body` (hip pivot) |
| vest tier 2 (cobalt puffer) | `createVestModel(2)` | 288 + 240 | `CharacterModel.body` |
| vest tier 3 (slate plate carrier) | `createVestModel(3)` | 158 + 132 | `CharacterModel.body` |

**Attach transform (exact):** parent the returned Group to the pivot with position (0, 0, 0), rotation (0, 0, 0),
scale 1 (`WEARABLE_ATTACH`, or call `attachWearable(characterModel, obj)`).
- Helmet frame = the neck pivot (`parts.head`): world y 0.80 at rest; the head centre is at local (0, 0.25, 0).
- Vest frame = the hip pivot (`parts.body`): world y 0.42 at rest; the vest spans local y 0.09–0.41.
- With a helmet on, call `chibi.setVariant({ helmet: true })` and give the skinned chibi a new appearance key that
  includes the flag (for example `${skin}|${outfit}|${hair}|h`). `hairHiddenByHelmet(hair)` / `HELMET_HAIR_HINT`
  say which styles change. Head tris with helmet hair: spiky 641 + 385 (was 613 + 405), sun hat 616 + 360 (was
  704 + 472), bun / bob / ponytail unchanged.

## Grenade (M2a) — `src/render/procedural/grenade.ts`
| Asset | Factory | Tris | Notes |
|---|---|---|---|
| pineapple frag, pin in | `createGrenadeModel()` | 204 + 192 | origin = body centre, crown +Y; children `grenadeMesh` (+ `outline`), `fuse` at (0, 0.098, 0) |
| pineapple frag, pin pulled | `createGrenadeModel({ pin: false })` | 128 + 128 | cooking / in flight |
In hand: child of `handR` at (0, 0, −0.075), no rotation (`GRENADE_DIMENSIONS.handOffset`). In flight: scale ×1.5
(`flightScale`).

## Loot — `src/render/procedural/loot.ts`
Item ids are plain strings with a safe fallback (mini crate), so the file compiles before and after `ItemId`
gains the M2a ids. Legacy `vest` draws `vest_1`.
| Item | Status | Tris (item colour + hull; + common glow) |
|---|---|---|
| pistol / smg / shotgun / rifle | done (rifle and iron sights updated M2a) | same as the weapon table, + glow |
| dmr / lmg / sniper | done (M2a) | 500 + 368 / 392 + 212 / 596 + 440 |
| ammo_light / ammo_heavy / ammo_shell | done | 408 / 396 / 372 (incl. hull + glow) |
| ammo_sniper | done (M2a): pink box, 2 long cartridges | 184 + 108 |
| bandage / medkit | done | 372 / 332 (incl. hull + glow) |
| vest_1 / vest_2 / vest_3 (and legacy vest) | done (M2a), the wearable at ×1.15 | 156 + 96 / 288 + 240 / 158 + 132 |
| helmet_1 / helmet_2 / helmet_3 | done (M2a), the wearable at ×0.95 | 188 + 152 / 334 + 286 / 310 + 258 |
| grenade | done (M2a), ×2.4 | 204 + 192 |
| unknown id | fallback mini crate | 368 |
| Tier glow common / rare / epic | done | disc + ring + rim (≈ 216) / + beam / + ring2 + beam + 4 sparkles |

## Office props (M2b) — `src/render/procedural/office.ts`
Authored in real metres, baked at **9x** (`OFFICE_SCALE`): scale 1 = map size. Same structure as island props:
`getOfficePropParts(kind)` returns instanceable parts with identity matrices (`body` + `outline`, plus `glass` /
`frost` / `glow` where listed), `createOfficeProp(kind)` returns a Group. Fronts face -Z. Origins: `floor` =
footprint centre on the floor; `surface` = bottom centre, put it on a desk top (`OFFICE_DESK_TOP_Y` = 6.66) or the
floor; `wall` = floor level with the back on local z = 0, extending to -Z; `ceiling` = top centre, hangs down.

**Budgets.** The many-instance kinds are the cheapest: desk 84, chair 280, monitor 96, dual monitor 156 colour
tris (a 42-desk floor with chairs and 55 monitors is about 22k colour + 16k hull tris, in about 8 instanced batches).
Every other kind is ≤ 480 colour tris except `bookStairs` (700, a handful per map). Budgets are unit-tested in
`procedural/office.test.ts`. One shared toon material for every body; glass, frost and glow are 3 shared unlit
materials (`officeGlassMaterial`, `officeFrostMaterial`, `officeGlowMaterial`, plus `officeGlowOffMaterial`).

**Kit (M2b Phase C).** Origins, sizes and colliders are pure data in **`src/shared/kits/office.ts`**
(`OFFICE_KIT: Record<OfficeKitKind, PropKitEntry>`, assignable to `PropKit`; no three.js). The level module sets
`kit: OFFICE_KIT`; the sim reads `map.kit` and never imports the kit. `getOfficePropInfo(kind)` in procedural is a
thin adapter (kit entry + `budget` + `notes`). Kit exports: `OFFICE_KIT`, `OFFICE_KIT_KINDS`, `OfficeKitKind`,
`isOfficeKitKind`, `OFFICE_SCALE`, `OFFICE_DESK_TOP_Y`, `OFFICE_WALL_HEIGHT`, `OFFICE_WALL_MODULE`,
`OFFICE_WALL_THICKNESS` (real m), `OFFICE_PING_PONG_NET_WALL` (1.6). `size` is the drawn bounds (tested to ±0.02 m).
Glass parts carry `glass: true` (`wallGlass` wall, `phoneBooth` door). **Ramps → stairs:** the sim compiles each
`ramp` to `n = ceil(rise / (0.8 × stepHeight))` flat steps (rise/n high, depth/n deep, climbing toward -Z); at
stepHeight 0.35: whiteboardRamp 24 × 0.2775 m rise, 0.62 m tread; keyboardRamp 4 × 0.236 m, 0.97 m tread (tested:
rise ≤ 0.8 × stepHeight, tread ≥ 0.5 m, width > player diameter, top = the plateau).

**Colliders.** The table lists the simplified collider parts exactly as exported in
`OFFICE_KIT[kind].colliders` (world metres, scale 1, rotY 0, relative to the origin; rotate with the
placement). `ramp` = walkable slope over the box that rises from `min.y` at `max.z` to `max.y` at `min.z` (climbs
toward the prop's front, -Z). Climb-route rules met: book-stair steps rise 0.945 m (jump), `boxSmall` and
`bookStack` are 0.95–1.0 m jump steps, `keyboard` (0.28 m) is a walkable step, `keyboardRamp` rises 0.945 m onto a
`bookStack`, `whiteboardRamp` reaches the desk top at 24°.

**Walls.** For the map's wall segments use `getOfficeWallParts('solid' | 'glass', lengthWorld)` /
`createOfficeWall(...)`: one merged run per segment (cached by length), centred on the origin along X, 27 m tall
(`OFFICE_WALL_HEIGHT`), 0.9 m thick; glass runs get a mullion about every 10.8 m. `wallSolid` / `wallGlass` are the
10.8 m instanceable modules. Doorways: leave a 9.18 m gap and drop a `doorFrame` in it (opening 8.1 × 18.9 m,
lintel up to the wall top).

| Kind | Origin | Size x × y × z (m) | Tris body + hull (+ extra) / budget | Colliders (world m, scale 1, rotY 0) | Notes |
|---|---|---|---|---|---|
| desk | floor | 12.64 × 6.66 × 6.79 | 84 + 72 / 90 | top: box (-6.3, 6.39, -3.37)–(6.3, 6.66, 3.38); legL: box (-6.12, 0, -3.15)–(-5.76, 6.39, 3.15); legR: box (5.76, 0, -3.15)–(6.12, 6.39, 3.15); beam: box (-5.76, 5.4, 2.52)–(5.76, 5.94, 2.88) | white top on light-wood leg panels |
| deskWood | floor | 12.64 × 6.66 × 6.79 | 84 + 72 / 90 | top: box (-6.3, 6.39, -3.37)–(6.3, 6.66, 3.38); legL: box (-6.12, 0, -3.15)–(-5.76, 6.39, 3.15); legR: box (5.76, 0, -3.15)–(6.12, 6.39, 3.15); beam: box (-5.76, 5.4, 2.52)–(5.76, 5.94, 2.88) | light-wood top on a white frame |
| chair | floor | 5.71 × 10 × 5.74 | 280 + 220 / 300 | base: cyl r 2.97 at (0, 0) y 0–0.81; pole: cyl r 0.45 at (0, 0) y 0.81–3.78; seat: box (-2.25, 3.78, -2.16)–(2.25, 4.41, 2.16); back: box (-2.07, 5.4, 1.62)–(2.07, 10.08, 2.97); armL: box (-2.65, 4.32, -0.99)–(-2.2, 6.21, 1.35); armR: box (2.21, 4.32, -0.99)–(2.66, 6.21, 1.35) | seat top 0.49 real; back to 1.12; arms at 0.69 |
| monitor | surface | 4.95 × 4.37 × 1.8 | 96 + 60 / 100 | screen: box (-2.47, 1.4, -0.18)–(2.48, 4.37, 0.18); pole: cyl r 0.23 at (0, 1.08) y 0–3.96 | origin on the desk top at the screen centre; clamp 0.12 real behind (keep origin >= 0.2 real from the back edge) |
| monitorDual | surface | 10.12 × 4.37 × 2.27 | 156 + 84 / 160 | screen: box (-5.22, 1.4, -0.63)–(5.22, 4.37, 0.54); pole: cyl r 0.23 at (0, 1.08) y 0–3.96 | origin on the desk top at the screen centre; clamp 0.12 real behind (keep origin >= 0.2 real from the back edge) |
| laptop | surface | 2.79 × 1.97 × 2.5 | 48 + 24 / 60 | base: box (-1.39, 0, -0.99)–(1.4, 0.14, 0.99); lid: box (-1.39, 0.14, 0.9)–(1.4, 1.98, 1.53) | lid open ~105 degrees, hinge at +Z |
| keyboard | surface | 3.96 × 0.28 × 1.26 | 48 + 12 / 48 | keyboard: box (-1.98, 0, -0.63)–(1.98, 0.28, 0.63) | 0.27 m world tall: a walkable step |
| keyboardRamp | floor | 1.26 × 0.97 × 3.93 | 48 + 12 / 48 | ramp: ramp (-0.63, 0, -1.95)–(0.63, 0.95, 1.95) | rise 0.94 m over 3.89 m (10 deg): pair with a bookStack at its -Z end |
| bookStack | surface | 2.23 × 0.94 × 2.78 | 72 + 36 / 80 | stack: box (-1.04, 0, -1.35)–(1.04, 0.95, 1.35) | 3 books = 0.95 m world: one jump step |
| bookStairs | floor | 2.36 × 6.62 × 12.78 | 700 + 700 / 760 | step1: box (-1.12, 0, 4.5)–(1.13, 0.95, 6.3); step2: box (-1.12, 0, 2.7)–(1.13, 1.89, 4.5); step3: box (-1.12, 0, 0.9)–(1.13, 2.84, 2.7); step4: box (-1.12, 0, -0.9)–(1.13, 3.78, 0.9); step5: box (-1.12, 0, -2.7)–(1.13, 4.73, -0.9); step6: box (-1.12, 0, -4.5)–(1.13, 5.67, -2.7); step7: box (-1.12, 0, -6.3)–(1.13, 6.62, -4.5) | 7 steps of 0.945 m (jump), treads 1.8 m deep, top step 6.615 m (desk top 6.66 is a 0.045 m walk-up); climbs toward -Z (put the -Z end against a desk) |
| box | surface | 4.53 × 2.73 × 3.65 | 48 + 12 / 48 | box: box (-2.25, 0, -1.8)–(2.25, 2.7, 1.8) | 4.5 x 2.7 x 3.6 m world: a wall-like block (climb from a boxSmall) |
| boxSmall | surface | 3 × 1.02 × 2.02 | 48 + 12 / 48 | box: box (-1.48, 0, -0.99)–(1.49, 0.99, 0.99) | 2.97 x 0.99 x 1.98 m world: one jump step |
| whiteboardRamp | floor | 11.2 × 6.82 × 15.16 | 108 + 72 / 120 | ramp: ramp (-5.4, 0, -7.42)–(5.4, 6.66, 7.42) | rise 6.66 m over 14.8 m (24 deg), 10.8 m wide; climbs toward -Z |
| plushSeal | surface | 3.99 × 2.34 × 3.33 | 396 + 228 / 420 | plush: box (-1.8, 0, -1.44)–(1.8, 2.34, 1.89) | "Mochi seal": lilac-grey blob, flippers, tail |
| plushCrab | surface | 4.7 × 2.46 × 2.42 | 416 + 284 / 420 | plush: box (-2.43, 0, -1.26)–(2.43, 2.52, 1.26) | coral beach crab: big claws, eye stalks |
| plushWhale | surface | 3.17 × 2.34 × 4.36 | 356 + 212 / 420 | plush: box (-1.8, 0, -1.8)–(1.8, 2.43, 2.88) | mint whale: cream belly, tail fluke up at the back |
| waterBottle | surface | 0.65 × 2.25 × 0.65 | 96 + 80 / 110 | bottle: cyl r 0.32 at (0, 0) y 0–2.25 | pale aqua bottle, blue cap and label band |
| mug | surface | 1.12 × 0.86 × 0.81 | 128 + 88 / 130 | mug: cyl r 0.45 at (0, 0) y 0–0.86 | teal mug with coffee, handle on +X |
| pottedPlant | floor | 2.7 × 7.92 × 2.7 | 120 + 88 / 120 | pot: cyl r 1.35 at (0, 0) y 0–2.52; leaves: cyl r 1.08 at (0, 0) y 2.52–7.92 | white pot + snake-plant blades, 0.88 real tall |
| filingCabinet | floor | 4.05 × 9 × 5.72 | 120 + 12 / 130 | cabinet: box (-2.02, 0, -2.7)–(2.03, 9, 2.7) | 3 drawers, front -Z; top is a 9 m high platform |
| printer | floor | 5.4 × 8.75 × 5.67 | 108 + 48 / 130 | printer: box (-2.7, 0, -2.97)–(2.7, 8.64, 2.7) | office MFP: paper drawers, scanner lid, control panel, output tray |
| pinboard | wall | 10.8 × 8.1 × 0.45 | 192 + 12 / 200 | board: box (-5.4, 8.1, -0.36)–(5.4, 16.2, 0) | wall-mounted 0.9..1.8 real (8.1..16.2 m world), 0.27 m deep; back on z = 0 |
| fireExtinguisher | floor | 2.01 × 5.03 × 1.45 | 222 + 202 / 230 | extinguisher: cyl r 0.72 at (0, 0) y 0–5.04 | red cylinder, dark valve, hose and horn, white label band |
| phoneBooth | floor | 9.4 × 19.8 × 9.59 | 192 + 156 (glass 12, frost 36, glow 12) / 260 | pod: box (-4.77, 0, -4.23)–(4.77, 19.8, 4.77); door: box **glass** (-4.77, 0, -4.77)–(4.77, 19.8, -4.23) | white pod, glass door on -Z (closed, solid collider), bench + shelf inside, ceiling light |
| wallSolid | floor | 10.8 × 27 × 1.12 | 24 + 12 / 24 | wall: box (-5.4, 0, -0.45)–(5.4, 27, 0.45) | module 10.8 x 27 x 0.9 m world, centred on the wall line along X; stretch along X freely (or use createOfficeWall) |
| wallGlass | floor | 10.8 × 27 × 0.9 | 48 + 48 (glass 12, frost 60) / 60 | wall: box **glass** (-5.4, 0, -0.45)–(5.4, 27, 0.45) | alu frame, tinted glass, frosted band at 1.0..1.5 real; half mullions at both ends so modules tile |
| doorFrame | floor | 9.18 × 27 × 1.35 | 60 + 48 / 60 | jambL: box (-4.59, 0, -0.63)–(-4.05, 18.9, 0.63); jambR: box (4.05, 0, -0.63)–(4.59, 18.9, 0.63); lintel: box (-4.59, 18.9, -0.63)–(4.59, 27, 0.63) | opening 8.1 x 18.9 m world; frame is 9.18 m wide: leave that gap in the wall; lintel fills up to wall height |
| pingPongTable | floor | 16.47 × 8.28 × 24.66 | 168 + 96 / 170 | top: box (-6.86, 6.57, -12.33)–(6.86, 6.84, 12.33); net: box (-8.24, 6.84, -0.09)–(8.24, 8.44, 0.09) (1.6 m wall; model 1.35 m + tape); legs-1: box (-5.8, 0, -8.77)–(5.81, 6.57, -8.32); legs1: box (-5.8, 0, 8.32)–(5.81, 6.57, 8.78) | blue top 6.84 m up (walkable), long axis Z, legs leave a 6.6 m crawlspace |
| foosballTable | floor | 9.36 × 8.1 × 10.8 | 464 + 172 / 480 | cabinet: box (-3.37, 5.4, -5.4)–(3.38, 8.1, 5.4); leg-1-1: box (-3.01, 0, -4.99)–(-2.39, 5.4, -4.36); leg-11: box (-3.01, 0, 4.37)–(-2.39, 5.4, 5); leg1-1: box (2.39, 0, -4.99)–(3.01, 5.4, -4.36); leg11: box (2.39, 0, 4.37)–(3.01, 5.4, 5) | wooden cabinet top rim 8.1 m, field 6.8 m, 8 rods (handles stick out 0.47 real) |
| dumbbellRack | floor | 10.89 × 6.78 × 4.05 | 396 + 336 / 400 | rack: box (-5.44, 0, -2.02)–(5.45, 7.02, 2.03) | 2-tier rack, 6 dumbbells with pink / teal / mango plates |
| guitarStand | floor | 3.6 × 10.21 × 4.59 | 272 + 168 / 280 | stand: box (-1.8, 0, -1.8)–(1.8, 9.9, 2.34) | original acoustic guitar leaning on an A-frame stand, 1.1 real tall |
| pantryCounter | floor | 16.56 × 12.96 × 5.63 | 292 + 148 / 300 | counter: box (-8.28, 0, -2.79)–(8.28, 8.1, 2.79); machine: box (2.7, 8.1, -2.16)–(5.4, 12.96, 2.16); faucet: box (-4.77, 8.1, 0.45)–(-4.23, 10.44, 1.98) | counter top 8.1 m (walkable), coffee machine to 13.2 m; sink at -X, machine at +X; doors face -Z |
| lightPanel | ceiling | 10.8 × 6.16 × 2.7 | 120 + 12 (glow 12) / 140 | none (visual only) | origin = top of the housing; hang 5.4 m below its wire anchors; louvred diffuser is the glow part |
| acCassette | ceiling | 5.85 × 2.65 × 5.85 | 84 + 24 / 90 | none (visual only) | origin = top centre; white face panel 0.29 real below |


Not modelled as props (graphics-engineer, spec in `STYLE.md` §19): the floor (`officeFloorColorAt(x, z)` gives
the plank colour), carpet / tile zones, the dark exposed ceiling and ducts, and the zone effects.

## Carriers and parachute (M2b plane drop) — `src/render/procedural/carrier.ts`
World metres, scale 1. Carriers fly toward local **-Z**, +Y up, origin at the body centre. Spinners are separate
named children; each has a hidden `blur` disc (`carrierBlurMaterial()`, 22% white) to show when spinning fast.
| Asset | Factory | Size | Tris (colour + hull) | Named children |
|---|---|---|---|---|
| Island seaplane | `createSeaplane()` | 15.2 m long, 22.6 m wingspan, 8.2 m tall (floats bottom y −3.94 to fin top 4.25); notional cabin for 16 | body 1120 + 728, + 2 × propeller 60 + 60 | `body` (+ `outline`); `propellerL` (−4.6, 1.55, −4.15) and `propellerR` (4.6, 1.55, −4.15): spin about local **Z**, radius 1.25; `door` (−1.78, −0.25, 0.6) open side door on **−X**; `jumpPoint` (−2.6, −0.6, 0.6) just outside it |
| Office delivery drone | `createDeliveryDrone()` | 7.7 m across the rotor tips, 4.9 m tall (rotor top y +0.85 … parcel bottom −4.05): at 25 m altitude the top is 25.85 m, under the 27 m ceiling | body 524 + 412, + 4 × rotor 48 + 48 | `body`; `rotor0`..`rotor3` at (±2.5, 0.75, ±2.5): spin about local **Y**, radius 1.35, `userData.spin` = ±1 (alternate directions); `jumpPoint` (0, −4.3, 0) under the parcel |
| Parachute | `createParachute({ stripe?, deploy? })` | canopy dome r 2.8 squashed to 0.55, rim radius 2.73 at y 4.3, top y 5.45 (chibi frame); 8 gores | open: canopy 256 + 112, lines 64; packed: backpack 36 + 12 | `canopy` and `lines` (pivots at the risers, y 0.79; scale them), `pack` (backpack at (0, 0.64, 0.2)) |

**Parachute attach transform:** child of the chibi's **stance pivot** (`CharacterModel.chibi.parts.stance`), position
(0, 0, 0), rotation (0, 0, 0), scale 1. The geometry is in the chibi root frame (feet at origin, facing −Z); the
lines end at the shoulders (±0.215, 0.79, 0). The stance pivot is identity when not crouched / prone, so it equals
the root frame, and during freefall (which rotates the stance pivot about the hips) the backpack stays on the back.
**States:** `setParachuteDeploy(obj, k)`: k = 0 packed (backpack only), 0..1 deploying (narrow tall bundle that pops
open with an overshoot), 1 open, 1..2 collapse after landing (tips back and flattens), 2 hidden. **Variants:**
`stripe` indexes `PARACHUTE_STRIPES` (6 beach-towel / umbrella pairs: coral/cream, towel blue/white, mango/teal,
bubblegum/white, lime/cream, lilac/white). Use the player id or team so canopies are told apart; the shape and
the 8 alternating gores keep them readable without colour.

Poses for the drop: `CHIBI_FREEFALL` and `freefallStanceOffset()` in `chibi.ts`; spec in `STYLE.md` §20.

## First-person viewmodel (M2b addendum 3) — `src/render/procedural/viewmodel.ts`
Camera space: origin at the eye, looking -Z. Render in its own pass at `clientFeel.viewmodelFovDeg` (55° vertical; fallback `VIEWMODEL_FOV` = 55), near 0.01 m. Hold poses were framed at 50° and depth-scaled by 0.896 (`VIEWMODEL_FOV_DEPTH`) to look the same at 55°.
Outlines use `viewmodelOutlineMaterial()` (0.00011 m + about 2 px screen minimum), not the world widths, so ink
stays thin up close. Viewmodel meshes cast and receive no shadows.
| Asset | Factory | Tris (colour + hull) | Notes |
|---|---|---|---|
| Arms (both forearms + mitten hands) | `createViewmodel(appearance)` | 424 + 392 | per hand: palm 8×6, thumb, wrist cuff, forearm open tube (0.34 m), fingers mitten on a knuckle pivot. Skin = skin tone; forearm = outfit top colour for long sleeves, else skin; cuff = outfit accent (a wristband on bare arms). 4 meshes + 4 hulls |
| Held items | `createViewmodelItem(id)` | same as the world models (guns 104–596, grenade 204 / 128, bandage 172, medkit 132) | thin outlines applied; heal items are scaled by the pose (`itemScale`) |
Budget: arms ≤ 500 colour tris (unit-tested); arms + the heaviest item (sniper) ≈ 1.0k colour tris.

Rig names: `viewmodel` → `itemSocket` (item), `handR` / `handL` (hand bones: fingers −Z, back of hand +Y, forearm
along +Z), `fingersR` / `fingersL` (knuckle pivots, `rotation.x` < 0 curls). Poses: `VIEWMODEL_POSES[id] =
{ hip, ads, handR, handL, curlR, curlL, itemScale }` (socket in camera space; hand targets in item space;
Euler XYZ). `applyViewmodelPose(rig, id, adsAmount)` sets everything. For every gun the ADS socket is
`pos = −sight.eye, rot = 0`, so the `sight` anchor is exactly on the eye and its line of sight on the view axis
(unit-tested).
| Item | Hip socket pos / rot | ADS socket pos / rot | Hand R target | Hand L target | Curl R / L | Scale |
|---|---|---|---|---|---|---|
| fists | (0, 0, 0) (0, 0, 0) | (0, 0.02, 0.02) (0, 0, 0) | (0.15, -0.13, -0.36) | (-0.16, -0.15, -0.42) | -1.6 / -1.6 | 1 |
| pistol | (0.12, -0.13, -0.46) (0.02, 0.07, 0) | (0, -0.119, -0.445) (0, 0, 0) | (0.004, -0.035, 0.03) | (-0.035, -0.07, 0) | -1.25 / -0.95 | 1 |
| smg | (0.16, -0.17, -0.46) (0.03, 0.14, -0.05) | (0, -0.134, -0.39) (0, 0, 0) | (0.004, -0.04, 0.045) | (0, -0.045, -0.15) | -1.25 / -0.95 | 1 |
| shotgun | (0.18, -0.2, -0.47) (0.03, 0.16, -0.06) | (0, -0.139, -0.39) (0, 0, 0) | (0.004, -0.045, 0.04) | (0, -0.03, -0.3) | -1.25 / -0.95 | 1 |
| rifle | (0.18, -0.2, -0.47) (0.03, 0.16, -0.06) | (0, -0.165, -0.272) (0, 0, 0) | (0.004, -0.045, 0.06) | (0, -0.025, -0.3) | -1.25 / -0.95 | 1 |
| lmg | (0.19, -0.23, -0.48) (0.04, 0.16, -0.06) | (0, -0.185, -0.262) (0, 0, 0) | (0.004, -0.045, 0.08) | (0, -0.03, -0.36) | -1.25 / -0.95 | 1 |
| dmr | (0.19, -0.22, -0.5) (0.03, 0.16, -0.06) | (0, -0.172, -0.18) (0, 0, 0) | (0.004, -0.045, 0.06) | (0, -0.025, -0.33) | -1.25 / -0.95 | 1 |
| sniper | (0.2, -0.23, -0.55) (0.03, 0.16, -0.06) | (0, -0.178, -0.26) (0, 0, 0) | (0.004, -0.045, 0.07) | (0, -0.04, -0.36) | -1.25 / -0.95 | 1 |
| grenade | (0.16, -0.12, -0.46) (0, 0.3, 0) | (0.22, -0.01, -0.42) (-0.3, 0.3, 0.2) | (0, -0.06, 0.01) | (-0.085, 0.05, 0.02) | -0.9 / -0.7 | 1 |
| grenade_cooking | (0.16, -0.11, -0.45) (0, 0.3, 0) | (0.22, -0.01, -0.42) (-0.3, 0.3, 0.2) | (0, -0.06, 0.01) | hidden | -1 / -0.4 | 1 |
| bandage | (0.02, -0.15, -0.5) (0.35, 0.25, 0) | (0.02, -0.15, -0.5) (0.35, 0.25, 0) | (0.24, -0.06, 0.05) | (-0.22, -0.03, 0.02) | -1 / -1 | 0.6 |
| medkit | (0, -0.17, -0.46) (0.6, 0.12, 0) | (0, -0.17, -0.46) (0.6, 0.12, 0) | (0.27, -0.03, 0.02) | (-0.27, -0.03, 0.02) | -0.7 / -0.7 | 0.65 |

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

## UI specs delivered as text (implemented by `ui-ux-designer`)
| Asset | Spec |
|---|---|
| ADS reticles: iron dot, red dot, 4x chevron, 8x mil-dot crosshair, scope frame | `STYLE.md` §17 (SVG + CSS) |
| Icons: dmr, lmg, sniper, ammo_sniper, grenade, helmet_1..3, vest_1..3 | `STYLE.md` §18 (clip-paths + 32 px SVG) |
| Throw arc preview, explosion, fuse spark, grenade trail (graphics-engineer) | `STYLE.md` §15 |

## Future
glTF hero characters, dusk/night palettes, emotes, cosmetics, attachments (scopes as pickups, M2b+).

## M2c (built A1; spec `docs/art/M2c.md`)
Tris = colour + hull at scale 1. Per-level weapon models (Addendum 2, rebuilt by Addendum 4 = M2c.md §17: each level
has its own body, so levels differ in silhouette). Columns are the model with no level (M2b look, no collar) and
levels 1–4 (own body + collar + pips + the shared level extras). "Worst" = the level + scope with the most tris
(balance-compatible scopes). Length (Z) stays within ±10 % across levels (tested). Held: 2 draw calls (+1 red-dot lens).
| Weapon | no level | L1 salvaged | L2 standard | L3 upgraded | L4 premium | Worst | Length L1–L4 |
|---|---|---|---|---|---|---|---|
| pistol | 104 + 56 | 272 + 140 | 140 + 68 | 292 + 104 | 268 + 116 | 352 + 168 (L1 + red dot) | 0.28–0.30 m |
| smg | 160 + 112 | 304 + 172 | 196 + 124 | 296 + 140 | 376 + 168 | 508 + 292 (L4 + 2x) | 0.59–0.62 m |
| shotgun | 192 + 144 | 324 + 192 | 228 + 156 | 452 + 248 | 332 + 172 | 532 + 276 (L3 + red dot) | 0.99–1.03 m |
| rifle (red dot) | 240 + 152 | 360 + 200 | 276 + 164 | 496 + 264 | 408 + 208 | 732 + 468 (L3 + 4x) | 0.99–1.04 m |
| lmg (red dot) | 420 + 212 | 416 + 232 | 456 + 224 | 580 + 296 | 572 + 248 | 816 + 500 (L3 + 4x) | 1.11–1.15 m |
| dmr (4x) | 500 + 368 | 692 + 428 | 536 + 380 | 732 + 468 | 628 + 416 | 732 + 468 (L3) | 1.10–1.14 m |
| sniper (8x) | 596 + 440 | 680 + 476 | 632 + 452 | 748 + 508 | 700 + 476 | 748 + 508 (L3) | 1.30–1.34 m |
| revolver | 300 + 200 | 444 + 260 | 364 + 240 | 516 + 284 | 480 + 240 | 596 + 312 (L3 + red dot) | 0.32–0.34 m |
| dbshotgun | 368 + 268 | 464 + 280 | 404 + 280 | 608 + 340 | 632 + 312 | 608 + 340 (L3) | 0.97–1.00 m |
| rpg | 512 + 300 | 696 + 360 | 576 + 340 | 688 + 372 | 616 + 336 | 688 + 372 (L3) | 1.00 m |
| knife | 164 + 140 | 276 + 168 | 228 + 180 | 244 + 116 | 304 + 136 | – | 0.31–0.33 m |
| machete | 248 + 56 | 288 + 120 | 312 + 96 | 456 + 120 | 340 + 116 | – | 0.60–0.62 m |
| paddle | 216 + 216 | 300 + 216 | 280 + 256 | 520 + 424 | 404 + 304 | – | 1.35–1.43 m |
What each level body looks like, per weapon: M2c.md §17.2. Status: done (Addendum 4), tested in `m2c.test.ts`
("Addendum 4": own parts per level, ≥ 8 % silhouette difference between any two levels, sight line and rail clear).
Budget (tested): worst ≤ 860 colour / ≤ 520 hull.

**Rails and scopes** (`scopes.ts`, `SCOPE_GEOMETRY`; eye = rail + scope.eye). Rails: pistol (0, 0.095, −0.04) 0.10;
revolver (0, 0.105, −0.06) 0.10; smg (0, 0.11, −0.06) 0.16; shotgun (0, 0.115, −0.02) 0.16; dbshotgun (0, 0.1175, 0)
0.10; rifle (0, 0.115, −0.06) 0.24; lmg (0, 0.135, −0.07) 0.24; dmr (0, 0.115, −0.06) 0.26; sniper (0, 0.11, −0.07) 0.30;
rpg and melee none. The default optics reproduce the M2b eye points exactly (tested).
| Scope | Tris | axisY | eye (scope frame) | footprint | Loot scale |
|---|---|---|---|---|---|
| scope_red_dot | 76 + 28 (+ lens 40) | 0.050 | (0, 0.05, 0.3325) | 0.07 | ×2.2 |
| scope_2x | 168 + 124 | 0.052 | (0, 0.052, 0.18) | 0.09 | ×2.0 |
| scope_4x | 352 + 232 | 0.057 | (0, 0.057, 0.24) | 0.17 | ×1.6 |
| scope_8x | 352 + 232 | 0.068 | (0, 0.068, 0.33) | 0.23 | ×1.3 |

**Other M2c models**
| Asset | Factory | Tris | Notes |
|---|---|---|---|
| rocket | `createRocketModel()` | 236 + 228 | 0.5 m, child `nozzle` (0, 0, 0.26); instance it |
| ammo_rocket | loot | 308 + 240 | one rocket on a striped crate |
| smoke can | `createSmokeModel({ pin })` | 260 + 208 | same anchors as the frag (`fuse`, hand offset, flight ×1.5) |
| helmet_4 Ship's Bell | `createHelmetModel(4)` | 312 + 264 | loop on top to +0.38 above the head centre |
| vest_4 Surfboard | `createVestModel(4)` | 284 + 188 | tail fin out the back |
| vests 1–3 (+ level badge) | `createVestModel(t)` | 180 + 96 / 320 + 240 / 198 + 132 | accents recoloured to the level colours |
| level marker L1..L4 | `createLootMarker(n)` | disc + ring + rim + N pips (8 each) (+ ring2 L3+, beam L2+, sparkles L4) | unlit |
| supply marker | `createLootMarker('supply')` | disc + white ring + rim | non-levelled items |
| decor (9 kinds) | `getDecorParts(kind, variant)` | 48–128, no hull | see M2c.md §9.0 |
| waterCooler | office kit | ≤ 220 body | 3.34 × 9.9 × 3.33 world |
| island variants | `getPropParts(kind, variant)` | ≤ v0 + ~60 | palm 2, rock 3, crate 3, hut 3, umbrella 4 |
| icons | `icons.ts` `M2C_ICON_SVG` | 32 × 32 SVG | 14 icons + the 2x reticle |
