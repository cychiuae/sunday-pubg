# M2c narrative: "Fresh Every Match & Bigger Arsenal"

Owner: narrative-designer. All text below lives in `src/content/strings/en.json`. This file explains the choices.
Tone rules from `WORLD.md` still apply: sunny, cheeky, harmless. Mid-fight labels stay plain, and jokes go in the
feed, item descriptions and loading lines. Every line that can show on either map must read fine on both.

## 1. Where the new gear comes from
The crates were packed for the cruise line's "Castaway Challenge" weekend. M2c adds three more sources, all from the
same ship:
- **The galley and the lifeboats** give the melee tools: a knife for shucking oysters, a machete for opening coconuts,
  and the paddle the castaways rowed ashore with.
- **The dinner show's armoury** gives the Double Scoop Shotgun and the Sand Dollar Revolver.
- **The farewell gala's fireworks** give the Sunburst Launcher and its rockets. These were meant for the grand finale,
  which explains the kill feed. The Candyfloss Smoke Bomb came from the same gala's dessert cart and stage-fog kit.
- **The wreck itself** gives the Lv.4 armor: a surfboard taped into a vest, and the ship's bell worn as a helmet.

## 2. Item names
| id | Name | Type (mid-fight label) | Why |
|---|---|---|---|
| knife | Shucking Knife | Knife | An oyster-shucking knife: a real beach tool that says "short and quick" straight away. |
| machete | Coconut Machete | Machete | What every castaway actually uses one for. |
| paddle | Lifeboat Paddle | Paddle | The beach oar from the brief. It is the paddle the castaways rowed ashore with (WORLD premise). |
| dbshotgun | Double Scoop Shotgun | Double Barrel | Two barrels, two scoops of ice cream. Type is "Double Barrel" so the slot label never looks the same as the Scatter Clam's "Shotgun". |
| revolver | Sand Dollar Revolver | Revolver | A sand dollar is round with a flower pattern, like a revolver's cylinder seen end-on. |
| rpg | Sunburst Launcher | Rocket launcher | A sunburst is a firework shape and also just sunny. "Launcher" plus the type keeps it clear. |
| ammo_rocket | Fireworks | Rockets | Breaks the "natural beach object" ammo rule on purpose: the rockets really are gala fireworks, and the word says "rare and loud". |
| smoke | Candyfloss Smoke Bomb | Smoke | A puffy, dense, pastel cloud matches the cel-shaded volume. HUD labels say "Smoke", just as the pineapple says "Grenade". |
| vest_4 | Surfboard Vest | Vest | Big, flat, absurd and clearly the best. |
| helmet_4 | Ship's Bell Helmet | Helmet | Brass bell from the wreck. "Rings loudly" in the description is a hook for audio (a bell "ding" on helmet hits is optional). |

**Every weapon name starts with a consonant sound.** The feed and the death card say "with a {weapon}", so an
"Oyster Knife" would read "with a Oyster Knife". That is why the first drafts (Oyster Knife, Outrigger Paddle) became
Shucking Knife and Lifeboat Paddle. `index.test.ts` enforces this rule.

Descriptions follow the house rule: plain type first, one joke at most, then the ammo it uses. Melee descriptions end
with "Takes your fists' place." so the slot rule is taught by the item itself.

Edited existing descriptions (values only, keys unchanged):
- `item.vest_3.desc` and `item.helmet_3.desc` now say "even more" because Lv.4 is now "the most".
- `item.ammo_heavy.desc` lists the Sand Dollar Revolver (the game-designer kept the revolver).
- `item.ammo_shell.desc` lists the Double Scoop Shotgun.

## 3. Item levels: Breezy, Warm, Hot, Scorcher
| Level | Name | Label |
|---|---|---|
| 1 | Breezy | Lv.1 |
| 2 | Warm | Lv.2 |
| 3 | Hot | Lv.3 |
| 4 | Scorcher | Lv.4 |

- **Why heat:** the game is about staying dry in the sun. A heat ladder is something everyone already ranks without
  being taught (breezy is the low end, a scorcher is the top), so the order needs no learning. It also reads as a
  cheerful holiday weather report and is not a rarity scale borrowed from another game.
- **Length:** the longest name is 8 characters, inside the 10-character HUD limit.
- **Numerals always travel with the name.** The plain label is `Lv.N` (`level.N.short`, the same text as
  `gear.tier.N`). Colour-blind players read the numeral or pips, and the name is flavour. Wherever a level name shows
  up, use `level.label` ("Lv.4 Scorcher") rather than the bare name.
