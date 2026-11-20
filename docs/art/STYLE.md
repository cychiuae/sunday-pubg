# Art Style Guide — Beach Survival PvP

Owner: `graphics-designer`. Code mirror of every value here: `src/render/procedural/materials.ts` (`palette`,
`TOON_RAMP`, `OUTLINE`). If you change a number, change both.

## 1. Direction in one line
Chibi castaways on a sun-blasted toy island: **bright saturated colour, 3-step cel shading, dark plum ink outlines,
chunky low-poly shapes**. Everything should look like a vinyl toy left on a beach towel.

Pillars, in priority order:
1. **Readability first.** Players, loot, and hazards always stand out from sand, grass, and sea. The environment is
   pale and warm. Characters and loot are saturated and outlined.
2. **Chunky and soft.** Big, round, simple forms. No thin detail that disappears at 30 m.
3. **Flat colour.** Vertex colours plus the toon ramp. No texture noise, no PBR roughness or metal. All variation
   comes from shape and colour blocks.
4. **Original.** No shapes, mascots, logos, or colour schemes that copy another game. Medkits use a **green plus**,
   never a red cross (the red cross is a protected emblem).

## 2. Palette (sRGB hex)
### Environment
| Role | Hex | Notes |
|---|---|---|
| Sand light | `#F7E4B5` | dry beach, main ground |
| Sand dark | `#E6C58C` | dunes, path edges, sand under props |
| Wet sand | `#C9A273` | 0–0.4 m above sea level, a band along the shoreline |
| Grass | `#7CC84F` | inland |
| Grass dark | `#5AA844` | hills, slopes over 30°, hard toon band |
| Dirt | `#B98A5A` | paths, village plaza |
| Palm leaf / dark | `#4CBB4A` / `#34983F` | fronds alternate |
| Palm trunk / dark | `#B07F52` / `#8A5D3B` | segments alternate (ring look) |
| Coconut | `#6B4428` | |
| Bush / dark / light | `#58B549` / `#3F9840` / `#82D35A` | |
| Hibiscus / flower centre | `#FF5C8A` / `#FFD23F` | small accents only |
| Rock / dark / light | `#9A96A0` / `#726D7C` / `#C3BFC4` | cool grey-violet, so rocks contrast with warm sand. Top faces are light, undersides dark |
| Sea shallow | `#4FD8D0` | depth 0 to about 1.5 m |
| Sea deep | `#1F7FBF` | depth about 6 m and deeper |
| Sea abyss | `#125A96` | beyond `worldRadius` and on the horizon |
| Foam | `#F4FBFF` | shoreline band and wave crests |
| Sky top | `#4FB2F0` | zenith |
| Sky horizon / fog | `#D2F1FF` | horizon and fog colour (they must match) |
| Ink (outlines) | `#2A1D33` | dark plum, never pure black |
| Ink soft | `#4A3A52` | secondary lines, UI shadow |

### Built props
| Role | Hex |
|---|---|
| Wood / dark | `#B57A48` / `#7E5333` |
| Plank / dark | `#D09A62` / `#B07E4C` |
| Bamboo / dark | `#D8B065` / `#A98443` |
| Thatch / dark | `#E0B85E` / `#BB9040` |
| Hut wall | `#E3B77A` |
| Door / window (dark recess) | `#5B3A29` |
| Crate / band | `#D39A5A` / `#86562F` |
| Driftwood / dark | `#D2C2A8` / `#A8957C` |
| Umbrella stripes | `#FF5A5F` coral + `#FFF4E2` cream |
| Towel | `#3FB7E8` |
| Boat hull / trim | `#F26B3A` / `#FFF4E2` |
| Tiki flame outer / inner | `#FF8A2A` / `#FFE066` (unlit) |

### Gameplay signals
| Role | Hex | Pairing (shape or pattern) |
|---|---|---|
| Danger (zone damage, low HP, kill marker) | `#FF3B5C` | always paired with an icon, pulse, or animation |
| Tide wall | `#46B8FF` body, `#EAFAFF` foam crest | animated wave stripes, see §8 |
| Loot common | `#F2F6FA` | 1 ring, no beam |
| Loot rare | `#2F9BFF` | 1 ring and a 1.2 m beam |
| Loot epic | `#B84DFF` | 2 rings, a 2.4 m beam, and 4 orbiting sparkles |
| Muzzle flash | `#FFF1A8` core, `#FF9D2E` edge | |
| Hit puff / spark | `#FFFFFF` / `#FFD23F` | |
| Hit marker / kill marker | `#FFFFFF` / `#FF3B5C` | the kill marker is also bigger and has a ring |
| Grenade body / segments | `#FF9F1C` / `#D97A12` | checker of pineapple segments, green leaf crown, ink outline |
| Grenade pin ring | `#FF3B5C` | ring shape; also the explosion / arc danger colour |
| Sight glass / red dot | `#9FE8F0` / `#FF3B5C` | glass discs on every sight; dot always inside an ink ring |

### Item levels (M2c): one scale for weapons, armor, HUD, ground markers and the kill feed
Full spec, checks and usage: `docs/art/M2c.md` §1. Names from narrative. Always paired with a numeral or pips.
| Level | Name | Base | Text on dark panel | Additive glow | Numeral |
|---|---|---|---|---|---|
| 1 | Breezy | `#B8E7FF` ice blue | `#B8E7FF` | `#B8E7FF` | ink |
| 2 | Warm | `#FFF14D` lemon | `#FFF14D` | `#FFF14D` | ink |
| 3 | Hot | `#F2590D` hot orange | `#FF7A3D` | `#FF8048` | ink |
| 4 | Scorcher | `#B963E3` UV violet | `#D08BF0` | `#D494F2` | ink |
The loot-tier colours below are retired from ground markers in M2c (the spot tier only rolls the level). Non-levelled
items use a cream supply marker.

### M2c family colours (`docs/art/M2c.md` §2–4, §14)
| Item | Main | Secondary |
|---|---|---|
| knife | steel `#D3DCE6` | coral handle `#FF7A5C` |
| machete | steel `#D3DCE6` | palm-green handle `#34983F` |
| paddle | plank `#D09A62` | teal tip `#2EC4B6`, cream stripe |
| dbshotgun | mint barrels `#7FDDB8` | waffle stock `#D9A05B`, strawberry `#FF8FB1` + vanilla `#FFF3D6` toy tips |
| revolver | sky `#4FB4EE` | sand-dollar cylinder `#F2E2C2`, walnut grip `#8A5A34` |
| rpg + rocket | cream `#FFF4E2` | coral spiral `#FF5A5F`, mango sunburst `#FFC43D` |
| smoke can / cloud | lilac `#C9B6F2`, pink hoops `#FFB3D1` | cloud `#FBEAF6` / `#EBCFF0` / `#C9AEDF`, veil `#EFDDF2` |
| scope accents | red dot cream `#FFF3D6`, 2x coral `#FF7A5C`, 4x cornflower `#5B8DEF`, 8x bubblegum `#FF6FA8` | |
| L4 armor | bell brass `#C98B2E`, board violet `#B963E3` | tape grey `#C9CED6` |

### Armor tiers (M2a)
Each tier is told apart by **silhouette first** (cloth hat vs vented dome vs ridged shell; open vest vs ribbed
puffer vs plate carrier), then by colour. Vests and helmets of a tier share the scheme.
| Tier | Look | Main | Dark / trim | Accent |
|---|---|---|---|---|
| 1 | soft cloth, beach-y | faded denim `#7FA8C8` | tan canvas `#D9B26F` | lighter brim `#9BBBD4` |
| 2 | padded, sporty | cobalt `#3A6FD8` | `#2B55B0` padded rim / zip | sporty white `#F4F7FB` |
| 3 | hard shell, tropical | slate `#3D4A5C` | `#2A3342` carrier, ear guards | hibiscus pink `#FF5C8A` + mango `#FFC43D` |

## 3. Lighting (M1: one fixed time of day, "late morning")
Values assume Three r155+ physical light units, `outputColorSpace = SRGBColorSpace`.
| Setting | Value |
|---|---|
| Sun (DirectionalLight) | colour `#FFF1D6`, intensity **2.4**, elevation about 55°, from the south-west (direction toward the sun ≈ `(-0.55, 0.75, 0.35)`) |
| Hemisphere light | sky `#C4E8FF`, ground `#E9D3A2`, intensity **1.0** (this is the "ambient". It lifts the shadow band of the ramp) |
| Tone mapping | `NeutralToneMapping`, exposure 1.0 (keeps the hues saturated). `NoToneMapping` is also acceptable |
| Shadows | PCF soft, map 2048, frustum follows the camera (about 60 m). The shadow colour comes from the ramp's shadow step plus hemisphere light, so never pure black. Characters and props cast shadows. Outlines, glows, flames and VFX never do |
| Fog | linear, colour `#D2F1FF`, near 60 m, far 260 m |
| Sky | vertical gradient from `#D2F1FF` at the horizon to `#4FB2F0` at the zenith, with a soft sun disc `#FFF6DA` |

