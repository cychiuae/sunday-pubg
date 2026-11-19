# UI / UX: M2c "Fresh Every Match & Bigger Arsenal" (design spec + build notes)

Owner: ui-ux-designer. Status: **design spec, not built.** The build follows the tech-lead's M2c contract (ADR 0007).
Base documents: `docs/ui/UI.md` (§11 M2a HUD, §13 first person, §14 M2b as built). This file only lists what changes.
Fixed decisions come from the M2c brief (layout seed, item levels 1–4, melee in slot index 2, `dbshotgun`, `revolver`,
`rpg`, `smoke`, throwable slot). Gameplay numbers are read from HUD fields and balance through ClientGame; the Ui never
hard-codes them. Every player-facing string comes from `en.json` (keys in §11; narrative writes the text).

**Slot numbering in this file:** "slot index" is the `SlotIndex` in the contract (0-based). Keys are 1-based.
Index 0 and 1 = guns (keys 1, 2), index 2 = melee (key 3; fists or a melee weapon), index 3 = throwables (key 4 / G).

Priorities: **P1** ships in M2c. **P2** ships if its contract field lands; the Ui works without it.

---

## 1. Item levels: one visual system

### 1.1 The level badge (one component, used everywhere in the DOM)
```
 ┌──┐   rounded square, 1.15em, 2 px ink outline, fill = level colour, numeral in ink (weight 900, tabular)
 │2 │   L4 only: a small 4-point sparkle on the top-right corner (a shape cue on top of the numeral)
 └──┘   screen readers: the badge has aria-hidden; its parent label uses `level.aria` ("Level 2 of 4, Warm")
```
The **numeral is the primary non-colour tell**. Colour is secondary. Where there is room, the **level name** (narrative,
`level.N.name`) follows the badge as text. Armor cells keep their row of **pips** (now 4) because they already teach it.

### 1.2 Level colours (superseded: the build uses docs/art/M2c.md §1.1, see §17)
Narrative named the levels as a heat scale (`level.N.name`: Breezy, Warm, Hot, Scorcher), so the colours run cool to
hot to match. (This replaces an earlier shell / sea glass / violet / gold draft of this section.)

| Level | Name (en.json) | UI token | Fill | Numeral | Numeral contrast | Extra cue |
|---|---|---|---|---|---|---|
| 1 | Breezy | `--lv1` | `#BFE9FF` sky | ink | 12.3 : 1 | — |
| 2 | Warm | `--lv2` | `#FFE89A` sun-cream | ink | 13.1 : 1 | — |
| 3 | Hot | `--lv3` | `#FF9A3C` tangerine | ink | 7.5 : 1 | — |
| 4 | Scorcher | `--lv4` | `#C2185B` hibiscus | cream | 5.6 : 1 | sparkle corner on the badge; extra sparkle on the ground marker (render) |

Checked with a protan / deutan / tritan simulation (Machado matrices, CIELAB): the closest pair is L2 vs L3 under
deuteranopia at ΔE ≈ 29; every other pair is further apart. L4 is much darker than the rest (it is the only one with a
cream numeral), so the top level reads apart from the others even in greyscale. The numeral covers the rest.
Constraints if graphics-designer changes the hexes: numeral ≥ 4.5 : 1 on every fill (ink or cream); minimum pairwise
ΔE ≥ 28 under all three simulations; L4 must not equal the danger red `#FF3B5C` (kill marker), and no fill may equal
the HUD accent `#FFC43D` (active slot fill). The badge always has its ink outline, so it reads on sand panels, ink glass
and bright scenery.

The values and the heat theme are ours, not any game's rarity set.

### 1.3 Where levels show
| Place | P | What is shown | Non-colour tell |
|---|---|---|---|
| Gun slots (index 0, 1) | P1 | icon + badge (bottom-right of the icon) + mag; name on the active slot | numeral |
| Melee slot (index 2) | P1 | fists icon (no badge) or melee icon + badge | numeral; fists have no badge |
| Active weapon in ammo panel | P1 | nothing new (the active slot above it already shows name + badge) | — |
| Armor cells (vest, helmet) | P1 | piece silhouette + **4 pips** (N filled with the level colour, rest hollow) + durability | pip count, silhouette per level |
| Pickup prompt | P1 | item icon + text + badge + level name (+ durability for armor) | numeral + name |
| Swap prompt | P1 | what you give up and what you get, both with badges; ▲ / ▼ / = when it is the same weapon id | numeral, arrow glyph + word |
| Kill feed | P1 | weapon icon + badge after the sentence's weapon name | numeral |
| Death card | P1 | new line: killer's weapon icon + name + badge | numeral |
| Ground loot (3D) | P1 | render: marker ring in the level colour with N notches; L4 gets sparkles | notch count (request to graphics) |
| Loot peek (looking at loot out of reach) | P2 | the prompt chip without the key, dimmed | numeral |
| Spectate bar | P2 | target's held weapon icon + badge | numeral |

The old "loot tier" row in UI.md §4 (common / rare / epic shown on the ground) is **superseded**: players now see the
item's level, not the spot's tier. The spot tier only decides the level roll.

---

## 2. Slots (bottom-right column, first person layout from UI.md §13.2)

```
  ①               ②                              ③                ④
 ┌──────────┐  ┌──────────────────────────────┐ ┌──────────┐  ┌───────────────────┐
 │ ● ┌─┐    │  │ ◆ Longshore Rifle      ┌─┐   │ │ ⟋ ┌─┐    │  │ 🍍 ×2        ☁1  │
 │   │2│  8 │  │                        │3│ 24│ │   │1│    │  │                   │
 └───┴─┴────┘  └────────────────────────┴─┴───┘ └───┴─┴────┘  └───────────────────┘
                              ▼ active (raised, accent fill, thick outline)
   gun L2        active gun L3 (name shown)       machete L1    throwables: frag selected,
                                                  (fists: ○, no  1 smoke carried (small badge,
                                                   badge, no     upper-right)
                                                   number)
```
- **Gun slots (index 0, 1):** keycap, icon, level badge overlapping the icon's bottom-right corner, mag count. Empty
  slots unchanged (dashed + "Empty").
- **Melee slot (index 2):** the fists ring ○ or the melee icon + badge. No number (melee has no ammo). The ammo panel
  shows `∞` for any melee item, as it does for fists. When a melee weapon is dropped the slot returns to fists with the
  normal 120 ms swap tick.
- **Active slot** shows the item name (`item.<id>.name`) and the badge. Same active cues as UI.md §4 (raised, ▼, thick
  outline) so colour is never the only cue.
- Screen reader label per slot: `hud.slot.sr` ("Slot {key}: {item}, {level}") with `level.N.short` filled in, or the
  item alone for fists, smoke and frag.

### 2.1 Throwable slot (index 3, key 4 / G) and cycling
```
 inactive, both types:      ④ [🍍 ×2      ☁1]      main = selected type + count; mini chip upper-right = the other type
 inactive, one type:        ④ [☁ ×1]               no mini chip
 none:                      ④ [🍍 ×0]  dashed, grey (as M2a)
 active, both types:        ④ [🍍 Pineapple Grenade ×2   ⇄[4] ☁1]   the cycle hint shows only while active
 active, one type:          ④ [☁ Smoke Bomb ×1]
```
- **Select:** key 4 or G selects the slot with the **last selected type** (or the only type carried). With none carried
  the existing refusal toast shows `hud.throwable.none` (replaces `hud.grenade.none`).