- **Colour note for graphics-designer:** the names suggest cool to hot, but the palette is yours. Please separate the
  levels by brightness as well as hue, and do not put two reds/pinks next to each other.
- **Armor:** vests and helmets use the same scale. `gear.tier.4` = "Lv.4" was added, and `gear.tier.0` = "None" is
  unchanged.
- **Combined item text:** `level.item` = "{item} {short}" ("Sand Dollar Revolver Lv.4") for pickup prompts, inventory
  and the feed if the UI wants the level there. `level.aria` is for screen readers ("Level 4 of 4, Scorcher").

## 4. Look presets (per-match lighting)
Shown on the lobby/loading line through `lobby.look.<map>` ("Forecast: Mango Hour", "Lighting: Overtime"). Each
preset also has an optional one-line flavour (`.line`) for a loading card.

| Map | Preset id | Name | Line |
|---|---|---|---|
| island01 | morning | Early Dip | Dew on the palms. Nobody's awake yet. |
| island01 | noon | Full Sun | Sun straight overhead. Shade is a luxury. |
| island01 | golden | Mango Hour | Long shadows and a sky like fruit punch. |
| island01 | overcast | Sulky Skies | Grey clouds, flat light, grumpy gulls. |
| office | day | Full Lights | Every panel on. Nowhere to hide but under a desk. |
| office | evening | Overtime | Sunset through the blinds. Someone left the kettle on. |
| office | afterHours | Lamps Only | Most lights are off. The desk lamps know your secrets. |

"Mango Hour" ties golden hour to Mangomoon Isle. I avoided common film and song titles for times of day. The preset ids
above are confirmed.

The layout itself also gets a loading line: `lobby.layout.<map>` ("Someone moved the desks again."). `lobby.layout.pinned`
shows the pinned seed when `LAYOUT_SEED` is set, so QA and the user can read it off the screen.

## 5. Kill feed
All new lines are map-neutral (no sand, sea, tide or cliff) and cartoonish (no blood, no "killed").

| Group | Placeholders | Used when |
|---|---|---|
| `feed.knife.N`, `feed.machete.N`, `feed.paddle.N` | killer, victim | Body melee kill with that weapon. |
| `feed.meleeWeapon.N` | killer, victim, weapon | Fallback for any melee weapon without its own group (for example a future office reskin). |
| `feed.meleeHeadshot.N` | killer, victim, weapon | Melee headshot kill. |
| `feed.rocket.N` | killer, victim | Rocket blast kill. |
| `feed.rocketDirect.N` | killer, victim | Rocket direct-hit kill (optional; fall back to `feed.rocket`). |
| `feed.rocketSelf.N` | victim | Own rocket. |
| `feed.smoke.N` | killer, victim | Optional: a gun kill where the victim or killer was inside a smoke cloud. Smoke itself does no damage, so this only adds flavour. Skip it if the sim cannot tell cheaply. |

`feed.melee.N` (fists) is unchanged and still has no `{weapon}`.

Suggested routing for `killFeedPrefix` (ui-ux-designer / game-developer):
1. Explosion and weapon `rpg`: self gives `feed.rocketSelf`, a direct hit gives `feed.rocketDirect`, otherwise `feed.rocket`
   (no killer gives `feed.generic`, as grenades already do).
2. Weapon `fists` gives `feed.melee` (as now).
3. A melee id and a headshot give `feed.meleeHeadshot`. Otherwise use `feed.<weaponId>` if `tCount` > 0, else `feed.meleeWeapon`.
4. Optionally, a kill in smoke gives `feed.smoke`.
5. Everything else stays as it is now.

`death.eliminatedBySelfRocket` mirrors `death.eliminatedBySelf` for the death card.

## 6. Tutorial hints (one thing each, only when it matters)
| Key | Trigger | Text |
|---|---|---|
| `hint.throwableCycle` | First time the player carries both a grenade and a smoke | Press 4 again to swap between grenade and smoke. |
| `hint.smoke` | First smoke picked up | Smoke hides you, but bullets still go through. |
| `hint.melee` | First melee weapon picked up (`{item}` = its name) | Your {item} replaces your fists. Press 3 to swing it. |
| `hint.level` | First time a pickup prompt shows a level above 1 | Loot has levels, Breezy (Lv.1) to Scorcher (Lv.4). Higher is better! |
| `hint.rocket` | First Sunburst Launcher picked up | Rockets blast everyone nearby, you included. Keep your distance! |