M2c: these values are the island look preset **`noon`**. The other per-match presets (`morning`, `golden`,
`overcast`, and the office `day` / `evening` / `afterHours`) are in `docs/art/M2c.md` §10. Night stays out of scope.

## 4. Toon ramp
One shared 3×1 `DataTexture` (`RedFormat`, `NearestFilter`, no mipmaps). `getToonGradient()` builds it.
| Step | Value | Covers (u = N·L × 0.5 + 0.5) |
|---|---|---|
| Shadow | 0.42 | facing away from the sun |
| Mid | 0.74 | terminator band, a wide soft-looking band |
| Lit | 1.00 | facing the sun |

All characters, props, weapons and loot use **one** material: `MeshToonMaterial`, white, `vertexColors: true`, plus
this gradient (`vertexColorToon()`). Terrain should use `MeshToonMaterial` with the same gradient and vertex
colours. Water may use a custom shader but should quantise its lighting into 2–3 steps in the same way.

## 5. Outlines (inverted hull)
- A BackSide `MeshBasicMaterial` in ink `#2A1D33`. In the vertex shader the vertices are extruded in **view space**
  along a welded smooth normal (attribute `outlineNormal`), so boxes and faceted rocks get a hull with no gaps.
  The thickness is in world metres and does not depend on mesh scale. It works with `InstancedMesh` and with fog.
- Minimum thickness = `0.0012 × view depth`, which is about 1 px at 1080p and keeps silhouettes inked at 30 m+.

| Asset class | Thickness |
|---|---|
| Characters | 0.022 m |
| Small props (crate, bush, dock, umbrella, boat, driftwood) | 0.035 m |
| Large props (palm, rock, hut) | 0.045 m |
| Tiki torch | 0.025 m |
| Weapons (held) | 0.012 m |
| Loot items | 0.018 m |

- Outline only silhouette-defining pieces. Face decals, flowers, stripes, door panels and planks are excluded.
  Crates and docks use a simple proxy hull (a box) for clean lines.
- Outlines never cast or receive shadows and ignore raycasts.
- Optional later: a screen-space depth or normal edge pass for creases. The hull stays the main line.

## 6. Characters (chibi)
### Proportions (scale 1, feet at y = 0, facing −Z)
| Part | Size / position |
|---|---|
| Total height | about 1.33 m (1.39 with spiky hair or a hat) |
| Head | sphere r 0.25 (0.5 m diameter, about 38–40% of height), centre y 1.05 |
| Neck pivot | y 0.80 |
| Torso | capsule r 0.16, y 0.37–0.83, depth squashed to 82% |
| Shoulders | x ±0.215, y 0.73. Arms: capsule r 0.055, hand sphere r 0.064, hand at about 0.31 m below the shoulder |
| Hips | x ±0.085, y 0.42. Legs: capsule r 0.068, feet are squashed spheres that point forward |
| Face | tall ink ellipse eyes (x ±0.09) with a white highlight at the upper left, a blush oval in a pink-mixed skin tone, a small ink smile |

Pivots for animation: `body` (hips), `head` (neck), `armL` / `armR` (shoulders), `legL` / `legR` (hips).
`rotation.x > 0` swings a limb forward. A raised arm is `armR.rotation.x = π/2`. The weapon socket points the gun
along the arm. Right = +X.

### Variants (indices wrap)
**Skin (6):** `#FFE3CC` porcelain, `#F7C9A0` light, `#E2A878` medium, `#C68654` tan, `#8F5B3B` brown, `#5E3A26` deep.

**Hair:** style = `hair % 5`, colour = `hair % 6`, which gives 30 unique combinations for indices 0–29.
- Styles: spiky (9 cones), bob (cap + side/back curtain + bangs), ponytail (pink tie), bun, and sun hat (straw
  `#F7D774` with a ribbon in the hair colour).
- Colours: `#2B2530` ink black, `#6B4226` chocolate, `#F2C66D` blonde, `#E8693C` ginger, `#FF8FB1` pink,
  `#46B5D1` aqua.

**Outfits (10 entries, 6 styles):**
| # | Style | Main | Bottom | Accent | Feet |
|---|---|---|---|---|---|
| 0 | swim trunks + tank | `#FFD23F` | `#2E86DE` | white waistband | bare |
| 1 | sundress | `#FF7AA2` | – | `#FFF3C4` flowers and hem | sandals `#FFB627` |
| 2 | Hawaiian shirt + shorts | `#2EC4B6` | `#E9D8A6` | `#FF9F1C` flowers | sandals `#8A5A34` |
| 3 | wetsuit | `#2B2D42` | – | `#FF6B35` chest stripe, zip, cuffs | booties |
| 4 | rash guard + board shorts | `#4D96FF` | `#FF6B6B` (to the knee) | white stripe | bare |
| 5 | one-piece swimsuit | `#E63946` | – | `#F1FAEE` belt | sandals |
| 6 | trunks + tank | `#FFFFFF` | `#FF5A5F` | coral | sandals |
| 7 | sundress | `#8AC926` | – | white | bare |
| 8 | Hawaiian | `#FF595E` | `#1982C4` | `#FFCA3A` | bare |
| 9 | wetsuit | `#1982C4` | – | `#FFCA3A` | booties |

Rules: outfit colours are saturated and never sand-beige over large areas, so players pop against the beach. In
free-for-all, players are told apart by **silhouette** (hair style or hat, skirt or shorts, sleeves) as well as
colour. That is why the style table varies the shape and not just the hue.

**Budget:** colour mesh ≤ 1.5k tris (1.24–1.47k across all variants) + outline hull ≤ 1.15k. Keep the head the roundest part; limbs are open tubes between buried balls. 6 meshes + 6 hulls = 12 draw calls, 2 materials. Per-part breakdown in `docs/art/ASSET_LIST.md`.

## 7. Props
| Kind | Scale-1 size | Colour / look | Tris (colour + hull) |
|---|---|---|---|
| palm | trunk r 0.32→0.20, 6.6 m tall, leans 1.4 m toward +X. 8 fronds about 4.5 m crown | alternating trunk rings, 2-tone fronds, 3 coconuts | 648 + 648 |
| rock | about 1.5 m radius, 1.4 m above ground | faceted, light tops and dark undersides, plus a small satellite rock | 100 + 100 |
| bush | about 0.9 m radius, 1.1 m tall | 5 blobs in 3 greens, 4 hibiscus | 344 + 280 |
| crate | 1×1×1 | plank box, banded edges, X braces | 204 + 12 |
| hut | 4×4 m walls on stilts, eaves 4.75 m, 5.1 m tall, **door on local +Z** | thatched 2-tier pyramid roof, closed door, side windows | 376 + 296 |
| dock | 3×14 m, **origin at deck centre**, long axis local Z, deck top 0.55 m | alternating planks, pilings down to −1.9 m | 624 + 252 |
| umbrella | canopy r 1.2 at 2.25 m, plus a striped towel | coral/cream 8-wedge canopy | 128 + 32 |
| boat | 1.5×4 m rowboat, long axis local Z | coral hull, cream rim band, seats, 2 oars | 404 + 260 |
| tikiTorch | 2.45 m, flame at y 2.2 | bamboo pole, unlit 2-cone flame | 166 + 56 (+ flame 11) |
| driftwood | about 2.4 m log along local Z | bleached, faceted, with a branch stub | 76 + 76 |

## 8. Weapons (toy-like but readable)
Chunky boxes and tubes. Each weapon has one family colour and a cream "toy tip" (`#FFF3D6`) on the muzzle. The
matching ammo box uses the same family colour **and** a distinct bullet shape. Guns that share an ammo type
(dmr and lmg use heavy ammo) carry a band of the ammo colour instead of sharing the body colour, so every gun
keeps its own body colour **and** a unique silhouette (scope size, drum, bipod, stock).
| Weapon | Body | Secondary | Length | Sight | Ammo (colour + shape) |
|---|---|---|---|---|---|
| pistol | mango `#FFC43D` | dark grip `#3D3A4B` | 0.28 m | iron | light: yellow box, 3 short round-nose bullets |
| smg | teal `#2EC4B6` | dark, with a yellow band | 0.59 m | iron | light |
| shotgun | red `#E94F37` | wood `#B9783F` pump and stock | 1.0 m | iron (bead) | shells: red box, 3 fat flat-top shells |
| rifle | green `#3E9B5A` | sand handguard, dark mag and grip | 1.0 m | red dot | heavy: green box, 3 tall pointed bullets |
| dmr | cornflower `#5B8DEF` | green heavy-ammo band, dark straight mag, butt plate | 1.12 m | 4x scope (cornflower lip) | heavy |
| lmg | tangerine `#FF8A3D` | dark barrel shroud with tangerine bands, dark drum with tangerine face, folded bipod | 1.11 m | red dot (tangerine band) | heavy |
| sniper | navy `#34497A` | bubblegum `#FF6FA8` cheek riser, butt pad, bolt knob, fore-end band; folded bipod | 1.32 m | long 8x scope (pink lips and turrets) | sniper: pink box, **2** extra-long cartridges with a pink band and a copper tip |