- **Cycle:** pressing 4 / G **while the slot is active** switches frag ↔ smoke, only among carried types. With one type
  carried, the press does nothing and shows nothing (no toast; it is not an error).
- **Feedback within 100 ms:** the main icon and the mini chip swap places (120 ms cross-slide; reduced motion = instant
  swap), the active name changes, the ammo panel's `×N` changes icon and count, and the mini chip pulses once. The Ui
  reads the **predicted** `throwableSelected` (§12, §14), so the swap does not wait for the server.
- **Auto-reselect:** when the selected type runs out, the sim's rule applies (game-designer decides; expected: switch to
  the other type if carried, else the M2a auto-swap to the last gun). The Ui only mirrors the HUD field.
- **Cook ring by type:** frag keeps the orange ring that turns red, thick and pulsing at ≤ 1000 ms. **Smoke** uses a
  cream ring with no red or urgent state (it cannot hurt you), and its hint is `hud.smoke.throw` instead of
  `hud.grenade.cook`. If the game-designer makes smoke uncookable, `cook` stays null and only the hint shows.
- **Danger icons** (M2a pineapple warning) list frags only. Smoke cans in flight never show a danger icon.
- **Pickup at the carry limit:** `hud.grenade.full` for frags (existing), `hud.smoke.full` for smoke, chosen by the
  prompt item.

### 2.2 Narrow (≤ 900 px wide or ≤ 560 px tall) and touch
- Slot names hide (as today). **Badges stay**, at 1em minimum, numeral always visible.
- The throwable mini chip hides; the main icon and count stay. The active-slot `⇄[4]` hint hides.
- Touch (later): tap slot ④ to select, tap again to cycle (same rule as the key). The fire button swings the melee
  weapon. Slot cells stay ≥ 44 px.

---

## 3. Pickup and swap prompts

```
 pick up (free slot):     [◆ [E] Pick up Longshore Rifle │ ┌─┐ Lv.3 Hot ]        badge + level.label
                                                          │3│
 swap, different weapon:  [◆ [E] Swap Conch Pistol ┌─┐ for Longshore Rifle ┌─┐ ]
                                                   │1│                     │3│
 swap, same weapon:       [◆ [E] Swap up to Longshore Rifle ┌─┐ │ ▲ Upgrade from ┌─┐ ]   hud.pickup.levelUp; ▲ / ▼ / = + word
                                                           │3│                  │1│
 melee:                   [⟋ [E] Pick up Machete ┌─┐ Lv.2 Warm · Replaces your fists]   or "Swap Knife ① for Machete ②" when one is held
 armor (as M2a, 4 levels):[🦺 [E] Upgrade to Lifeguard Vest │ ◆◆◇◇ ┌─┐ 31/55]   pips + badge + durability
 armor refused:           [🔒 Your vest is as good or better]  (dashed, lock glyph; unchanged)
 throwable:               [☁ [E] Grab 2 Smoke Bomb]     (no level: throwables, ammo and heals have none)
```
- `hud.pickup.swapFrom` ("[E] Swap {current} for {item}") replaces `hud.pickup.swap` whenever the Ui knows which slot
  is replaced (`interactPromptChanged.replacesSlot`, §12, §14). Without that field it falls back to the M2a
  `hud.pickup.swap` text plus the new item's badge.
- Same weapon id at a **higher** level uses `hud.pickup.levelUp` ("[E] Swap up to {item}"); lower or equal uses
  `hud.pickup.swapFrom`.
- **Level compare tag** shows only when the replaced item has the **same id** (same gun, same melee weapon, or the same
  armor slot). Comparing levels across different guns would be misleading, so different guns show both badges and no
  arrow. ▲ `hud.level.up`, ▼ `hud.level.down` (dashed chip), = `hud.level.same`. Arrow glyph + word, never colour alone.
- The level text in the prompt is `level.label` ("Lv.3 Hot"). At narrow widths it hides; the badge stays.
- First prompt for an item at level 2 or higher fires the one-time hint `hint.level` (§9).

### 3.1 Loot peek (P2)
When the screen-centre ray hits a ground item that is out of pickup reach but within `LOOT_PEEK_RANGE_M` (Ui constant,
15 m, presentation only), the prompt slot shows the same chip **dimmed, without the [E] keycap and with no verb**:
`[◆ Longshore Rifle ③]`. It hides while scoped, inside smoke, or when the line to the item crosses a smoke cloud.
It needs `HudView.lootPeek` (§12, §14). Without it, the ground marker and the prompt in reach are the only labels.

---

## 4. Melee (slot index 2)

```
   ·        dot (as fists today), plus:
  ╭─╮       a thin swing-recovery ring around the dot that fills while the swing recovers
  ╰─╯       (0.9em radius, inside the reload ring; cream with ink outline; gone when ready)
```
- **Reticle:** dot only, as fists in UI.md §13.1. No spread ticks. No "in reach" highlight (it would reveal players in
  smoke and act as aim assist).
- **Recovery ring:** `HudLocalView.meleeRecovery` (0..1, null when ready). The slow paddle shows it clearly; the knife
  barely does. Starts on the predicted swing, so it appears within one frame of the click.
- **Hit markers:** the same body / head / kill / vest / helmet / break markers as guns. No melee-only variant.
  Hitting glass gives no hit marker (render shatters the glass; audio plays the break).
- **Kill feed:** fists keep `feed.melee.*`. Melee weapons use `feed.<meleeId>.*` (knife, machete, paddle exist), else
  `feed.meleeWeapon.*` (with `{weapon}`), plus the weapon icon and badge. A melee headshot kill uses
  `feed.meleeHeadshot.*` and
  adds the target glyph (as gun headshots do).
- **One-time hint:** `hint.melee` (`{item}`) on the first melee weapon pickup.
- **Prompt detail:** picking up a melee weapon while on fists adds `hud.melee.replacesFists` after the badge. Losing
  the melee weapon shows the toast `hud.melee.dropped`.
- **Controls list:** unchanged (melee is key 3 + LMB, already in the list).

---

## 5. RPG

```
 hip (FP):        ╷               standard hip reticle from crosshairSpreadDeg (whatever the designer sets)
               ─  ·  ─            + the dot turns hollow while the tube is empty (mag 0), solid when loaded
                  ╵
 ADS (FP):     no Ui reticle; the viewmodel's iron sight is the aim (render; request: 2 small range marks for drop)
 ammo panel:   ┌──────────────┐
               │ ➤  1 / 2     │   rocket icon (ammo_rocket shape) + mag / reserve, same rules as other guns
               │ [Q] heals    │   0 / 0 → "Out of ammo!" (existing)
               └──────────────┘
 slot:         normal gun cell: rocket-launcher icon + badge + "1" / "0" (0 = dashed number, as any empty mag)
```
- **Reload:** the existing reload ring and "Reloading…" chip. Nothing new; the long reload already reads well.
- **Self-damage:** one-time `hint.rocket` on the first RPG pickup ("rockets hurt you too"). No live "too close" warning
  in M2c (it needs a per-frame aim raycast on the client; can be added later as `HudView.rpgTooClose`).
