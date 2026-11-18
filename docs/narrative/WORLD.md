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

So nobody is a villain. Everyone is just very motivated to get that seat. The castaways raid crates the cruise line hid around the island for "team-building", grab whatever pops, sprays or goes clack, and politely (then impolitely) settle who gets to go home.

Players who get knocked out aren't dead. They're "washed out": they bob back to the wreck with a lifebuoy and a bruised ego, then queue for the next afternoon's tide. Nobody is ever "killed" in player-facing text. We use eliminated, washed out, bonked, splashed, knocked out.

## The tide (shrinking safe zone)
- In-world it's the **Ring Tide**: a wall of bright turquoise surf that closes in from every direction.
- The safe area is **"the safe sand"** or **"dry sand"**. Outside it you're **"in the surf"** and taking a soaking (damage over time).
- Phases: _waiting_ = "Tide rising in 1:30". _Shrinking_ = "The tide is rising!". _Final_ = "Last dry spot!".
- Elimination by zone = "swept away by the tide".

## Tone guide
- **Sunny, cheeky, harmless.** Think tropical holiday gone gloriously wrong. The rivalry is real, but the violence is cartoonish. Bonks, splashes and sunburn, never gore.
- **Short beats clever.** UI labels are 1 to 3 words. Buttons are verbs: Play, Retry, Rejoin, Close, Leave. Save jokes for flavour text (kill feed, banners, item descriptions, announcer), never for labels the player has to read mid-fight.
- **Clarity first.** Every beachy name must still read as its weapon type. Item descriptions start with the plain type ("Shotgun.", "Light ammo.").
- **Tutorial hints** teach one thing, only when it becomes relevant (on drop, near first loot, first time hurt, first tide warning).
- **Words we use:** castaway (player), safe sand, the tide, washed out, loot, heals.
- **Words we avoid:** kill/killed/dead in big banners (the kill *feed* and kill *count* stay "kills" because players expect that word), slurs, real brands, and names, catchphrases or win slogans from other games or films.

## Naming conventions
- **Items:** a beach object plus the plain weapon type, e.g. "Conch Pistol" or "Spritzer SMG". The shotgun is the one exception ("Scatter Clam"), and its description makes the type clear. Ammo names should hint at size: Pebbles (light), Coral (heavy), Seashells (shells).
- **Places (POIs):** a friendly adjective plus a landmark, e.g. "Rickety Dock" or "Sunburn Summit". Two words at most, so they fit the minimap.
- **Bot castaways:** an alliterative or rhyming nickname, at most 16 characters, beach-themed, no real people.
- **String keys:** flat dotted lowercase `area.thing.detail` (camelCase allowed inside a segment). Random variants are numbered from 0 with no gaps (`feed.kill.0`, `feed.kill.1`...) and picked with `keysWithPrefix()` / `tRandom()`. Placeholders use `{name}` style. Never rename a key once code uses it. Add a new key instead.

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
