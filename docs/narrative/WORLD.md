# World: Last One Dry

## Title
- **Final pick: _Last One Dry_.** Says the win condition in three words: the tide rises, and the last castaway standing on dry sand wins.
- Alternate 1: _Tide's Coming!_
- Alternate 2: _Sandbar Scuffle_

Tagline: "The tide is rising. Your manners are not."

String keys: `game.title`, `game.tagline`. The working title "Beach Survival PvP" stays in repo and folder names only. It never appears to players.

## Premise
The **Sunny Seconds**, a budget "relaxation cruise", hit a sandbar off **Mangomoon Isle** and sank in a very relaxed way. Everyone paddled ashore in their swimwear. That includes the passengers, the crew, the karaoke host, and a suspicious number of people who swear they were "just on the buffet line".

Mangomoon Isle has two famous features:
1. **The Ring Tide.** Every afternoon a strange circular tide rolls in from all sides at once and pushes everyone toward one last dry patch. Locals (there are none) blame the full moon. The moon refuses to comment.
2. **The rescue seaplane.** It turns up when the Ring Tide is done. It has **one seat**.

Each afternoon starts with the cruise line's sightseeing seaplane, the **Sunny Hopper**, flying everyone over the island on a "scenic tour". The pilot flies a different route every time and opens the doors soon after take-off, so castaways jump when they like, parachute down, and race for the crates. Anyone who dawdles gets a firm, friendly push.

So nobody is a villain. Everyone is just very motivated to get that seat. The castaways raid crates the cruise line hid around the island for "team-building", grab whatever pops, sprays or goes clack, and politely (then impolitely) settle who gets to go home.

Players who get knocked out aren't dead. They're "washed out": they bob back to the wreck with a lifebuoy and a bruised ego, then queue for the next afternoon's tide. Nobody is ever "killed" in player-facing text. We use eliminated, washed out, bonked, splashed, knocked out.

## The tide (shrinking safe zone)
- In-world it's the **Ring Tide**: a wall of bright turquoise surf that closes in from every direction.
- The safe area is **"the safe sand"** or **"dry sand"**. Outside it you're **"in the surf"** and taking a soaking (damage over time).
- Phases: _waiting_ = "Tide rising in 1:30". _Shrinking_ = "The tide is rising!". _Final_ = "Last dry spot!".
- Elimination by zone = "swept away by the tide".