- **Incoming rocket warning: out of scope (decision).** Rockets are fast, so a HUD warning would show for well under a
  second and could not be acted on. The rocket's trail (render) and its whoosh (audio) are the cue. Blast damage uses the
  existing damage arcs. Rockets never appear in `grenadeDanger`.
- **Kill feed:** a rocket blast kill (cause `explosion`, weapon `rpg`) uses `feed.rocket.*` with the RPG icon and
  badge; a direct hit uses `feed.rocketDirect.*` when `playerKilled.direct` is true (P2). A self-kill uses
  `feed.rocketSelf.*`, and the death card reads `death.eliminatedBySelfRocket`. Self-kill
  detection reuses `logic.isSelfGrenadeKill` (rename to `isSelfBlastKill`): the remembered last blast attacker covers
  rockets too. A direct-hit kill (impact + blast on the same tick) is still one kill line.
- **Bots:** nothing for the Ui.

---

## 6. Smoke

### 6.1 HUD while the camera is inside smoke (`HudView.inSmoke`)
| Element | Inside smoke | Why |
|---|---|---|
| Crosshair, dot, rings | stay; ink outline goes from 1 px to 2 px | contrast over a pale grey volume |
| Hit markers | see §6.2 | |
| Pickup prompt (in reach) | stays | you are standing on it |
| Loot peek (P2) | hidden | you cannot see it |
| Grenade danger icons | stay | safety cue, already shown through walls |
| Damage arcs | stay | you are being hit; direction is fair |
| Minimap, feed, tide chip, vitals, slots, ammo | stay | no change |
| Scope overlay | stays; the lens sees the smoke (render) | ADS does not see through |
| Anything new | **nothing** | the volume itself is the cue; the HUD stays calm |

The Ui does not draw a smoke vignette. The renderer draws the volume. Smoke must look the same on every graphics
quality preset (§12, §14, fairness).

### 6.2 Visibility through smoke
- **Hit markers:** when the line from the camera to the victim's chest crosses an active cloud at receipt time
  (`localHitConfirmed.obscured`, §12, §14), the **body, head, vest, helmet and break** markers are not shown.
  The **kill marker still shows** (decision): the kill feed announces the kill to everyone anyway, and hiding only
  the marker would contradict the feed. Audio's hit tick follows the same flag (§12, §14).
- **Name tags** and the **spectate outline** are hidden for any player whose line from the camera crosses a cloud.
  Both are render-owned (§12, §14).
- **Minimap:** smoke clouds are **not** drawn. Showing every cloud on the map would tell everyone where fights are.
- All tests use one shared pure helper (§12, §14) with the same cloud radius-over-time as the bots' line-of-sight
  test, so "hidden to me" and "hidden to bots" agree.

### 6.3 Strings and hints
`item.smoke.*`, `hud.smoke.throw`, `hud.smoke.full`, `hud.smoke.dropped` (switched away while cooking),
`hud.throwable.none`, `hud.throwable.swap` (cycle hint on the active slot), `hud.throwable.selected` (aria-live on
cycle). One-time hints: `hint.smoke` on the first smoke pickup, `hint.throwableCycle` the first time both types are
carried. Controls list: the grenade row becomes `menu.controls.throwable.*` plus `menu.controls.throwableCycle.*`.
Kill feed (P2): a kill where the camera-to-victim line crossed smoke may use `feed.smoke.*` when
`playerKilled.throughSmoke` is true.

---

## 7. Per-match layout variety

### 7.1 Minimap
- The static layer now comes from `(map, layout)` and is rebuilt when the map, the **layout seed** or the canvas size
  changes. That is once per match plus resizes.
- **Office:** desks come from the layout. The existing plateau rule draws them (floor props with colliders,
  footprint ≥ 25 m², height ≥ 3 m), so rows, pods, rotations and removed desks all show. Walls, glass, rooms and floor
  zones are unchanged. Clutter (plants, boxes, chairs, monitors, coolers, paper) is never drawn.
- **Island:** new. Collidable layout props with footprint ≥ 6 m² and height ≥ 1.2 m (huts, big cover pieces) are drawn
  as small sand-brown blocks (`#C99A5B`, 1 px ink edge, rotated to the prop). Small crates, decoration and scatter
  (palms, rocks without colliders, shrubs, towels, umbrellas, shells) are never drawn. Thresholds are Ui constants
  (`ISLAND_PROP_MIN_AREA`, `ISLAND_PROP_MIN_HEIGHT`), not gameplay numbers.
- Loot is never on the minimap.
- **Waiting-room mini map** (rooms.ts map card): base map before the vote locks, the layout's props after it locks.
- Look presets do not change minimap colours.

### 7.2 "Look" and layout line
```
 waiting room map card, after the vote locks:       pause overlay footer / results footer:
 ┌──────────────────────────────┐                   ┌──────────────────────────────────────┐
 │ Next map: The Open Plan      │                   │ …                       ⚙ Settings   │
 │ ☾ After hours                │  ← glyph per look │ Layout #48213   (small, ink-soft,    │
 │ [mini map with desks]        │    (sun / moon /  │                  selectable text)    │
 └──────────────────────────────┘    cloud)         └──────────────────────────────────────┘
```
- **Look line** (`lobby.look.<mapId>` with `{look}` = `look.<mapId>.<lookId>`; the flavour line
  `look.<mapId>.<lookId>.line` sits under it in ink-soft): shown in the waiting-room map card (and the
  legacy lobby panel) once the vote is locked and the seed is known. Glyph per look family: sun (day), sunset (golden
  hour / evening), moon (after hours), cloud (overcast). The text is always there, so the glyph is decoration.
- **Layout code** (`layout.seed`, "Layout #{seed}"): in the Pause overlay and Results footer. It lets the user report a
  layout, and QA reproduce it with `LAYOUT_SEED=`. It is small and selectable (`user-select: text` on that line only).
- Not shown in the in-match HUD and not announced. Variety should be felt, not explained.

---

## 8. Kill feed and death card

```
 ┌ kill feed ────────────────────────────────────────────────────┐
 │ Pat splashed Sue with a Longshore Rifle ◆┌─┐                  │   weapon name, then icon + badge
 │ ◎ Bea bopped Kim on the noggin with a Conch Pistol ●┌─┐       │   headshot glyph as before
 │ 🍍 Bo lobbed a pineapple at Al                                │   frags and smoke: no level
 │ ➤ Kai rocketed Mo ➤┌─┐                                        │   feed.rocket.* (RPG icon leads, like the pineapple)
 └───────────────────────────────────────────────────────────────┘
 death card:  Washed out! / Eliminated by Pat / [◆ Longshore Rifle ┌─┐] / #7 of 12 / Kills 1 / [Spectate]
                                                                  │3│
```
- The badge follows the weapon icon. No badge for fists, frag, zone, fall or generic lines.
- Feed key order (extends UI.md §5): zone/fall as before → `explosion` with weapon `rpg` → `feed.rocketSelf.*`,
  else `feed.rocketDirect.*` (if `direct`), else `feed.rocket.*` → `explosion` / `grenade` → `feed.grenadeSelf.*` /
  `feed.grenade.*` → melee weapon → headshot `feed.meleeHeadshot.*`, else `feed.<meleeId>.*`, else
  `feed.meleeWeapon.*` → `fists` → `feed.melee.*` → (P2) `throughSmoke` → `feed.smoke.*` → headshot → `feed.headshot.*` →
  `feed.kill.*`.
