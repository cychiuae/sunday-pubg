# Tall grass (island v2)

User request (2026-11-22): grass on the island that players can hide in.

## Rules
- A **grass patch** is a soft island prop (`kind: 'grass'`). It has no collider, so it never stops movement, bullets,
  grenades, rockets or blasts. It gives **concealment, not cover**.
- Size: a disc of `GRASS_PATCH_RADIUS` (2.5 m) x placement scale (0.7-1.4), blades up to about 1.15 m
  (`GRASS_HEIGHT`, `src/shared/grass.ts`). A crouched player (0.95 m) sinks in. A standing head (1.3 m) shows.
- A player is **hidden** from a viewer when all of these are true:
  1. their feet are at least `grass.edgeInset` (0.3 m) inside a patch;
  2. they are crouched or prone (`grass.hidesCrouched`, `grass.hidesProne`). A settled stance counts, and so does a
     crouch <-> prone transition. Standing, or a transition from or to standing, is never hidden;
  3. the viewer is farther than `grass.revealRange` (7 m, horizontal);
  4. they have not fired in the last `grass.revealAfterShotMs` (2000 ms).
- What hidden means:
  - **Bots** cannot pick them as a target and cannot see them when deciding whether to retaliate. A bot keeps chasing
    the last place it saw them, so walking up to the grass (within 7 m) finds them.
  - **Other players**: the body, its shadow and the scope glint fade out over about 0.3 s, and the name tag goes away.
    Shots still hit a hidden player.
  - **Yourself**: a green "Hidden" badge (`hud.grass.hidden`) shows beside the stance icon.

One implementation serves every consumer: `grassHides` / `concealedInGrass` in `src/shared/grass.ts`. The numbers live
in `balance.json` under `grass`.

## Placement (level data)
- `island01.variety.json` scatter zones:
  - `tallGrass`: 50-65 patches in the inland ring (26-141 m), outside the POI discs. Placed before the jungle so the
    count stays steady.
  - `duneGrass`: 8-14 smaller patches at the dune line (139-146 m). Long Beach stays open.
- Baseline (`LAYOUT_SEED=baseline`): 55 inland and up to 10 dune patches (`island.ts`).
- Patches keep the usual 2 m footprint gap, so loot never spawns inside grass and grass never hides a crate.

## Tuning levers
- `revealRange` is the main fairness lever. Lower it to make grass stronger, raise it to make it weaker.
- `revealAfterShotMs` sets how much a grass camper gives away by shooting.
- `hidesCrouched: false` would make grass prone-only, a slower and more committed hide.

## Known limits
- Positions are still sent to every client, so concealment is enforced in the renderer, not on the server.
- Bots do not seek grass on purpose yet. They only lose track of players who use it.