### 8.1 Sights (M2a)
All sights sit on the gun's top, on an optical axis parallel to the barrel (zeroed at infinity: no tilt).
| Sight | Look | Used by |
|---|---|---|
| iron | front post + two-post rear notch in gun-dark, no outline (too small to ink) | pistol, smg, shotgun |
| red_dot | dark base block + short open hood (8-sided ring, inked), a family-colour band at the front of the hood, a pale glass disc `#9FE8F0` with a red `#FF3B5C` dot on its rear face | rifle, lmg |
| scope_4x | 0.22 m tube r 0.03 + objective bell r 0.044 + eyepiece r 0.038, family-colour objective lip and turrets, two mounts, glass both ends | dmr |
| scope_8x | 0.38 m tube r 0.033 + big objective bell r 0.056 (0.1 m long) + eyepiece r 0.044, pink lips, eyepiece band and turrets | sniper |

Every gun model has an empty child **`sight`** at the eye point (8–10 cm behind the rear lens for scopes and
the red dot, 22–30 cm behind the rear notch for iron sights). Its -Z is the line of sight and its +Y is up.
The glass discs are **opaque** (flat colour), so scope views must be a 2D overlay (§17) with the local body,
weapon and wearables hidden, not a camera looking through the 3D model.

## 9. Loot
- The item hovers at y 0.45. The renderer bobs and spins the `spin` child. Guns are shown side-on and enlarged
  (×1.35, pistol ×1.9).
- Ground marker: a translucent disc + a solid ring + an ink rim (contrast on pale sand). The tier is shape-coded
  (see §2) so it reads without colour vision.
- Heals: bandage (two cream rolls with pink stripes), medkit (white box, green plus, dark handle).
- Armor (M2a): the loot model is the wearable itself (§14), enlarged (vest ×1.15, helmet ×0.95). The legacy M1
  id `vest` draws the tier-1 vest. Gun loot scale: pistol ×1.9, dmr and lmg ×1.2, sniper ×1.05, others ×1.35.
- Grenade: the in-hand grenade ×2.4 (about 0.33 m tall), pin in.
- Ammo sniper: pink box with two tall cartridges (the only ammo with two rounds, so it reads by count too).

## 10. VFX look (for `graphics-engineer`)
- **Muzzle flash** (one frame plus a 60 ms fade): two crossed camera-facing quads or a 5-point star, core `#FFF1A8`
  and edge `#FF9D2E`, unlit and additive. Scale: pistol 0.25 m, smg 0.3, rifle 0.4, shotgun 0.5 (wider). Add a tiny
  puff ring of 3–4 grey-white cartoon smoke balls (`#F4F1EA`, ink outline optional) that drift up over 300 ms. Place
  it at the weapon's `muzzle` child.
- **Tracer**: thin stretched quad, `#FFF6C8` fading to transparent, 80 ms. Bullets are not physical, so this is
  only a hint.
- **Hit puff** (on characters): a burst of 4–6 white `#FFFFFF` squashed spheres or stars that scale up and fade in
  200 ms, plus 3 small yellow `#FFD23F` spark diamonds. No blood. On headshots, add a cartoon star ring.
- **Impact puff** (on terrain or props): a sand-coloured `#E6C58C` dust puff on sand, `#5AA844` leaf bits on grass
  and bushes, a white foam splash on water, and grey chips on rock.
- **Hit flash**: on damage, swap the victim's six meshes to a flash material (white toon, or emissive
  `#FF3B5C` at 0.6) for 80 ms. Do not tint the shared material.
- **Tide wall (zone edge)**: a translucent open cylinder that stands about 20 m tall. Colour `#46B8FF` at 35–45%
  opacity at the base, fading to 0 at the top, with scrolling horizontal wave stripes (lighter `#EAFAFF` foam
  bands, about 1.5 m apart, moving upward) and a solid foam lip where it meets the terrain. Visible from both sides.
  Outside the zone, add a light screen-edge vignette in `#46B8FF`, plus danger `#FF3B5C` pulses when damage ticks.
- **Death**: the character tips over, a cartoon "poof" cloud appears (white balls with an ink outline), and the
  body fades after 2 s.
- **Pickup**: a ring of 6 tier-coloured sparkles flies to the player, 250 ms.

## 11. UI palette suggestion (for `ui-ux-designer`, who owns the final choice)
| Role | Hex |
|---|---|
| Panel background | `#1D2B4A` at 80% (deep lagoon navy) |
| Primary accent (buttons, selection) | `#FFC43D` mango |
| Secondary accent | `#2EC4B6` teal |
| Text | `#FFFAF0`, with an ink `#2A1D33` 2 px text shadow or outline |
| Health | `#5EE06A` (pair with a heart/cross icon). Low health switches to `#FF3B5C` plus a pulse |
| Armor | `#4FA8FF` (pair with a shield icon) |
| Danger / zone | `#FF3B5C`. Zone ring on the minimap: `#46B8FF` current, white dashed next |
| Loot tiers | as in §2, always with the ring/beam icon |

Icon style: chunky rounded silhouettes with a 2 px ink outline and flat fills from this palette. No gradients
except a single top highlight. Use the same shapes as the 3D items (toy tip on guns, green plus on medkit).

## 12. Do / Don't
**Do**
- Keep large surfaces pale and warm (sand, thatch) and make actors saturated and cool or contrasting.
- Use 2-tone alternation (trunk rings, planks, fronds) instead of textures.
- Keep silhouettes readable at 30 m: big heads, hats and hair shapes, chunky guns.
- Reuse the shared toon material and palette for everything new.

**Don't**
- Use pure black (`#000`). Use the ink colour.
- Add photo textures, normal maps, metalness, or specular highlights.
- Use red crosses, real gun brand shapes, real-world logos, or other games' characters.
- Rely on red vs green alone for any gameplay distinction.
- Show blood or gore. Hits are white puffs and stars.

## 13. Requirements for `graphics-engineer` (materials and shaders)
- **Terrain**: `MeshToonMaterial` + `getToonGradient()` + vertex colours by height and surface: wet sand
  (0–0.4 m above sea level), sand, grass, with a hard (1–2 vertex) transition. Grass dark on steep slopes.
  Receives shadows. No outline.
- **Water**: plane or disc at y = 0. Colour lerps `#4FD8D0` to `#1F7FBF` by depth (`-heightAt`, 0 to 6 m), then
  `#125A96` toward the horizon. Shoreline foam band in `#F4FBFF` where the depth is under about 0.3 m, animated as
  1–2 scrolling stepped bands. Small animated stepped specular glints. Slight vertex bob of 0.05 m. Alpha about
  0.85 near the shore so wet sand shows through.
- **Instancing**: see `getPropParts(kind)`. Each kind gives `body` + `outline` (+ `flame` for the tiki torch), all
  with identity part matrices, so 10 kinds give about 21 InstancedMeshes for the whole island. The outline shader
  already reads `instanceMatrix`.
- **Characters**: 12 meshes each, 2 shared materials. For hit flash, swap `mesh.material`, don't mutate the shared one.
- **Loot glow**: unlit, `depthWrite: false`, polygon offset, render order 1–3. The beam is additive with vertex
  alpha in RGB, so it fades to invisible at the top.

## 14. Armor and helmets (M2a)
Factories: `createHelmetModel(tier)`, `createVestModel(tier)` in `src/render/procedural/wearables.ts`. One colour
mesh + one hull each, character outline width (0.022 m), shared toon material. Geometry is authored in the bone's
own frame, so the **attach transform is identity** (see `docs/art/ASSET_LIST.md` for the exact numbers).

| Tier | Helmet | Vest |
|---|---|---|
| 1 soft cloth | denim **bucket hat**: lathe crown (r 0.29, 0.23 m tall), sloped brim r 0.30→0.40, tan band and tab. Tilted back 0.15 rad so the brim clears the eyes | **open-front** denim vest: 0.56 rad gap at the front shows the shirt colour, tan edge trims, hem cord, two tan patch pockets |
| 2 padded sporty | cobalt **vented dome** (r 0.30, hemisphere tilted back 0.32 rad), fat padded rim roll, white front-to-back stripe, four dark vents | cobalt **ribbed puffer** (three horizontal bulges), white rolled collar, dark front zip, white side stripes |
| 3 hard shell | faceted slate **shell** (r 0.315, flat-shaded), hibiscus-pink brow lip, mango crest, slate ear guards with pink-and-mango flower emblems | slate **plate carrier**: dark carrier, flat-shaded front and back plates with pink rims, shoulder straps, hibiscus badge on the chest |