- Death card line `death.with` ("{weapon}") with icon + badge, only when the killer used a weapon. Not shown for zone,
  fall or self-kills.
- The feed width is unchanged. The badge is 1.15em, so a line wraps at most once at 1280×720 and UI size 150 %.

---

## 9. One-time hints (bsp.hints.v1)
| Hint | Trigger |
|---|---|
| `hint.level` | First pickup prompt for an item at level ≥ 2 |
| `hint.melee` | First melee weapon picked up |
| `hint.smoke` | First smoke picked up |
| `hint.throwableCycle` | First time carrying both frag and smoke |
| `hint.rocket` | First RPG picked up |

`hint.grenade` stays for the first frag. Hints keep the M1 rules (5 s, one at a time, never while scoped).

---

## 10. Settings

**No new settings in M2c.**
- Colour-blind mode is still not needed: every level cue has a numeral or pips, smoke has no colour signal, and the
  throwable slot uses icons and text.
- The controls list: the `menu.controls.grenade.*` row is replaced by `menu.controls.throwable.*` and
  `menu.controls.throwableCycle.*`; `menu.controls.melee.*` and `menu.controls.scope.*` (§16) are added. The Pause list and the waiting room list both use it.
- Graphics quality must not change smoke opacity or the readability of look presets (request to graphics-engineer).
  The Ui does not add a smoke or brightness setting.

---

## 11. String keys

Narrative added most M2c keys before this spec existed. The Ui uses **the existing en.json names**. The table lists
every key the Ui reads for M2c, with its status. "new" means narrative still needs to write it.

| Ui use | Key | Status |
|---|---|---|
| Level names | `level.1.name` … `level.4.name` | exists |
| Level short ("Lv.2") | `level.N.short` | exists |
| Level in prompts ("Lv.2 Warm") | `level.label` | exists |
| Level in screen readers | `level.aria` | exists |
| Armor level 4 | `gear.tier.4` | exists |
| Item name + level (tooltips, toasts) | `level.item` | exists |
| Same-gun upgrade prompt | `hud.pickup.levelUp` ("[E] Swap up to {item}") | exists |
| Swap naming what you give up | `hud.pickup.swapFrom` ("[E] Swap {current} for {item}") | new |
| Compare tag ▲ / ▼ / = | `hud.level.up` / `hud.level.down` / `hud.level.same` | new |
| Slot screen-reader label | `hud.slot.sr` ("Slot {key}: {item}, {level}") | new |
| New items | `item.{knife,machete,paddle,dbshotgun,revolver,rpg,ammo_rocket,smoke,vest_4,helmet_4}.*` | exist |
| Ammo descriptions mentioning new guns | `item.ammo_heavy.desc`, `item.ammo_shell.desc` | update (revolver, double barrel) |
| No throwables / smoke pouch full | `hud.throwable.none`, `hud.smoke.full` | exist |
| Cycle hint on the active throwable slot | `hud.throwable.swap` ("[4] Swap") | exists |
| Cycle announcement (aria-live) | `hud.throwable.selected` | exists |
| Smoke switched away while cooking | `hud.smoke.dropped` | exists |
| Throwable slot screen reader | `hud.throwable.sr` | new |
| Smoke in hand hint | `hud.smoke.throw` | new |
| Melee prompt detail / lost melee toast | `hud.melee.replacesFists`, `hud.melee.dropped` | exist |
| RPG aria for the loaded dot / out of rockets | `hud.rocket.loaded`, `hud.rocket.none` (ammo panel at 0 / 0 for the RPG) | exist |
| Feed | `feed.meleeWeapon.*`, `feed.meleeHeadshot.*`, `feed.knife.*`, `feed.machete.*`, `feed.paddle.*`, `feed.rocket.*`, `feed.rocketDirect.*`, `feed.rocketSelf.*`, `feed.smoke.*` | exist |
| Death card self-rocket | `death.eliminatedBySelfRocket` | exists |
| Death card weapon line | `death.with` ("With a {weapon}") | new |
| Look names / flavour | `look.<mapId>.<lookId>`, `look.<mapId>.<lookId>.line` | exist |
| Look line in the map card | `lobby.look.<mapId>` ("Forecast: {look}" / "Lighting: {look}") | exist |
| Layout code | `layout.seed` ("Layout #{seed}") | new |
| Hints | `hint.level`, `hint.melee`, `hint.smoke`, `hint.throwableCycle`, `hint.rocket` | exist |
| Controls rows | `menu.controls.throwable.*`, `menu.controls.throwableCycle.*`, `menu.controls.melee.*` | exist |
| Scope keys | §16.9 | new |

`menu.controls.grenade.*` and `hud.grenade.none` are no longer shown (left in en.json; narrative may retire them).
`hud.smoke.none` and `hud.melee.swing` exist but the M2c HUD doesn't need them (keep them for touch buttons later).
Until a key exists, the Ui guards it with `hasKey` and falls back (badge only, generic feed, M2a swap text).

---

## 12. Data the Ui needs (requests; the tech-lead shapes them in the M2c contract)

```ts
// contracts.ts (proposal)
interface HudSlotView {
  weapon: HeldId | null;          // index 2: 'fists' | MeleeId; index 3: the SELECTED ThrowableId
  level: ItemLevel | null;        // null for fists, throwables, empty
  mag: number | null;
  count: number | null;           // index 3: count of the selected type
}
interface HudLocalView {
  weaponLevel: ItemLevel | null;  // held item's level
  throwables: Record<ThrowableId, number>;
  throwableMax: Record<ThrowableId, number>;
  throwableSelected: ThrowableId; // PREDICTED, so cycling gives feedback in the same frame
  meleeRecovery: number | null;   // 0..1 while a swing recovers
  cook: (HudCookView & { throwable: ThrowableId }) | null;
  // vest/helmet: HudArmorView.tier widens to 1..4 (ItemLevel)
}
interface HudView {
  inSmoke: boolean;               // camera inside an active cloud
  layout: { seed: number; lookId: string } | null;
  lootPeek?: { item: ItemId; level: ItemLevel | null; qty: number } | null;        // P2
  spectate: { /* existing */ weapon?: HeldId; weaponLevel?: ItemLevel | null } | null; // P2
  // grenadeDanger: frags only (no smoke, no rockets)
}
interface HudMinimapView {
  layout: MatchLayout | null;     // or a pre-filtered list of collidable placed props with kit size and height
}
// RoomView: lockedLayout: { seed: number; lookId: string } | null  (waiting-room map card after the vote locks)
// GameEvents:
//   playerKilled          += direct?: boolean (rocket impact kill, P2); throughSmoke?: boolean (P2)
//   interactPromptChanged += level: ItemLevel | null; replacesSlot: SlotIndex | null
//   playerKilled          += weaponLevel: ItemLevel | null   (weapon 'rpg' for rocket blasts)
//   localHitConfirmed     += obscured: boolean (camera→victim chest crosses a cloud when the confirm arrives)
```
Shared pure helper (game-developer, `src/shared/sim/`): `segmentBlockedBySmoke(clouds, from, to, nowMs)` with the same
radius-over-time and density threshold the bots use. ClientGame (obscured, inSmoke, lootPeek) and the renderer (name
tags, spectate outline) call it.

---

## 13. Acceptance criteria (for qa-tester; Vitest = pure `src/ui/logic.ts` helpers, E2E = Playwright or manual)