## Gear (M2a)
The cruise line packed the island crates for a "Castaway Challenge" weekend that never happened, so the loot is a mix of lifeguard kit, beach toys and props from the ship's pirate-themed dinner show.
- **Long guns.** The _Driftwood DMR_ and _Lighthouse Sniper_ came from the dinner show's "lookout" set. Their scopes are real, which surprised everyone. The _Breakwater LMG_ was the show's big finale prop and is just as heavy as it looks.
- **Pearls** (sniper ammo) are rare, like real pearls, so finding a box feels special.
- **Vests:** Puffer Vest (pool toy), Lifeguard Vest (borrowed from the crew), Shellback Vest (tortoise-tough plates from the ship's diving locker).
- **Helmets:** Sand Pail (a kid's bucket), Coconut (half a shell, strapped on), Diving Helmet (brass, from the same locker). A good hat matters on an island of sharpshooters.
- **Pineapple Grenade:** the "Tropical Surprise" party favours from the farewell gala. The surprise is a loud, fruity pop that knocks castaways flat. Hold too long and the surprise is yours.
- Stances need no lore: castaways have always ducked behind deck chairs and lain flat in the sand.

## Gear (M2c)
Full rationale in `docs/narrative/M2c.md`.
- **Melee (replaces fists):** Oyster Knife, Coconut Machete, Outrigger Paddle. They came from the galley and the excursion desk.
- **Guns:** Double Scoop Shotgun (double barrel, Seashells), Sand Dollar Revolver (Coral), Sunburst Launcher (rockets, using **Fireworks** left over from the farewell gala's grand finale).
- **Candyfloss Smoke Bomb:** from the gala's dessert cart and stage-fog kit. Mid-fight label: "Smoke".
- **Lv.4 armor:** Surfboard Vest, Ship's Bell Helmet (both salvaged from the wreck).
- **Item levels:** Breezy (Lv.1), Warm (Lv.2), Hot (Lv.3), Scorcher (Lv.4). One heat ladder for weapons and armor.
- **Each match's weather and lighting:** island = Early Dip, Full Sun, Mango Hour, Sulky Skies. Office = Full Lights, Overtime, Lamps Only.

## Tone guide
- **Sunny, cheeky, harmless.** Think tropical holiday gone gloriously wrong. The rivalry is real, but the violence is cartoonish. Bonks, splashes and sunburn, never gore.
- **Short beats clever.** UI labels are 1 to 3 words. Buttons are verbs: Play, Retry, Rejoin, Close, Leave. Save jokes for flavour text (kill feed, banners, item descriptions, announcer), never for labels the player has to read mid-fight.
- **Clarity first.** Every beachy name must still read as its weapon type. Item descriptions start with the plain type ("Shotgun.", "Light ammo.").
- **Tutorial hints** teach one thing, only when it becomes relevant (on drop, near first loot, first time hurt, first tide warning).
- **Every map, every line.** Kill feed, announcer, death, results and hint lines that can show in any match must read fine on the island and in the office. Beach words belong to the castaways themselves (flip-flops, sunhats, pineapples) or to the core vocabulary (dry, splash, washed out), never to the place (sand, sea, tide, cliff). Place-specific lines live under a map or zone-theme key (`feed.<theme>.N`, `announcer.flight.<map>.*`).
- **Words we use:** castaway (player), safe sand, the tide, washed out, loot, heals.
- **Words we avoid:** kill/killed/dead in big banners (the kill *feed* and kill *count* stay "kills" because players expect that word), slurs, real brands, and names, catchphrases or win slogans from other games or films.

## Naming conventions
- **Items:** a beach object plus the plain weapon type, e.g. "Conch Pistol" or "Spritzer SMG". The shotgun is the one exception ("Scatter Clam"), and its description makes the type clear. Ammo names should hint at size or rarity: Pebbles (light), Coral (heavy), Seashells (shells), Pearls (sniper, rare), Fireworks (rockets, the one man-made exception).
- **Tiered gear (vests, helmets):** each tier gets its own beach object, and the name always ends in the plain type ("Coconut Helmet"). The tier itself is always shown with the plain label `Lv.1` to `Lv.4` (`gear.tier.N`, where `gear.tier.0` = "None"). Descriptions start with the type and tier: "Helmet, Lv.2."
- **Item levels (M2c, weapons and armor):** `level.N.name` = Breezy / Warm / Hot / Scorcher, at most 10 characters. Always show the numeral too (`level.label` = "Lv.4 Scorcher"), never the colour or name alone.
- **Melee weapons:** a beach object plus the plain type ("Oyster Knife"). Descriptions end with "Takes your fists' place."
- **Look presets:** two words at most, map-specific keys `look.<map>.<presetId>`, plus an optional `.line`.
- **Grenades:** the feed and toasts call it a pineapple for flavour, but every label the player must read mid-fight says "Grenade".
- **Places (POIs):** a friendly adjective plus a landmark, e.g. "Rickety Dock" or "Sunburn Summit". Two words at most, so they fit the minimap.
- **Bot castaways:** an alliterative or rhyming nickname, at most 16 characters, beach-themed, no real people.
- **String keys:** flat dotted lowercase `area.thing.detail` (camelCase allowed inside a segment). Random variants are numbered from 0 with no gaps (`feed.kill.0`, `feed.kill.1`...) and picked with `keysWithPrefix()` / `tRandom()`. Placeholders use `{name}` style. Never rename a key once code uses it. Add a new key instead.

## The Open Plan (map `office`)
One afternoon the Ring Tide went out much further than usual and swept a lifeboat of castaways down a storm drain. They came up through a mop bucket in an enormous, empty office, or at least it feels enormous when you are the size of a stapler. Desks loom like cliffs, chairs roll like boulders, and the coffee corner smells of victory. The seaplane can't fly indoors, so the ride is **Parcel Pal**, a toy delivery drone. It carries everyone in a parcel box under the ceiling, opens the hatch, and later lands at the Welcome Mat with room for exactly one. Nobody works here, and no one is named on any desk: the place belongs to no one, so it belongs to whoever stays standing.

String keys: `map.office.name`, `map.office.tagline`. POIs use `poi.office_<id>` and `poi.office_<id>.short`. Rooms and departments are generic, never real people or companies.

### Zone fiction (two options, game-designer picks one)
- **Lights Out** (`*.lightsOut.*`): the ceiling panels outside the circle switch off, and the air con blasts the dark. Outside = "in the dark".
- **Sprinkler Flood** (`*.sprinklers.*`): the sprinklers rain outside the circle, which suits a game called _Last One Dry_. Final phase = "Last dry desk!".
Both mirror the tide keys (`hud.<theme>.*`, `announcer.<theme>.*`, `hint.<theme>`, `feed.<theme>.N`, `death.eliminatedBy<Theme>`). The unused set can stay.

| id | Name | Short | Flavour |
|---|---|---|---|
| office_meeting | Fishbowl Room | Fishbowl | Glass meeting room. Everyone can see you lose. |
| office_phone | Shush Booth | Booth | A white pod for very quiet calls and loud fights. |
| office_corner | Corner Office | Corner | Big chair, nice view, nobody home. |
| office_blue | Blue Room | Blue | A meeting room painted blue. |
| office_yellow | Yellow Room | Yellow | A meeting room painted yellow. |
| office_pantry | Pantry & Loos | Pantry | Snacks one side, plumbing the other. |
| office_admin | Paper Jam Corner | Printer | Filing cabinets and a printer that hates everyone. |
| office_gym | Jam & Gym Room | Gym | Guitars and dumbbells, neither used. |
| office_games | Ping Pong Den | Pong | Paddles, a foosball table, zero productivity. |
| office_tea | Kettle Corner | Kettle | Tea and coffee desk. Warm, cosy, contested. |
| office_entrance | Welcome Mat | Entrance | The front door and the drone's landing spot. |
| office_sales | Sales Row | Sales | Desks of headsets and sticky notes. |
| office_design | Design Bay | Design | Big monitors and colourful clutter. |
| office_eng | Engineering Pit | Eng | Dual screens, cold coffee, cable jungles. |
| office_project | Deadline Corner | Deadline | Wall planners and nervous plants. |

## Cast of places (map `island01`, "Mangomoon Isle")
| id | Name | Flavour |
|---|---|---|
| dock | Rickety Dock | Where the lifeboats bumped in. Planks optional. |
| village | Hammock Hamlet | A few huts strung together by hammocks. |
| wreck | Sunny Seconds Wreck | The cruise ship's sad, sandy remains. |
| rocks | Grumpy Rocks | Boulders that look like they're frowning. |
| grove | Shady Palms | Thick palms, good cover, falling coconuts. |
| tikibar | The Thirsty Tiki | Abandoned beach bar. Still smells of pineapple. |
| summit | Sunburn Summit | Highest point, best view, zero shade. |