Fit rules (chibi head r 0.25 at neck-local (0, 0.25, 0); torso capsule r 0.16, hip-local y -0.05..0.41):
- Helmet front rims sit 0.08–0.11 m above the head centre, so the eyes (top at +0.05) stay visible from the usual
  over-shoulder and enemy views.
- Vests cover hip-local y 0.09–0.41 (chest) and stay inside r ≈ 0.21, so shorts, skirts and both arms stay
  visible: players are still told apart by outfit and silhouette while armored. Vest tops stay under the head
  sphere (the collar never pierces the chin at rest).
- **Hair under helmets.** Rebuild the head with `chibi.setVariant({ helmet: true })` while any helmet is worn:
  - sun hat: removed (`HELMET_HAIR_HINT.sunhat = 'hide'`, `hairHiddenByHelmet(hair)`); plain cap + soft fringe.
  - spiky: the crown spikes are replaced by five short spikes that flare out *below* the rim (back and sides),
    plus a fringe under the front rim, so the spiky silhouette survives.
  - bun: the top bun drops to a low bun at the nape.
  - bob and ponytail: unchanged; the curtain and tail hang below the rim.
  A unit test checks that no hair vertex more than 0.1 m above the head centre lies outside r 0.29.

## 15. Grenade (M2a)
`createGrenadeModel({ pin })` in `src/render/procedural/grenade.ts`. A cute pineapple frag: 0.13 m round body
(same size as the chibi's hand ball), squashed 1.1 tall, **tangerine checker segments** `#FF9F1C` / `#D97A12`,
dark fuse cap and spoon lever, a three-leaf green crown, and a **hot-pink pin ring** `#FF3B5C`. Outline 0.018 m
(the loot width) so it stays inked in the air. `pin: false` drops the ring for cooking / in-flight.
- In hand: child of `handR` at `GRENADE_DIMENSIONS.handOffset` = (0, 0, -0.075), no rotation (crown along the
  socket's +Y, the same "up" as a gun's top).
- In flight: scale ×1.5 (`flightScale`) and tumble about the origin (body centre). Optional trail: 4–6 small cream
  `#FFF3D6` puff dots with ink rims, spaced 0.25 m, fading over 300 ms.
- Fuse spark: at the child `fuse` (top of the cap). 2–3 tiny yellow `#FFD23F` / white star sparks that pop every
  120 ms while cooking or in flight; speed the pops up in the last second of the fuse.
- **Throw arc preview** (graphics-engineer / ui-ux-designer): a dotted line of cream `#FFF3D6` dots (r 0.04 m,
  ink rim) every 0.35 m along the predicted arc, and at the landing point a flat ring in danger `#FF3B5C` at
  the blast radius (dashed, 35% opacity) with a small solid inner ring. The dots shrink toward the end.
- **Explosion VFX**: a cartoon "boom" (not realistic fire): a 0.15 s flash star (5 points, core `#FFF1A8`, edge
  `#FF9D2E`, additive), then 6–8 squashed cream-and-orange smoke balls with ink outlines that puff out to the blast
  radius × 0.5 and fade over 0.6 s, a flat ground shock ring in `#FFFFFF` growing to the blast radius in 0.25 s,
  and 6 sand-coloured `#E6C58C` dust chunks (sand) or foam `#F4FBFF` splashes (water). Camera shake is small. No
  scorch decal (keep the beach clean); optional 2 s darker-sand `#C9A273` disc that fades.

## 16. Stances: crouch and prone (M2a)
The chibi has a **`stance` pivot** (M2a geometry change in `chibi.ts`): a Group at the feet origin, child of
`root`, parent of `body`, `legL`, `legR`. `root` keeps the world position + yaw (+ death tilt); stance poses go on
`parts.stance`, so they never fight the root. `resetPose()` resets it. Numbers below are exported as
`CHIBI_STANCES` (and `crouchLegAngle(drop)`) from `src/render/procedural/chibi.ts`; the pose code itself lives
in `characterPose.ts` (graphics-engineer). Conventions as §6: `rotation.x > 0` swings limbs forward, body/head
`rotation.x > 0` leans back / tilts the face up. All checked in headless renders.

**Visual fit (BUG-008, `docs/design/systems/stance.md` "Visual fit").** The sim hitbox is the truth; the posed chibi
must fit it with at most 0.1 m of hair over the top (the standing tolerance, 1.39 vs 1.30). "Eye" = head centre (the
head is centred on the stance `eyeHeight`, as `CHIBI_DIMENSIONS.eyeY` is when standing). Measured with precise mesh
bounds, every hair style, in `src/render/procedural/m2a.test.ts` ("BUG-008 stance visual fit"); QA's cross-check is
`tests/render/prone-hitbox-match.test.ts`.
| | Target | Shipped pose (hair 0) |
|---|---|---|
| Crouch head top | ≤ 1.05 m (0.95 + 0.1) | **1.04** (0.98–1.05 over all hair) |
| Crouch head centre | 0.72 ± 0.05 | **0.70**, face level |
| Prone head top, aim pitch 0 / -30° / +45° | ≤ 0.70 m (0.6 + 0.1) | **0.67 / 0.66 / 0.67** (≤ 0.69 over all hair) |
| Prone head centre | 0.35 ± 0.05, z ≤ -0.45 | **0.33**, z -0.51 / -0.56 / -0.45 (with head factor 0.3) |
| Prone body | inside 1.5 × 0.8 × 0.6 (+0.12), torso centre z > -0.25 | inside; torso centre z -0.24; belly 0.01 into the sand |
Exception: the **sunhat** brim reaches up to 0.13 m past the front face of the prone box (it is a thin brim; bullets
through it read as a near miss). The prone head tilt from aim pitch must use a factor **≤ 0.3** (`characterPose.ts`,
graphics-engineer): at 0.4 the head centre drifts to z -0.42 when looking up 45°.

### Crouch ("ready lunge")
| Joint | Value |
|---|---|
| stance.position.y | **-0.32** (BUG-008 deep squat; head top ≈ 1.04 m, was 1.24; hips 0.10 m above the ground) |
| legL.rotation.x / legR.rotation.x | **+1.33 / -1.33** (front and back leg; = `crouchLegAngle(0.32)`, soles stay on the ground) |
| legL.rotation.z / legR.rotation.z | -0.06 / +0.06 |
| body.rotation.x | **-0.40** (lean forward) |
| head.rotation.x | aim pitch × 0.5 **+ 0.40** (cancels the lean: face level at pitch 0) |
| arms | the normal aim pose, minus the body lean (arm.x = PI/2 + pitch + 0.40 for the aim arm) |
| crouch-walk | legs swing ±0.28 around their crouch angles with the walk phase, hip bob 0.015 m |
Sprint or jump from crouch: blend back to standing (the sim stands you up). With the stance-transition timer `k`
(0→1, ease-out), lerp every value from standing.

### Prone ("belly flop, elbows up")
Lies along the yaw on its belly, flat ("chin just above the sand"), head toward the aim direction (-Z) and in the
front 0.5 m of the sim prone box (the head zone), gun forward on the sand.
| Joint | Value |
|---|---|
| stance.rotation.x | **-PI/2** (face down) |
| stance.position | **(0, 0.16, 0.34)** (BUG-008; was (0, 0.15, 0.62)): belly and toes on the sand, hips 0.08 m behind the root, head centre at z ≈ -0.51 (head zone), toes at +0.36 |
| body.rotation.x | **-0.20** (BUG-008; was +0.22: the chest lies flat, slightly lower than the hips) |
| head.rotation.x | **+1.55** + aim pitch × **0.3** (world head tilt -0.22 rad: face forward and a little down, chin just above the sand; head centre 0.33 m) |
| armR.rotation | x = **PI - chestUp + aimPitch** (= PI + 0.20 + aimPitch), z = 0 (gun forward along the ground, top of the gun up) |
| armL.rotation | x = PI - 0.27 + aimPitch, z = **+0.45** (support hand under the fore-end) |
| legs | x = **-0.12** (heels up a little), z = ∓0.14 (slightly apart) |
| aim pitch | clamp to the sim's prone limits (`movement.stances.pronePitchMinDeg/MaxDeg`, -30..+45°); the head takes pitch × 0.3, the arms the full pitch |
| crawl | with the walk phase `s = sin(phase)`: legs z ∓0.14 - s × 0.22 (frog kick), armR.x + s × 0.18, armL.x - s × 0.18, body.rotation.y = s × 0.08 (shoulder roll). Weapon stays in hand |
| transition | stand→prone: first the crouch pose (k 0→0.4), then rotate stance.x to -PI/2 and slide to (0, 0.16, 0.34) (k 0.4→1), ease-in-out. Reverse for getting up. No firing until k = 1 (sim rule) |
| healing / reloading | keep the prone base, swap only the arm block (arms come in under the chin) |
| death while prone | no backward topple: roll onto the side (root tilt z → ±1.3 over 0.35 s), arms flop, then the usual poof |
Wearables, weapon and hand sockets follow automatically (they are children of the pivots).

## 17. ADS reticles and scope overlays (spec for ui-ux-designer)
Friendly and chunky: rounded caps and joins, every mark has an ink `#2A1D33` under-stroke so it reads on sky,
sand, grass and water. Never pure black. Sizes in CSS px at 1080p unless noted (scale with `vmin`).

**Iron sights** (over-shoulder ADS, crosshair becomes a dot): 32 × 32 px, centred.
```svg
<svg viewBox="-16 -16 32 32" width="32" height="32">
  <circle r="4.6" fill="#2A1D33" fill-opacity="0.85"/>
  <circle r="3" fill="#FFFAF0"/>
</svg>
```

**Red dot** (over-shoulder ADS): 48 × 48 px. A soft glow, an ink ring, a red dot, a tiny toy highlight, and an
optional faint housing ring that hints at the optic.
```svg
<svg viewBox="-24 -24 48 48" width="48" height="48">
  <defs>
    <radialGradient id="rdGlow"><stop offset="0" stop-color="#FF3B5C" stop-opacity="0.5"/><stop offset="1" stop-color="#FF3B5C" stop-opacity="0"/></radialGradient>
  </defs>
  <circle r="22" fill="none" stroke="#2A1D33" stroke-opacity="0.22" stroke-width="2.5"/>
  <circle r="13" fill="url(#rdGlow)"/>
  <circle r="4.8" fill="#2A1D33" fill-opacity="0.85"/>
  <circle r="3.3" fill="#FF3B5C"/>
  <circle cx="-1.1" cy="-1.1" r="1" fill="#FFE1E7"/>
</svg>
```

**Scope frame (both scopes):** full-screen layer shown after `adsTimeMs`.
- Lens: a circle of radius **42vmin** centred on screen. Outside it: `#140E1A` (deep ink) at 100%.
  CSS: `background: radial-gradient(circle at 50% 50%, transparent 0 41.6vmin, #2A1D33 41.6vmin 42.6vmin, #140E1A 42.6vmin);`
- Rim: a 1.0vmin ink ring (above) plus a 0.5vmin inner ring in the weapon family colour (4x cornflower
  `#5B8DEF`, 8x pink `#FF6FA8`) just inside it, then a soft inner shadow from 88% to 100% of the radius
  (`#140E1A` at 0 → 45% opacity). Optional glass tint over the lens: `#9FE8F0` at 5%.
- Scope-in: 120 ms "iris": the lens radius grows from 30vmin to 42vmin while the frame fades in. Scope-out: 80 ms
  fade. Small idle sway is the engineer's call.
- The reticle SVG below uses `viewBox="-100 -100 200 200"` sized to the lens diameter (84vmin), centred. Stroke
  widths use `vector-effect: non-scaling-stroke` (set per element: it does not inherit) so they are in CSS px. Marks are decorative (bullets are
  hitscan); the centre is the exact aim point.

**4x scope: chevron with mil ticks**
```svg
<svg viewBox="-100 -100 200 200" style="width:84vmin;height:84vmin">
  <style>path { vector-effect: non-scaling-stroke; }</style>
  <g fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- ink under-strokes -->
    <g stroke="#2A1D33" stroke-width="7">
      <path d="M-100 0 H-42 M42 0 H100 M0 100 V48"/>
      <path d="M-9 9 L0 0 L9 9"/>
    </g>
    <g stroke="#2A1D33" stroke-width="2.4">
      <path d="M-42 0 H-14 M14 0 H42 M0 14 V48"/>
      <path d="M-24 -4 V4 M-34 -3 V3 M24 -4 V4 M34 -3 V3"/>
      <path d="M-5 22 H5 M-4 30 H4 M-5 38 H5"/>
    </g>
    <!-- colour strokes -->
    <g stroke="#3D3A4B" stroke-width="4"><path d="M-100 0 H-42 M42 0 H100 M0 100 V48"/></g>
    <g stroke="#FF3B5C" stroke-width="3.2"><path d="M-9 9 L0 0 L9 9"/></g>
  </g>
</svg>
```
Chevron tip at (0, 0) = aim point. Thick slate posts from the edges, thin ink lines toward the centre, mil
ticks every 10 units (short ticks on the horizontal, drop ticks under the chevron).

**8x scope: fine crosshair with mil-dots**
```svg
<svg viewBox="-100 -100 200 200" style="width:84vmin;height:84vmin">
  <style>path { vector-effect: non-scaling-stroke; }</style>
  <g fill="none" stroke-linecap="round">
    <g stroke="#2A1D33" stroke-width="7"><path d="M-100 0 H-60 M60 0 H100 M0 -100 V-60 M0 60 V100"/></g>
    <g stroke="#2A1D33" stroke-width="1.6"><path d="M-60 0 H-2.5 M2.5 0 H60 M0 -60 V-2.5 M0 2.5 V60"/></g>
  </g>
  <g fill="#2A1D33">
    <circle cx="-50" r="1.3"/><circle cx="-40" r="1.3"/><circle cx="-30" r="1.3"/><circle cx="-20" r="1.3"/><circle cx="-10" r="1.3"/>
    <circle cx="10" r="1.3"/><circle cx="20" r="1.3"/><circle cx="30" r="1.3"/><circle cx="40" r="1.3"/><circle cx="50" r="1.3"/>
    <circle cy="-50" r="1.3"/><circle cy="-40" r="1.3"/><circle cy="-30" r="1.3"/><circle cy="-20" r="1.3"/><circle cy="-10" r="1.3"/>
    <circle cy="10" r="1.3"/><circle cy="20" r="1.3"/><circle cy="30" r="1.3"/><circle cy="40" r="1.3"/><circle cy="50" r="1.3"/>
  </g>
  <circle r="1.1" fill="#FF3B5C" stroke="#2A1D33" stroke-width="1" vector-effect="non-scaling-stroke"/>
</svg>
```
Thin 1.6 px ink lines with a 5-unit open gap at the centre and a tiny red centre dot, round mil-dots every 10
units, and chunky 7 px posts from the edges (duplex) so the crosshair is findable on any background.

## 18. HUD and kill-feed icons for M2a items (spec for ui-ux-designer)
Icons live in `src/ui/icons.ts` (ui-ux-designer). The current scheme is a CSS clip-path shape + family colour, and
ammo shares its weapon family's shape. Suggested additions (shape is the primary code, colour secondary):
| Id | Shape | Colour | clip-path |
|---|---|---|---|
| dmr | hexagon | `#5B8DEF` | `polygon(25% 4%, 75% 4%, 100% 50%, 75% 96%, 25% 96%, 0 50%)` |
| lmg | octagon | `#FF8A3D` | `polygon(30% 0, 70% 0, 100% 30%, 100% 70%, 70% 100%, 30% 100%, 0 70%, 0 30%)` |
| sniper, ammo_sniper | star | `#FF6FA8` | `polygon(50% 0, 61% 35%, 98% 35%, 68% 57%, 79% 91%, 50% 70%, 21% 91%, 32% 57%, 2% 35%, 39% 35%)` |
| grenade | "pineapple" | `#FF9F1C` | `polygon(40% 0, 60% 0, 60% 14%, 80% 22%, 96% 45%, 96% 72%, 80% 92%, 50% 100%, 20% 92%, 4% 72%, 4% 45%, 20% 22%, 40% 14%)` |
| helmet_1..3 | dome | tier main colour (§2 armor tiers) | `polygon(50% 8%, 78% 16%, 95% 40%, 100% 72%, 100% 86%, 0 86%, 0 72%, 5% 40%, 22% 16%)` |
| vest_1..3 | shield (existing) | tier main colour | existing `shield` |
Armor tier is also shown by **1–3 pips** (small ink-rimmed diamonds) under the icon, never by colour alone.

Full SVG icons for the HUD armor panel and the kill feed (32 × 32, 2 px ink outline, flat fills, one top
highlight, same shapes as the 3D items):
```svg
<!-- grenade (kill feed + slot 4) -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <path d="M16 1.5 L18.5 7 H13.5 Z M10.5 3.5 L14 7.5 H11 Z M21.5 3.5 L18 7.5 H21 Z" fill="#4CBB4A"/>
  <rect x="12" y="7" width="8" height="5" rx="1.5" fill="#3D3A4B"/>
  <ellipse cx="16" cy="20.5" rx="9.5" ry="9.8" fill="#FF9F1C"/>
  <circle cx="25.5" cy="9.5" r="3" fill="none" stroke-width="4"/>
</g>
<circle cx="25.5" cy="9.5" r="3" fill="none" stroke="#FF3B5C" stroke-width="2"/>
<path d="M8 17 H24 M7 22 H25 M9 27 H23 M16 11 V30" stroke="#D97A12" stroke-width="1.5" fill="none"/>
<ellipse cx="12.5" cy="15.5" rx="2.6" ry="1.5" fill="#FFF3D6" fill-opacity="0.7"/></svg>

<!-- helmet tier 1: bucket hat -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <path d="M9 19 L11 8.5 Q16 6 21 8.5 L23 19 Z" fill="#7FA8C8"/>
  <path d="M2 21 Q16 16 30 21 L28.5 24.5 Q16 20.5 3.5 24.5 Z" fill="#9BBBD4"/>
</g><path d="M10 16.5 H22" stroke="#D9B26F" stroke-width="2.5"/></svg>

<!-- helmet tier 2: vented dome, white stripe -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <path d="M4 22 C4 12 9.5 6 16 6 C22.5 6 28 12 28 22 Z" fill="#3A6FD8"/>
  <rect x="2.5" y="21" width="27" height="4.5" rx="2.2" fill="#2B55B0"/>
</g><path d="M16 7 V21" stroke="#F4F7FB" stroke-width="2.5"/>
<path d="M9.5 13 L11.5 11 M22.5 13 L20.5 11" stroke="#2A1D33" stroke-width="2" stroke-linecap="round"/></svg>

<!-- helmet tier 3: shell, pink brow, mango crest, ear guard -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <path d="M14 7 L16 3 L18 7 Z" fill="#FFC43D"/>
  <path d="M4 22 L5.5 13 L10 8 L16 6.5 L22 8 L26.5 13 L28 22 Z" fill="#3D4A5C"/>
  <rect x="3" y="18.5" width="26" height="4.5" rx="1.5" fill="#FF5C8A"/>
  <circle cx="7" cy="25" r="3.5" fill="#2A3342"/>
</g><circle cx="7" cy="25" r="1.3" fill="#FFC43D"/></svg>

<!-- vest tier 1: open front -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round" fill="#7FA8C8">
  <path d="M8 5 H13 L14.5 12 V28 H6 V12 Z"/><path d="M24 5 H19 L17.5 12 V28 H26 V12 Z"/>
</g><path d="M8 20 h4 M20 20 h4" stroke="#D9B26F" stroke-width="3"/></svg>

<!-- vest tier 2: ribbed puffer -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <path d="M10 4 Q16 7 22 4 L26 10 V28 H6 V10 Z" fill="#3A6FD8"/>
</g><path d="M7 15 H25 M7 21 H25" stroke="#2B55B0" stroke-width="2"/>
<path d="M11 5.5 Q16 8.5 21 5.5" stroke="#F4F7FB" stroke-width="2.5" fill="none"/><path d="M16 8 V27" stroke="#2B55B0" stroke-width="1.5"/></svg>

<!-- vest tier 3: plate carrier -->
<svg viewBox="0 0 32 32"><g stroke="#2A1D33" stroke-width="2" stroke-linejoin="round">
  <path d="M9 4 H13 L14 8 H18 L19 4 H23 L26 10 V28 H6 V10 Z" fill="#2A3342"/>
  <rect x="9" y="11" width="14" height="13" rx="1.5" fill="#3D4A5C" stroke="#FF5C8A" stroke-width="2"/>
</g><circle cx="16" cy="17.5" r="2.6" fill="#FF5C8A"/><circle cx="16" cy="17.5" r="1" fill="#FFC43D"/></svg>
```
Durability: a ring or bar around/under the armor icon in UI armor blue `#4FA8FF`; when broken, the icon goes 40%
opacity with a diagonal ink slash (shape cue, not colour only).

## 19. Office map (M2b)
"Tiny heroes": the office is built at **9x real size** (`OFFICE_SCALE`), so the chibis are desk-toy sized. Desk tops
are plateaus 6.66 m up, chairs are 10 m tall, a coffee mug is a 0.9 m barrel. Same art rules as the island:
chunky flat colour, the 3-step toon ramp, plum ink hulls, readable silhouettes. The office is the **pale, warm
backdrop** (white desks, warm wood, white walls) and the characters and loot stay the saturated actors. Props:
`src/render/procedural/office.ts` (code mirror of the palette below: `officePalette`). Reference images were used
for layout and mood only (see `CREDITS.md`); no names, logos, signage or people.

### 19.1 Palette
| Role | Hex | Notes |
|---|---|---|
| Floor planks | `#D9AE7A` / `#CB9C66` | light wood, two tones from `officeFloorColorAt(x, z)` |
| Plank seams | `#A97C4D` | thin dark lines between planks (texture or edge band) |
| Carpet (meeting rooms) | `#5E6F8A` / `#56667F` | slate blue, 2-tone tile pattern 4.5 m squares |
| Tile (toilet / pantry) | `#E6EEF0`, grout `#C5D2D6` | 2.7 m tiles |
| Walls | `#F3F1EA` warm white, shade `#DCD8CD` | skirting `#C8A06E` light wood |
| Exposed ceiling | `#3A3F47` | dark; ducts and pipes `#8A9099` |
| Desk top / frame | `#F7F7F4` white / `#E2BE8A` light wood (or the reverse on `deskWood`) | |
| Chairs | `#363A44` mesh, `#4E5462` stripes, `#262A31` plastic | the darkest big shapes; keep them off pure black |
| Screens | bezel `#2A2D34`, screen `#36507A`, window `#6C8FC2`, task bar `#A9C4E8` | generic "app window", never a real UI or logo |
| Glass tint / frost | `#BFE6F0` at 22% / `#F4FAFC` at 72% | see 19.3 |
| Light diffuser | `#F4FBFF` lit, `#5A6270` off | unlit material |
| Accents | plush crab `#FF7A5C`, whale `#8EDFD0`, seal `#DCD6F0`; extinguisher `#E23B2E`; ping pong `#2F6DB5`; book spines `#E4572E #2E86AB #F2C14E #4C9F70 #8E6CBF #F28FAD`; sticky notes `#FFF07A #FF9FB8 #9FE8F0 #B8F28C #FFC98A` | small saturated pops; nothing bigger than a plush is saturated, so players stay the brightest things |

### 19.2 Floor
Light wood planks: **1.8 m wide** (0.2 m real) along X, **10.8 m long** (1.2 m real), staggered by a third per row,
two tones (`officeFloorColorAt`), 0.08 m `#A97C4D` seams. Flat colour, no grain texture (a texture of the plank
pattern with seams is fine). Toon-lit, receives shadows. Carpet and tile zones from the map data use the colours
above with the same "no noise" rule. A soft darker contact band (`#B98A5A`, 30%) under desk rows helps the
under-desk crawlspace read.

### 19.3 Glass (toon style)
Glass blocks movement and bullets but must read as see-through:
- **Pane**: `officeGlassMaterial()`, unlit `#BFE6F0` at 22% opacity, double-sided, no depth write, render order 1.
  No reflections, no refraction, no fresnel.
- **Frame**: aluminium `#B9BEC6` rails and mullions in the opaque body with ink hulls. The outline lives on the
  frame, so every pane has a crisp inked border.
- **Frosted band**: `officeFrostMaterial()` `#F4FAFC` at 72%, 4.5 m tall from 9 to 13.5 m (1.0–1.5 m real),
  across the whole pane. It reads as "glass" at a glance. The band is far above chibi height, so players inside
  glass rooms stay visible from the floor; players standing on desk tops (6.7–8 m) stay just below it too.
- **Glare**: two parallel diagonal white streaks (one thick, one thin) in the upper part of each pane, on both
  faces (frost material). This is the cartoon "this is glass" cue.
- Shadows: glass does not cast shadows.

### 19.4 Lighting mood
Fluorescent cool-white with warm accents. Interior only (no sky).
| Setting | Value |
|---|---|
| Key light | DirectionalLight `#F2F8FF`, intensity **1.8**, almost overhead (direction toward light ≈ `(-0.25, 0.9, -0.35)`), shadows from the desks and chairs onto the floor (shadow map follows the camera, ~80 m) |
| Hemisphere | sky `#EEF6FF`, ground `#D9AE7A` (bounce off the wood floor), intensity **1.25** |
| Warm accents | 3–6 small warm PointLights `#FFD9A0` (intensity low, range ~40 m) at the pantry, the coffee machine, the music/gym room and the doorway; or bake them as warm vertex tint on nearby props |
| Light panels | the `glow` diffusers are unlit `#F4FBFF` and never tone-mapped, so they read as light sources; optional cheap bloom-free halo: a faint additive quad under each panel |
| Under desks | darker by design: an ambient-occlusion style multiply (0.75) on floor and chibis while under a desk top, from a simple "covered" test or a blob decal; this is the crawlspace mood |
| Fog | linear `#3A3F47` from 120 m to 300 m, so the far side of the floor fades into the dark ceiling colour |
| Background | the clear colour is the ceiling `#3A3F47`; nothing renders above the ceiling plane at 27 m |

### 19.5 The outside zone indoors (pick one: game-designer)
Both keep the circle mechanic and the island's rules (screen-edge vignette, damage ticks with a danger pulse).

**Option A, "Lights Out"** (recommended: cheap, very readable)
- Outside the circle, light panels switch to `officeGlowOffMaterial()` (`#5A6270`) per panel as the edge passes.
- Everything outside is multiplied toward a cold night blue: a full-screen-space or per-material uniform
  `outsideTint = #2B3A5C` at 55% applied by distance to the zone edge, with a soft 6 m gradient at the boundary.
- The boundary itself: a wall of faint vertical light shafts / dust motes in `#9FD3FF` at 25%, 20 m tall
  (reuse the tide-wall cylinder with a dusty texture and colour swap), plus a floor line of cool-blue light.
- Monitors outside the circle keep their screen colour (they glow in the dark): a lovely readability cue.
- Player vignette outside: `#2B3A5C` instead of the island's sea blue; danger `#FF3B5C` pulses unchanged.

**Option B, "Sprinkler"**
- Outside the circle, ceiling sprinkler rain: GPU line particles (`#CFEFFF` at 50%, 0.4 m streaks, falling 25 m/s),
  spawned in cells near the camera only.
- The floor outside gets a wet sheen: plank colours lerp 25% toward `#8FA6B5` with stepped (toon) specular glints,
  and splash rings (white `#F4FBFF`, 0.6 m) pop on desk tops and the floor.
- The boundary: a soft curtain of falling water (tide-wall cylinder, `#9FD3FF` body, white streaks scrolling
  down instead of up).
- Player vignette outside: `#46B8FF` (same as the tide), so it maps to the island's "water hurts" fiction.
- Costs more fill-rate than A; needs a particle budget (≤ 3k streaks on medium).

### 19.6 Do / Don't (office)
- Do keep desks, walls and floor pale and warm; keep chairs dark grey, not black.
- Do put the saturated colour on small clutter (plushies, books, notes, extinguishers) and on players and loot.
- Don't add signage text, nameplates, logos, posters with people, or a real product UI on screens.
- Don't let glass go fully clear: the tint, frame outline, frosted band and glare streaks are all required.

## 20. Plane drop: carriers, parachute, freefall (M2b)
Models: `src/render/procedural/carrier.ts`; numbers: `docs/art/ASSET_LIST.md` "Carriers and parachute".

### 20.1 Carriers
- **Seaplane (island)**: a chunky toy twin-engine high-wing floatplane. Sunny yellow `#FFD23F` fuselage with a
  coral `#FF5A5F` cheat line, cream `#FFF4E2` belly, wings and stabiliser, coral wingtips, coral wing bands, coral
  nacelles and tail fin, teal `#2EC4B6` floats with a cream stripe, navy round windows with cyan glints. The open
  side door (dark opening, door leaf swung forward) is on the **left (−X)** side: the camera orbit should favour
  that side during the countdown so players see where they jump from. From far below it reads as a cream cross
  with coral tips and two teal bars.
- **Delivery drone (office)**: a white egg-shaped quadcopter with a mango band, cute cyan LED "eyes" on the front,
  coral motor pods, dark two-blade rotors, four dark claw straps holding a big taped cardboard parcel with a teal
  label. Compact (7.7 m wide, 4.9 m tall) so it fits between the light panels and the 27 m ceiling.
- **Spinners**: rotate `propellerL` / `propellerR` about Z and `rotor0..3` about Y (≈ 25–40 rad/s visually). Above
  ~15 rad/s show each spinner's `blur` disc and keep spinning the blades slowly (toon motion blur).
- Both carriers cast shadows. Optional VFX: two short white contrails off the seaplane wingtips; a soft dust ring
  on the floor under the drone is not needed (too high).

### 20.2 Parachute
Beach-umbrella canopy: a flattened dome (r 2.8 m, 8 gores in alternating towel / umbrella stripes, a small vent
cap), a darker inner side so it reads from below, 8 thin plum lines to two risers at the shoulders, and a small
striped backpack while packed. Deploy: about 0.35 s from `deploy` 0 → 1 (ease-out-back built into
`setParachuteDeploy`), with a little "pop" puff of 4 cream cartoon smoke balls at the canopy. On landing: 0.4 s
collapse (1 → 2), then hidden. Stripe variant from the player id (or team).

### 20.3 Freefall pose ("belly flop in the sky")
Rotate the **stance pivot about the hips** so the body lies belly-down: `stance.rotation.x = −1.35`,
`stance.position = freefallStanceOffset(−1.35)` ≈ (0, 0.33, 0.41). Root keeps the world position and yaw.
| Joint | Value (`CHIBI_FREEFALL.freefall`) |
|---|---|
| head.rotation.x | **+1.0** (face looks forward / down the flight path) |
| armL / armR | x **+0.5**, z **−1.25 / +1.25** (spread wide, slightly forward) |
| legL / legR | x **−0.35**, z **−0.35 / +0.35** (spread, trailing) |
| flutter | ±0.08 rad on arm / leg z at ~9 rad/s |
| steering | bank: stance.rotation.z = steerX × 0.35; dive: add up to −0.35 to the pitch when pushing forward (faster fall), +0.2 to flare |
| weapon | hidden; the packed parachute backpack is visible |

### 20.4 Parachute hang pose
Upright (stance identity, root tilt 0). Values: `CHIBI_FREEFALL.hang`.
| Joint | Value |
|---|---|
| armL / armR | x **2.75** (hands up on the risers), z **−0.25 / +0.25** |
| legs | legL.x **0.22**, legR.x **0.12** (dangling, a little apart), z ∓0.05; slow swing ±0.08 |
| body / head | body.x −0.05, head.x +0.1 |
| sway | root or stance z = sin(t × 1.3) × 0.06; steering banks up to ±0.25 (the canopy, a child of the stance pivot, tilts with it) |
| weapon | hidden while hanging; it reappears on landing |
Transition freefall → hang: blend over the deploy time (0.35 s) while the canopy opens; the jolt can be a quick
0.1 s squash of the stance scale y (0.92) and back.

## 21. First-person viewmodel (M2b)
Code: `src/render/procedural/viewmodel.ts` (`createViewmodel`, `VIEWMODEL_POSES`, `applyViewmodelPose`); numbers and
the full pose table: `docs/art/ASSET_LIST.md` "First-person viewmodel". The animation itself is the
graphics-engineer's (viewmodel pass); the keyframes below are the art spec.

### 21.1 Look
- **Chibi forearms**: stubby open tubes (r 0.034 → 0.042, 0.34 m long) that run off the bottom of the screen,
  **mitten hands** (round palm, one mitten "finger block" on a knuckle pivot, a thumb nub), and a **wrist cuff**.
  Colours come from the Appearance: skin tone; long-sleeve outfits (wetsuit, rash guard) colour the forearm with
  the outfit top and the cuff with the accent; bare-arm outfits show skin with an accent-colour wristband.
- **Outlines**: one shared thin hull material for the whole viewmodel, ~2 px at any distance (never the world
  widths: 0.012 m at 0.3 m would be 40 px). Weapons swap to it via `applyViewmodelOutlines`.
- **Toy scale**: the guns are the same chunky toys as in the world; at the hip they fill the lower-right quarter
  and the muzzle points toward the screen centre. Viewmodel FOV is `clientFeel.viewmodelFovDeg` (55° vertical; `VIEWMODEL_FOV` = 55 is only the fallback). The poses were framed at 50° and re-framed for 55° by scaling camera-space depth by tan 25° / tan 27.5° = 0.896 (`VIEWMODEL_FOV_DEPTH`), so they keep the approved on-screen place and size.
- **Lighting**: the viewmodel pass uses the world's sun + hemisphere light (or the office key light), so the toon
  bands match; no shadows on or from the viewmodel.
- **Sights through the view axis**: iron sights show the two rear posts with the front post tip on the screen
  centre (the HUD dot can sit on top); the red-dot hood frames a see-through pale-aqua lens with a round red dot
  on the centre; scopes are hidden by the full-screen overlay (§17) after `adsTimeMs` (the eyepiece filling the
  view during the zoom-in is the intended transition).
- **Armor** (optional, only if cheap): tint the cuff with the vest tier colour (§2 armor tiers).

### 21.2 Reference poses
`VIEWMODEL_POSES` is authoritative: `hip` and `ads` place the item socket in camera space; `handR` / `handL` are
hand-bone targets in item space; `curlR` / `curlL` close the mittens (-1.6 = fist). Summary:
- Guns: right hand on the grip (palm in, elbow out), left hand palm-up under the fore-end (pistol: cupping under
  the grip). Hip: lower right, 0.42–0.55 m out, yawed 0.14–0.16 rad toward the centre and rolled −0.06 rad.
  ADS: `pos = −sight.eye`, rotation 0. Blend hip → ADS over `adsTimeMs` with ease-in-out (position lerp,
  rotation slerp); finger curl unchanged.
- Fists: two fists in a guard, right one forward-lower-right, left one higher and further back; no item.
- Grenade (pin in): grenade on the right palm, left fingers pinching the pink pin ring. `grenade_cooking`: pin
  pulled, left hand lowered out of view. The "ads" pose of both is the throw wind-up (grenade raised beside the
  head).
- Bandage / medkit: held in front with both hands at the sides (`itemScale` 0.6 / 0.65); no ADS.

### 21.3 Animation keyframes (offsets added on top of the reference pose)
Units: metres and radians in camera space; times in ms or as a fraction `t` of the action's balance duration.
Ease = ease-in-out unless noted. "Socket" = `itemSocket`.

**Idle sway** (always, ×0.25 while ADS): socket pos x += 0.004·sin(1.1t), y += 0.003·sin(2.2t + 0.6) (t in s);
rot z += 0.01·sin(1.1t). Breathing.

**Look lag**: socket rot y/x lag the mouse by a spring (≈ 0.035 rad per 1 rad/s of turn, max 0.06, settle ~120 ms).

**Walk / sprint bob** (phase from distance, like the 3P walk cycle; off when head bob is disabled or reduced
motion is on; ×0.2 while ADS):
| | x amp | y amp | rot z amp | Extra |
|---|---|---|---|---|
| walk | 0.010 (1× phase) | 0.008 (2× phase, |sin|) | 0.015 | — |
| sprint | 0.022 | 0.016 | 0.04 | socket pos += (0.04, −0.05, +0.03), rot += (−0.25, 0.35, 0.3): gun tilted across the chest |
| crouch walk | 0.008 | 0.006 | 0.01 | socket y −0.01 |
| prone crawl | 0.016 (with each arm pull) | 0.01 | 0.03 | socket pos += (0, −0.04, +0.04), rot x −0.1 |
| airborne | — | land: y −0.03 dip, 120 ms out, 200 ms back | — | — |

**Stance change**: the camera eye height follows the sim; the viewmodel dips y −0.025 and recovers over the
stance transition so the change reads.

**Recoil kick per shot** (attack 0, decay exponential; ADS ×0.5 position, ×0.6 rotation):
| Weapon | pos z (back) | rot x (muzzle up) | rot z (roll, random sign) | decay ms | Notes |
|---|---|---|---|---|---|
| pistol | +0.035 | 0.10 | 0.03 | 110 | slide snap |
| smg | +0.018 | 0.04 | 0.02 | 60 | add 0.004 random x/y jitter |
| shotgun | +0.07 | 0.20 | 0.04 | 220 | then pump: socket y −0.02 and left hand z +0.08 back, 180 ms, return 160 ms |
| rifle | +0.028 | 0.06 | 0.02 | 80 | |
| lmg | +0.022 | 0.05 | 0.03 | 70 | heavy: add socket y −0.01 sag while firing |
| dmr | +0.05 | 0.12 | 0.02 | 160 | |
| sniper | +0.09 | 0.22 | 0.03 | 260 | then bolt: right hand x +0.06, z +0.07 (pull), 200 ms; back 180 ms |

**Reload** (t = 0..1 of `reloadMs`; guns):
| t | Socket | Left hand | Notes |
|---|---|---|---|
| 0 → 0.15 | rot (+0.15, +0.25, +0.35), pos y +0.03 | leaves the fore-end | gun tilts toward the player |
| 0.15 → 0.4 | hold | moves to the mag (item space ≈ mag position), then down off-screen (y −0.25) | old mag drops (optional VFX) |
| 0.4 → 0.7 | hold | comes back up with the new mag, pushes it in at t 0.65 (socket kick y +0.01) | |
| 0.7 → 0.85 | hold | slaps the side / charging (x −0.04) | lmg: lid open / close; shotgun: insert shells: 3 left-hand dips |
| 0.85 → 1 | back to reference | back to the fore-end | |

**Heal** (`healMs`): bandage: both hands circle in opposite phase (r 0.03, 3 loops), the roll item rotates
around its X axis 2 turns, socket y −0.02. Medkit: socket rises (y +0.04, rot x −0.3: lid toward the player) by
t 0.2, both hands tap in alternation at 6 Hz until t 0.85, then lowers.

**Swap** (`swapMs`, about 250 ms): old item drops (socket y −0.25, rot x +0.6) in the first 45%, the new item
rises from the same offset in the last 55% (ease-out); hands follow their targets.

**Grenade**:
| Phase | Time | Socket | Hands |
|---|---|---|---|
| equip | swap | rises | right palm under the grenade, left pinches the pin |
| pull pin (LMB down) | 0 → 150 ms | small shake | left hand pulls back (x −0.06, z +0.05) with the ring; switch model to `grenade_cooking`, left hand lowers out |
| cook / aim | hold | blend to the `ads` wind-up pose over 200 ms; fuse sparks at `fuse`; jitter rot z ±0.02 increasing as the fuse runs out | — |
| throw (release) | 0 → 120 ms | arc forward: pos → (0.05, −0.02, −0.6), rot x −0.6 (overhand); grenade detaches at 60% | right fingers open (curl 0) at release |
| recover | 120 → 400 ms | arm drops off-screen (y −0.3), then the next item (or another grenade) rises like a swap | — |
| drop at feet (swap while cooking) | 200 ms | socket drops y −0.3 | hand opens |

**Punch** (fists, per hit, about 280 ms): right fist jabs from the guard to (0.06, −0.06, −0.62) with rot
(−0.15, −0.25, 0) in 90 ms (ease-out), holds 30 ms, returns in 160 ms; the left fist pulls back 0.03 and the
view kicks rot x 0.01. Alternate hands on consecutive hits.

**Parachute / freefall**: hide the item; arms up on the risers (hands at (±0.18, +0.22, −0.25), fingers curled)
while the canopy is open; in freefall the arms spread out to the screen edges (hands at (±0.45, −0.05, −0.35)).

## 22. M2c: "Fresh Every Match & Bigger Arsenal" (spec: `docs/art/M2c.md`)
- **Item levels 1–4**: the heat-ladder colours in §2, a raised **level collar** with N pips on every weapon (same spot on
  every gun: the receiver front, ahead of the trigger hand), ground markers with N pips plus ring count and beam height,
  and armor tier accents recoloured to the level colour.
- **New items**: Shucking Knife, Coconut Machete, Lifeboat Paddle, Double Scoop Shotgun, Sand Dollar Revolver, Sunburst
  Launcher + rocket + Fireworks ammo, Candyfloss Smoke Bomb (cylinder + candyfloss cap: never round like the frag),
  Ship's Bell Helmet (L4), Surfboard Vest (L4).
- **Smoke cloud**: opaque cel puffs around an opaque core at 0.88 × the sim radius, 3 draw calls for all clouds, a veil
  while the camera is inside, a dithered fade. **Rocket boom** = the grenade boom scaled + a fireworks burst. **Glass
  shatter**: a new effect built on the M2b glass chip.
- **Scopes** (§14 of M2c.md): every gun has a `rail` anchor, and every scope has one frame, so `eye = rail + scope.eye` and
  ADS lines up for any pair. There is a new **2x overlay** ("sunrise ring", lens 46vmin) next to the §17 4x/8x overlays.
- **Layout variety**: island and office prop kits (sim vs decor), `variant` colourways, and look presets (§3 is `noon`).
- **A body per item level** (Addendum 2 + 4, M2c.md §15 and §17): each level has its own silhouette. L1 salvaged
  (driftwood, bamboo, pipe, crate and cord parts; dulled, taped, cord loop), L2 standard, L3 upgraded (dark polymer
  rails, shrouds, long or box mags, foregrips, bipods, tube stocks; ribbed grip), L4 premium (smooth family-colour
  shells, thumbhole / skeleton stocks, chrome and gold, star badge). Anchors identical at every level.
- **Budgets**: island static props + decor merged per chunk (2 calls per chunk); office ≤ 150 calls in the worst view.
  Ground loot: batch item meshes by material (BatchedMesh), not by (id, level, scope) (M2c.md §15.4).