**Levels**
- [ ] M2C-UI-01 (Vitest): `levelBadgeModel(n)` returns numeral `n`, the `--lvN` token and `sparkle: n === 4` for 1–4,
      and null for `null` (fists, throwables).
- [ ] M2C-UI-02: every gun and melee slot holding a levelled item shows a badge with the right numeral. Fists and
      throwables show none. Holding the item in the active slot also shows its name.
- [ ] M2C-UI-03: armor cells show 4 pips with N filled for `vest_1..4` / `helmet_1..4`; `vest_4` and `helmet_4` show
      their own silhouettes; the screen-reader label says the level.
- [ ] M2C-UI-04: with greyscale on (CSS `filter: grayscale(1)` on the root), all four badge levels can still be told
      apart in a screenshot by the numeral alone; the L4 badge has the sparkle.
- [ ] M2C-UI-05: measured contrast of the badge numeral on each fill is ≥ 4.5 : 1 (tokens in ui.css).
- [ ] M2C-UI-06: the kill feed shows icon + badge for gun, melee and RPG kills, and no badge for fists, frag, zone,
      fall and generic lines. The death card shows the killer's weapon + badge for weapon kills only.

**Prompts**
- [ ] M2C-UI-07 (Vitest): `pickupPromptModel` returns `hud.pickup.swapFrom` with `current` and `item` when
      `replacesSlot` is set and both gun slots are full; `hud.pickup.swap` when `replacesSlot` is absent; level compare
      `up / down / same` only when the replaced item has the same id; no compare for different ids.
- [ ] M2C-UI-08: on a same-gun swap, the prompt shows ▲ + "Upgrade from" + the old badge for a higher level, a dashed
      ▼ chip for a lower one, and "=" for the same level.
- [ ] M2C-UI-09: armor prompts work for levels 1–4 (upgrade text, pips, badge, durability); a same-or-lower piece
      still shows the blocked chip.
- [ ] M2C-UI-10: with a melee weapon held, the prompt on another melee weapon reads "Swap {current} for {item}"; on
      fists it reads "Pick up".

**Throwables**
- [ ] M2C-UI-11 (Vitest): `throwableSlotModel` gives main = selected type, mini chip = the other type only when its
      count > 0, dashed when both are 0, and the cycle hint only while the slot is active and both types are carried.
- [ ] M2C-UI-12: key 4 with only frags selects frags; pressing 4 again does nothing and shows no toast. With both
      types, each press while active swaps the main icon, the name and the ammo panel's `×N` **within 100 ms** of the
      key press (measure with a performance mark on keydown and the DOM mutation), including at 150 ms simulated RTT.
- [ ] M2C-UI-13: G does the same as 4. Key 4 with no throwables shows "No throwables" once (spam keeps one toast).
- [ ] M2C-UI-14: smoke in hand: cream cook ring (if cookable) that never turns red or pulses; hint is
      `hud.smoke.throw`. A smoke can in flight never shows a danger icon; a frag still does.
- [ ] M2C-UI-15: reduced motion: the cycle swap is instant, no slide or pulse.

**Melee**
- [ ] M2C-UI-16: with a melee weapon or fists in hand, the reticle is the dot only; the recovery ring appears on the
      swing frame, fills, and disappears when the next swing is allowed (visibly longer for the paddle than the knife).
- [ ] M2C-UI-17: melee hits on players show the normal body / head / kill / armor markers; a melee hit on glass shows
      none.

**RPG**
- [ ] M2C-UI-18: RPG slot and ammo panel show `mag / reserve` with the rocket icon; the hip dot is hollow at mag 0 and
      solid when loaded; the reload ring runs on reload; "Out of ammo!" at 0 / 0.
- [ ] M2C-UI-19: a rocket kill shows a `feed.rocket.*` line with the RPG icon + badge; killing yourself shows
      `feed.rocketSelf.*` and the death card reads the self-rocket line (Vitest on the feed key choice too).
- [ ] M2C-UI-20: no rocket warning icon appears, and rockets never show in the grenade danger list.

**Smoke**
- [ ] M2C-UI-21: inside a cloud (`inSmoke` true), the crosshair outline is 2 px and nothing else on the HUD appears,
      moves or hides, except the loot peek (hidden).
- [ ] M2C-UI-22 (Vitest): `hitMarkerVisible({ obscured, kill })` is false for obscured body / head / armor hits and
      true for any kill.
- [ ] M2C-UI-23 (E2E with a pinned seed): shooting a bot through a cloud gives no hit marker until the kill; the kill
      marker and feed line show. Name tags of players behind or inside a cloud are hidden (render check).
- [ ] M2C-UI-24: the minimap never shows smoke clouds.

**Layout**
- [ ] M2C-UI-25: with `LAYOUT_SEED` pinned to two different values, the office minimap shows the two different desk
      arrangements, matching the 3D scene; clutter never appears on the minimap.
- [ ] M2C-UI-26: on the island, huts and large cover pieces from the layout appear as small blocks at the right
      places; palms, shrubs, towels and small crates do not.
- [ ] M2C-UI-27: the minimap static layer is rebuilt once per match (plus once per resize), not per frame (counter in
      a debug build or a spy in a unit test).
- [ ] M2C-UI-28: the waiting-room map card shows the look line only after the vote locks, with the right
      `look.<mapId>.<lookId>` text; the pause overlay and results show "Layout #{seed}", equal to the pinned `LAYOUT_SEED`.

**Layout, scaling and touch**
- [ ] M2C-UI-29: at 1280×720, 1920×1080 and 3440×1440 with UI size 80 % and 150 %, the slot row (4 cells with badges,
      throwable mini chip) never overlaps the ammo panel, the toasts or the gun's sight; the feed wraps a line at most
      once.
- [ ] M2C-UI-30: at 900 px wide: slot names, the throwable mini chip and the prompt's level name hide; badges stay
      and are at least 1em.
- [ ] M2C-UI-31: one-time hints `hint.level`, `hint.melee`, `hint.smoke`, `hint.throwableCycle`, `hint.rocket` each show once per browser on
      their trigger.
- [ ] M2C-UI-32: the controls list shows the throwable row ("4 / G") instead of the grenade row, in Pause and in the
      waiting room, with no keycap overlap at 1280×720.

---

## 14. Requests for other owners

**tech-lead (contract, ADR 0007):** the fields in §12. Most important for P1: `HudSlotView.level`,
`HudLocalView.throwables / throwableSelected (predicted) / meleeRecovery / weaponLevel`, `cook.throwable`,
`HudArmorView.tier` 1–4, `interactPromptChanged.level / replacesSlot`, `playerKilled.weaponLevel`,
`localHitConfirmed.obscured`, `HudView.inSmoke`, `HudView.layout`, `HudMinimapView.layout`, `RoomView.lockedLayout`.
P2: `lootPeek`, `spectate.weapon / weaponLevel`. Snapshot budget: none of these are wire fields except what the brief
already adds (held level in `PlayerState`, level on loot and slots); the rest are client-derived.

**game-developer:** `segmentBlockedBySmoke` in `src/shared/sim/` (pure; same rule as bot LOS); `grenadeDanger`
filtered to frags; ClientGame predicts `throwableSelected` and the melee swing for `meleeRecovery`; compute
`obscured`, `inSmoke`, `lootPeek` (P2) in ClientGame/hudBuilder.