`hint.melee` says "Press 3" because GDD §4 puts fists on key 3 (slot index 2). If the keys change, this line changes.
`hint.level` names the levels directly. If the level names change, update it in the same edit.

## 7. HUD and controls strings (guessed ahead of docs/ui/M2c.md)
- Throwable slot: `hud.throwable.none`, `hud.throwable.swap` ("[4] Swap"), `hud.throwable.selected` ("{item} ready",
  where `{item}` is the type, for example "Smoke ready"), `hud.smoke.none`, `hud.smoke.full`, `hud.smoke.dropped`. Grenade counts and
  cooking reuse `hud.grenade.count` / `hud.grenade.cook` / `hud.grenade.throw`, which are already generic.
- Melee: `hud.melee.swing`, `hud.melee.replacesFists`, `hud.melee.dropped` ("Fists are back").
- Levels: `hud.pickup.levelUp` ("[E] Swap up to {item}", where `{item}` is built with `level.item`), `hud.weapon.better`
  (refusal toast, mirrors `hud.vest.better`).
- Rockets: `hud.rocket.loaded`, `hud.rocket.none`.
- Controls card: `menu.controls.throwable.*`, `menu.controls.throwableCycle.*`, `menu.controls.melee.*`. The old
  `menu.controls.grenade.*` keys stay because code still reads them.

### Keys added after docs/ui/M2c.md (§11, §16)
`hud.pickup.swapFrom`, `hud.level.{up,down,same}` (arrow glyph and word, never colour alone), `hud.slot.sr`,
`hud.throwable.sr`, `hud.smoke.throw`, `death.with`, `layout.seed`. `menu.controls.grenade.*`, `hud.grenade.none`,
`hud.smoke.none` and `hud.melee.swing` are no longer shown by the UI, but they stay in the file.

## 8. Scopes (Addendum 1, rules in docs/design/systems/scopes.md)
| id | Name | Type | Why |
|---|---|---|---|
| scope_red_dot | Cherry Red Dot | Red dot | The dot sits on your sights like a cocktail cherry on top. |
| scope_2x | Sea Glass 2x Scope | 2x scope | A smooth, frosted beach find. Mild zoom, mild name. |
| scope_4x | Spyglass 4x Scope | 4x scope | From the pirate dinner show, like the DMR and sniper. |
| scope_8x | Stargazer 8x Scope | 8x scope | From the cruise ship's stargazing deck. The biggest lens. |

The zoom number is in every scope name, because the HUD chip shows `2×` / `4×` / `8×` and the name must match it.
Scopes have no level. The player-facing word for the one-slot spare stash is **pouch**, never "stash" (it matches the
grenade and smoke pouches).

- Prompts: `hud.scope.mountsOn` ("→ {weapon}"), `hud.scope.toPouch`, `hud.scope.dropsOld` ("({scope} drops)", for the
  case where a displaced scope falls to the ground), `hud.scope.fits`.
- Toasts: `hud.scope.mounted`, `hud.scope.stashed`, `hud.scope.now` ("Sight: {sight}"), `hud.scope.mounting`.
- Refusals: `actionFailed` reasons map to keys by the existing `hud.<area>.<state>` pattern.
  - `scopeCantFit` gives `hud.scope.cantFit`.
  - `scopeNoneFits` gives `hud.scope.noneFits`.
  - `scopePouchFull` gives `hud.scope.pouchFull` ("Scope pouch full!").
  - `hud.scope.stashFull` has the same text and is the UI's blocked pickup chip.
- Tooltip and aria: `hud.scope.builtIn`, `hud.scope.mountedOn`, `hud.scope.inPouch`, `hud.scope.cycle`, `hud.scope.sr`,
  `hud.scope.srBuiltIn`, `hud.scope.stash` ("Scope pouch").
- Sight names for `hud.scope.now`: `sight.<SightType>`, which covers `iron`, `red_dot`, `scope_2x`, `scope_4x` and
  `scope_8x`. With these, cycling back to a built-in red dot or 4x can name it too.
- `hint.scope` ("Press T to swap in your spare scope.") shows the first time the player holds a gun and the pouch holds
  a scope that fits it. `menu.controls.scope.*` = "T" / "Switch sight".

## 9. Unchanged on purpose
- `menu.connection.lost` ("Lost at sea. Connection dropped.") is unchanged on the office map, pending the user's
  answer.
- No real names, companies or logos anywhere. The office presets are about lighting only.
