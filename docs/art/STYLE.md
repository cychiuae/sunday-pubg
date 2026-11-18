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

Future moods (out of scope for M1, palette reserved): dawn (sun `#FFC9A3` 1.6, sky top `#7FA8E8`, horizon `#FFD9B8`),
dusk (sun `#FF9E6B` 1.4, sky top `#3D4C9A`, horizon `#FFB38A`, tiki flames brighten), night (moon `#A9C4FF` 0.5).

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
matching ammo box uses the same family colour **and** a distinct bullet shape.
| Weapon | Body | Secondary | Length | Ammo (colour + shape) |
|---|---|---|---|---|
| pistol | mango `#FFC43D` | dark grip `#3D3A4B` | 0.28 m | light: yellow box, 3 short round-nose bullets |
| smg | teal `#2EC4B6` | dark, with a yellow band | 0.59 m | light |
| shotgun | red `#E94F37` | wood `#B9783F` pump and stock | 1.0 m | shells: red box, 3 fat flat-top shells |
| rifle | green `#3E9B5A` | sand handguard, dark mag and grip | 1.0 m | heavy: green box, 3 tall pointed bullets |

## 9. Loot
- The item hovers at y 0.45. The renderer bobs and spins the `spin` child. Guns are shown side-on and enlarged
  (×1.35, pistol ×1.9).
- Ground marker: a translucent disc + a solid ring + an ink rim (contrast on pale sand). The tier is shape-coded
  (see §2) so it reads without colour vision.
- Heals: bandage (two cream rolls with pink stripes), medkit (white box, green plus, dark handle).
  Armor: vest (slate blue `#4F6F9F`, tan straps `#D9B26F`, brass buckles).

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