**game-designer:** confirm (a) selection persistence and auto-reselect for the throwable slot; (b) whether smoke can be
cooked (the Ui supports both); (c) whether picking up the same weapon at a lower or equal level is allowed or refused
(the Ui shows ▼ / = either way; if refused, add a refusal reason and the Ui shows it as a blocked chip, like armor);
(d) the kill-marker-through-smoke decision in §6.2 (Ui proposal: show it); (e) whether the revolver stays.

**graphics-designer:** final level hex values and names-for-tokens in STYLE.md (constraints in §1.2); ground marker
in the level colour with N notches and L4 sparkles; weapon level tint band; SVG icons (32×32, STYLE §18 rules) for
`knife`, `machete`, `paddle`, `dbshotgun`, `revolver`, `rpg`, `ammo_rocket`, `smoke`, `vest_4`, `helmet_4`, with a
clip-path fallback shape each. Ui proposal for the clip-path shapes: knife = thin lozenge, machete = curved leaf,
paddle = lollipop / oar, dbshotgun = two side-by-side squares, revolver = pentagon, rpg and ammo_rocket = arrowhead
(➤), smoke = three-puff cloud. Armor icon fills: do they move to the level palette or keep the per-tier art? (The Ui
uses level colours on the pips and badge either way.)

**graphics-engineer:** name tags and the spectate outline hidden when the camera→target segment crosses a cloud
(shared helper); smoke opacity and size identical on Low / Medium / High; look presets keep HUD-relevant contrast
(the night office must not make the minimap or crosshair harder to read; the Ui does not change); RPG viewmodel iron
sight with two small range marks.

**audio-designer:** hit tick suppressed when `localHitConfirmed.obscured` (kill sound still plays); a short click on
throwable cycle; rocket whoosh loud enough to act as the incoming-rocket cue.

**level-designer:** the list of look preset ids per map (narrative already wrote `look.island01.{morning,noon,golden,overcast}` and
`look.office.{day,evening,afterHours}`; the preset ids must match those, or tell narrative) and the waiting-room glyph); confirm
that huts and large cover pieces have colliders with a footprint ≥ 6 m² so the minimap rule picks them up.

**narrative-designer:** the keys in §11.

**network-engineer:** the layout seed (and look id, or enough to derive it) reaches the client at vote lock, so the
waiting-room card can show the look line and the minimap can draw the props before the carrier.

---

## 15. Files the build will touch (ui-ux-designer, after the contract)
`src/ui/hud.ts` (slots, throwable slot, sight chips, scope stash, tooltips, prompt, recovery ring, smoke outline), `src/ui/icons.ts` (new icons, level
badge), `src/ui/feed.ts` (feed keys, badge), `src/ui/screens.ts` (death card line, controls rows, layout code), `src/ui/ads.ts` (2x overlay, rim by scope type),
`src/ui/rooms.ts` (look line, mini map props), `src/ui/minimap.ts` (layout props), `src/ui/logic.ts` + a new
`src/ui/m2c.test.ts` (pure models in §13), `src/ui/ui.css` (`--lv1..4`, badge, sparkle, throwable chip).

---

## 16. Scopes (Addendum 1)

Scopes are loot items (`scope_red_dot`, `scope_2x`, `scope_4x`, `scope_8x`) with **no level**. A scope mounted on a gun
stays with that gun. Every gun keeps its built-in sight; a mounted scope overrides it, and removing the scope brings the
built-in sight back. Which guns take which scopes, the stash size, and swap timing are game-designer decisions. The Ui
reads them from HUD fields (§16.8) and never from a hard-coded list.

### 16.1 Sight chip on gun slots
```
 ①                         ② (active)
┌──────────────┐  ┌──────────────────────────────────────┐
│ ● ┌─┐    8   │  │ ◆ Longshore Rifle   ┌─┐        24    │
│   │2│  (•)   │  │                     │3│  [2×]        │   chip under the mag number
└───┴─┴────────┘  └─────────────────────┴─┴──────────────┘
```
| Effective sight on the gun | Chip | Notes |
|---|---|---|
| Built-in iron sight, nothing mounted | none | most guns at pickup |
| Built-in optic (dmr 4x, sniper 8x), nothing mounted | outline chip, ink text: `4×` / `8×` | `hud.scope.builtIn` in the tooltip; it cannot be removed |
| Mounted red dot | filled chip with the red-dot glyph (dot in a ring) | |
| Mounted 2x / 4x / 8x | filled chip with `2×` / `4×` / `8×` | the text is the tell; the fill is the scope's rim colour (§16.5) |

- The chip is 0.9em high, with an ink outline and ink text (contrast ≥ 7 : 1 on every fill). "Mounted" (filled) and
  "built-in" (outline only) differ by shape, not colour.
- The chip is the same on inactive and active slots, so you can see what is on both guns at a glance.
- Narrow (≤ 900 px): the chip stays, and the red-dot glyph replaces any text.
- Screen readers: `hud.slot.sr` gets `hud.scope.sr` appended ("{scope} mounted" or "built-in {scope}").

### 16.2 Spare-scope stash (tiny)
```
                                      ┌───────────────┐
  slot row:  ① ② ③ ④                  │ ⊕ (•) 4×      │   stash chip: a lens glyph, then one mini chip per spare
                                      └───────────────┘   (left of the slot row, same height; hidden when empty)
```
- Shown only when the player carries at least one spare. It holds at most `scopeStashMax` chips (designer: one per
  type or one shared slot). The Ui draws whatever list it gets, up to 4.
- Spares that fit the **active** gun are full opacity. Spares that don't fit it are at 45 % opacity with a diagonal ink
  slash (a shape cue, not only fading). That tells you in one glance whether [T] will do anything.
- Narrow: the stash shows the lens glyph plus a count (`×2`) only.

### 16.3 Picking up a scope: prompt and auto-mount feedback
```
 fits the held gun:      [(2×) [E] Pick up 2x Scope │ → Longshore Rifle]          target gun icon + name
 fits the other gun:     [(2×) [E] Pick up 2x Scope │ → Spritzer SMG ②]           slot keycap shows which
 goes to the stash:      [(2×) [E] Pick up 2x Scope │ → Pouch]                     lens glyph
 nowhere to put it:      [🔒 Scope pouch full!]                                    blocked chip (dashed, lock)
 fits none of your guns: [(8×) [E] Pick up 8x Scope │ → Pouch · Fits: DMR, Sniper] still allowed if the pouch has room
 gun with a scope on it: [◆ [E] Pick up Longshore Rifle ┌─┐ (4×)]                   the gun's level badge + sight chip
                                                        │3│
```
- The target after the arrow comes from `interactPromptChanged.scopeTarget` (§16.8). The auto-mount rule
  (held gun → other gun → stash) is the sim's. The Ui only shows the result, so the prompt never promises what the server
  won't do.
- "Fits: …" lists the type names (`item.<id>.type`) of compatible guns, and shows only when the scope fits neither
  carried gun.
- **After the press** (on the server's confirm): the target slot's chip pops (scale 1 → 1.25 → 1, 200 ms; reduced
  motion: a 200 ms outline flash instead) and a pickup toast reads `hud.scope.mounted` ("2x Scope on Longshore Rifle")
  or `hud.scope.stashed`. The replaced scope, if any, appears in the stash with the same pop. The Ui sees the change by
  comparing `HudSlotView.scope` from frame to frame on the same weapon instance, so no new event is needed.
- **Feedback within 100 ms:** the E press already gets the prompt's pressed state immediately (M1 rule). The mount
  pop follows the server's confirmation (pickups are not predicted).

### 16.4 Swapping or removing a scope (keyboard first)
- **[T] Switch sight** while holding a gun cycles that gun's sight through: mounted scope → each spare that fits, in
  zoom order → **built-in sight** (that is "remove") → back around. The scope taken off goes into the stash. If the stash
  is full, the cycle skips "built-in" so a scope is never lost. (If game-designer wants a separate drop, that is a
  later addition.)
- **Feedback:** the active slot's chip changes and pops. A small chip under the crosshair (in the hint/prompt slot, not
  over the aim point) reads `hud.scope.now` ("Sight: 2x Scope") for 1.2 s. The stash chips update. All of this is
  driven by the **predicted** sight (§16.8), so it shows within one frame of the key press.
- **Timed swap (if the designer adds one):** the reload ring and a "Mounting…" chip (`hud.scope.mounting`), cancelled
  like a reload. ADS ends while it runs.
- **Refusals** (dashed toast, warn glyph, one at a time): gun has no compatible scopes and nothing mounted →
  `hud.scope.cantFit`; nothing in the stash fits and nothing is mounted → `hud.scope.noneFits`. Pressing T with fists,
  melee, a throwable or the RPG shows `hud.scope.cantFit`.
- **While scoped:** T is ignored (no toast). Leave ADS first, so the overlay never swaps under your eye.
- **Touch fallback:** tap the active slot's sight chip, which does the same as T. The chip's tap target is padded to
  44 px. Long-press on a chip shows its tooltip.
- **Mouse fallback:** while the pointer is free (Pause / Click to play), the slot row and stash take pointer events
  above the dim backdrop. Hover or focus shows tooltips, and clicking the active slot's sight chip cycles. Clicks
  elsewhere still resume as before.
- **Controls list:** a new row `menu.controls.scope.*` ("T" / "Switch sight") in Pause and the waiting room. One-time
  `hint.scope` the first time the player holds a gun while a fitting spare is in the stash.

### 16.5 ADS overlays by sight type (first person)
| Sight | In FP ADS | Rim colour | Reticle |
|---|---|---|---|
| iron (built-in) | viewmodel sight (unchanged) | — | — |
| red dot (built-in or mounted) | viewmodel red dot (render, unchanged); no Ui dot | — | — |
| **2x (new)** | full-screen overlay, **wider lens: radius 46vmin** (4x and 8x stay at 42vmin) | mint `#2EC4B6` | ring + dot (below) |
| 4x | unchanged (UI.md §11) | cornflower `#5B8DEF` | chevron + mil ticks |
| 8x | unchanged | pink `#FF6FA8` | fine crosshair + mil dots |

The rim is now keyed by **scope type**, not by weapon family. A 4x on a rifle gets the same frame as on a DMR.

**2x reticle** (same rules as STYLE §17: ink under-strokes, non-scaling strokes, viewBox −100..100 sized to the lens):
```svg
<svg viewBox="-100 -100 200 200" style="width:92vmin;height:92vmin">
  <style>path, circle { vector-effect: non-scaling-stroke; }</style>
  <g fill="none" stroke-linecap="round">
    <g stroke="#2A1D33" stroke-width="7"><path d="M-100 0 H-55 M55 0 H100 M0 55 V100"/></g>
    <circle r="16" stroke="#2A1D33" stroke-width="4.4"/>
    <circle r="16" stroke="#FF3B5C" stroke-width="2.4"/>
    <g stroke="#3D3A4B" stroke-width="4"><path d="M-100 0 H-55 M55 0 H100 M0 55 V100"/></g>
  </g>
  <circle r="1.6" fill="#FF3B5C" stroke="#2A1D33" stroke-width="1"/>
</svg>
```
The open ring with a centre dot reads as "close-range optic", and it is clearly different from the 4x chevron and the
8x mil-dots, so the reticle shape tells you which scope you are looking through (not the rim colour alone). The iris
(120 ms in, 80 ms out; reduced motion: fade only), the hint hiding and the sensitivity scaling are all unchanged. Smoke
rules (§6) apply to every overlay. Graphics-designer should confirm the 2x art in STYLE §17.

`logic.adsReticle` gains `scope_2x` → frame `'2x'`. Nothing else in the ADS code path changes.

### 16.6 Tooltips
- **Where:** the sight chips and stash chips, on hover or focus while the pointer is free, and on long-press on touch.
  They never appear during play with the pointer locked; the prompt and the toasts cover that.
- **Content** (one ink-glass card, max 16em): scope name (`item.<id>.name`), state (`hud.scope.mountedOn` /
  `hud.scope.builtIn` / `hud.scope.inPouch`), `hud.scope.fits` ("Fits: {weapons}"), and the key hint `hud.scope.cycle`
  ("[T] Switch sight").
- **Behaviour:** shown after 300 ms hover (instant on focus), hidden on leave, blur or Esc. Uses `role="tooltip"` +
  `aria-describedby`. It is placed above the chip and flips below at the screen edge.

### 16.7 Loot, feed and others
- A scope on the ground gets a plain marker with no level colour and no notches. The model is the scope itself (render).
- A gun on the ground with a scope: the prompt shows the sight chip (§16.3); the 3D model shows the scope (render).
- The kill feed and death card don't show scopes (kept short).
- The spectate bar shows nothing new.

### 16.8 Contract asks (tech-lead)
```ts
interface HudSlotView {
  scope: ScopeId | null;          // mounted scope (null = built-in sight only)
  sight: SightType;               // effective sight now ('scope_2x' added to SightType); PREDICTED for T cycling
  builtInSight: SightType;        // weapons.<id>.sight, for the outline chip
  compatibleScopes: ScopeId[];    // from balance; [] for fists, melee, throwables, rpg
}
interface HudLocalView {
  scopeStash: ScopeId[];          // spares, in display order
  scopeStashMax: number;
  scopeSwapProgress?: number | null; // 0..1 only if the designer makes swapping timed
}
// interactPromptChanged += scope: ScopeId | null            (scope mounted on a ground gun)
//                       += scopeTarget: SlotIndex | 'stash' | null   (where a scope pickup will go)
// ActionFailReason      += 'scopeStashFull' | 'scopeCantFit' | 'scopeNoneFits'
// PlayerInput           += cycleScope edge (ClientGame binds KeyT); UiCallbacks.onCycleScope?() for chip tap/click
// AdsView.sight          includes 'scope_2x'
```
The Ui needs no `scopeMounted` event; it compares slot `scope` values between frames on the same weapon instance. That
needs a stable per-slot weapon identity, or the tech-lead can add the event if that is simpler.

### 16.9 String keys (scopes)
| Key | Proposed text |
|---|---|
| `item.scope_red_dot.name/type/desc` … `item.scope_8x.*` | names for the four scopes (type e.g. "Red dot", "2x scope") |
| `hud.scope.mountsOn` | "→ {weapon}" (prompt target) |
| `hud.scope.toPouch` | "→ Pouch" |
| `hud.scope.stashFull` | "Scope pouch full!" |
| `hud.scope.fits` | "Fits: {weapons}" |
| `hud.scope.mounted` | "{scope} on {weapon}" (toast) |
| `hud.scope.stashed` | "{scope} in your pouch" (toast) |
| `hud.scope.now` | "Sight: {sight}" |
| `hud.scope.mounting` | "Mounting…" (only if swapping is timed) |
| `hud.scope.cantFit` | "No scopes fit this" |
| `hud.scope.noneFits` | "No spare scope fits this gun" |
| `hud.scope.builtIn` | "Built-in" |
| `hud.scope.mountedOn` | "On your {weapon}" |
| `hud.scope.inPouch` | "In your pouch" |
| `hud.scope.cycle` | "[T] Switch sight" |
| `hud.scope.sr` | "{scope} mounted" |
| `hud.scope.srBuiltIn` | "built-in {scope}" |
| `hud.scope.stash` | "Spare scopes" (aria label) |
| `sight.iron` | "Iron sights" (shown by `hud.scope.now` when cycling back to the built-in sight) |
| `hint.scope` | "Press T to switch sights." |
| `menu.controls.scope.key` / `.label` | "T" / "Switch sight" |

### 16.10 Acceptance criteria (scopes)
- [ ] M2C-UI-33 (Vitest): `sightChipModel(slot)` returns none for built-in iron, outline `4×`/`8×` for built-in
      optics, filled chips for mounted scopes, and the red-dot glyph for `scope_red_dot`.
- [ ] M2C-UI-34: picking up a scope shows the prompt target that matches `scopeTarget` (held gun, other gun with its
      keycap, or Pouch); a full pouch shows the blocked chip with the lock glyph; "Fits: …" shows only when it fits
      neither gun.
- [ ] M2C-UI-35: after a mount, the target chip pops (reduced motion: outline flash) and the toast names the scope and
      gun; a replaced scope appears in the stash.
- [ ] M2C-UI-36: with a fitting spare, T changes the active slot's chip, the stash and the "Sight: …" chip within
      100 ms of the key press (performance mark), and cycling reaches "Iron sights" (or the built-in optic) and back.
      With a full stash the cycle never offers the built-in step.
- [ ] M2C-UI-37: T with fists, melee, a throwable or the RPG shows "No scopes fit this" once (spam keeps one toast);
      T while scoped does nothing.
- [ ] M2C-UI-38: stash chips that don't fit the active gun are faded **and** slashed; switching guns updates them.
- [ ] M2C-UI-39: 2x ADS shows the 46vmin lens, mint rim and ring-dot reticle; 4x and 8x are unchanged on every gun
      they mount on (rim follows the scope, not the weapon). Reduced motion: fade only.
- [ ] M2C-UI-40: while paused, hovering or focusing a sight or stash chip shows its tooltip after 300 ms (instantly on
      focus); Esc hides it; clicking the active sight chip cycles; clicking elsewhere still resumes. On touch, tapping
      the chip cycles and long-press shows the tooltip.
- [ ] M2C-UI-41: at 1280×720 / UI size 150 % and at 900 px wide, the chips and the stash fit without overlapping the
      slot row, the ammo panel or the toasts.
- [ ] M2C-UI-42: the controls list shows "T Switch sight"; `hint.scope` shows once on its trigger.

### 16.11 Requests for other owners (scopes)
- **game-designer:** compatibility lists; stash size (one per type or one shared slot); whether swapping is instant or
  timed; whether the cycle should skip the built-in step when the stash is full (Ui proposal: yes); whether spare scopes
  drop on death (the Ui doesn't care).
- **graphics-designer:** confirm the 2x overlay art and the mint rim in STYLE §17; scope icons (32×32 SVG + clip-path
  fallback) for the four scopes; scope models on the gun and on the ground.
- **game-developer / ClientGame:** bind `KeyT` to `cycleScope` (T is free today); predict `HudSlotView.sight` on cycle.
- **audio-designer:** a short "click-clack" on mount and cycle.
- **narrative-designer:** §16.9 keys.


---

## 17. As built (build phase 1, before the C-gate)

Every M2c field is read as optional, so the Ui works before and after the C-gate (checked with the tech-lead's trial
flip: no `src/ui` errors either way).

**Final values used (they replace the drafts above):**
- Level colours from docs/art/M2c.md §1.1: L1 `#B8E7FF`, L2 `#FFF14D`, L3 `#F2590D` (text `#FF7A3D`), L4 `#B963E3`
  (text `#D08BF0`), ink numeral `#2A1D33`. CSS tokens `--lv1..4`; `LEVEL_COLOUR` in `icons.ts`.
- The 2x overlay follows art §14.5: 46vmin lens, **coral `#FF7A5C`** rim (not the mint in §16.5), 88 % outside, the
  "sunrise ring" reticle. Rims are keyed by scope type. The overlay rule is `hasScopeOverlay` (2x / 4x / 8x).
- Contract names: `HudView.layout.look`, `RoomView.lockedLayout.look`, `interactPromptChanged.scopeTarget` is
  `0 | 1 | 'pouch' | null`, refusal `scopePouchFull` → `hud.scope.pouchFull` (blocked prompt chip:
  `hud.scope.stashFull`). Slot index 3's `weapon` is the selected throwable.
- Strings: the en.json names (§11 table), plus `look.<map>.<id>.line` under the look line, `sight.<SightType>` in
  "Sight: …", `layout.seed` with `formatLayoutSeed` (the same text `LAYOUT_SEED` accepts).

**Built:** level badges (slots, prompt, feed, death card, pickup toast) and 4 armor pips; melee slot and "Fists are
back"; throwable slot (selected + mini chip + `[4] Swap`, cycle pulse, screen-reader line); sight chips (mounted /
built-in / red dot) and the pouch (faded + slashed when it does not fit), both clickable while the pointer is free;
prompt (levelUp, swapFrom, ▲ / ▼ / = tag, ground scope chip, "→ gun" / "→ Pouch" / "Fits: …" from balance
`scopes.compatible`, melee note); "Sight: …" chip on a predicted sight change; melee recovery ring; smoke cook ring;
RPG hollow dot and "No rockets"; hit markers hidden when `obscured` (kills still show); in-smoke crosshair outline;
feed routing per narrative M2c §5 incl. `rocketDirect` and (P2) `feed.smoke`; controls rows; M2c hints; island
minimap blocks (`islandPropBlock`: main collider ≥ 8 m², top ≥ 1.2 m: huts and big rocks) and a static-layer rebuild per
match / layout seed; waiting-room look line; "Layout #0x…" in Pause and Results.

**Phase 2 (after the C-gate):** icons for every M2c item and the 2x reticle / rim colours now come from the
graphics-designer's `src/render/procedural/icons.ts` (`M2C_ICON_SVG`, `SCOPE_2X_RETICLE_SVG`, `SCOPE_RIM_COLOR`; the SVG's
inline `<style>` is turned into per-element attributes so it never leaks into the page). Added: touch long-press
tooltip on sight chips (450 ms), the legacy-lobby look line, the P2 loot peek (dimmed chip, hidden in smoke and while
scoped) and the P2 spectate weapon + badge (both shown only when ClientGame sends the fields).

**Not built:** a long-press tooltip on pouch chips (they use the native title).

**Tests:** `src/ui/m2c.test.ts` (AC M2C-UI-01, 05, 06, 07, 08, 10, 11, 16, 18 (reticle), 19, 22, 25-28, 32, 33, 34, 38,
39 and string presence).
