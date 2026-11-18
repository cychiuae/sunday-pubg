# System: Rooms and the Waiting Room (M2b, design)

Numbers: proposed `rooms.*` block (below; the tech-lead adds it with validation in the M2b contract), plus existing `match.*`.
Server-authoritative. Replaces the single shared lobby. Flow (fixed by the brief): Title -> Room browser -> Waiting room -> match
(carrier, drop, fight) -> results -> **the same waiting room**. Leave returns to the browser.
Related: `maps.md` (vote rules), `drop.md` (route reveal at the map lock).

## Purpose
Let friends play together and let strangers find a game, without accounts. The rules aim for zero dead time: a room never waits on an
absent host forever, and a group goes straight from results back into the same room with the same settings.

## Player-facing rules
### Room settings (host)
| Setting | Default | Allowed |
|---|---|---|
| Name | "{name}'s room" (sanitised, max `rooms.nameMaxLength` 24 chars) | any sanitised text |
| Visibility | Public | Public / Private (private = code only, never listed) |
| Map mode | Vote | Island / Office / Vote |
| Max humans | `rooms.defaultMaxHumans` = 12 (= `match.targetPlayers`) | `rooms.minMaxHumans` 1 .. `rooms.maxMaxHumans` 16 (= `match.maxPlayers`) |
| Fill with bots | on (`rooms.fillWithBotsDefault`) | on / off |

- **Fill with bots (decision: yes, a host toggle)**. On: at match start bots are added until `match.targetPlayers` participants (none if
  humans >= target), as today. Off: humans only. It costs one checkbox and enables friends-only matches, which is a common request for a
  group playing in the same office.
- Settings can change only in the waiting room (not during the countdown or a match). Lowering max humans below the current count does
  not kick anyone; it only blocks new joins.
- Every member counts against max humans, including people spectating the running match. A full room refuses joins (`roomFull`).

### Starting
- **Host Start**: allowed with >= `rooms.minHumansToStartWithBots` (1) human when fill is on, or >= `rooms.minHumansToStartWithoutBots`
  (2) humans when fill is off (a 1-human, no-bot match would end at once).
- **Auto-start (decision: yes, two cheap rules)**:
  1. **All ready**: when every human in the room is ready and there are >= `rooms.autoStartAllReadyMinHumans` (2) humans, the countdown
     starts by itself. The host counts as ready (pressing Start is the host's explicit action; the host has no ready tick).
  2. **Public timer**: in a public room with >= `rooms.publicAutoStartMinHumans` (2) humans, a `rooms.publicAutoStartSeconds` (60) timer
     runs and starts the countdown at 0. It resets when the room drops below the minimum or a match ends. Private rooms have no timer (the
     group decides).
  Both obey the minimum-humans rule above.
- **Countdown**: `match.countdownSeconds` (10). The map vote locks `match.mapVoteLockSeconds` (3) before the end, and the carrier route is
  revealed then (`drop.md`). The host can **Cancel** during the countdown (back to waiting; the public timer restarts from full).
  People who join during the countdown are added to the match. If the room falls below the start minimum during the countdown, it cancels.
- `match.minHumansToStart` (the single-lobby rule) is superseded by these rules.

### Map inside a room
- Map mode Island or Office: that map, no vote panel.
- Map mode Vote: the `maps.md` vote among the room's humans (ties random, Random option, rotation when nobody votes). Rotation is per room:
  the first match in a new room is `island01`, then it alternates. Votes persist per player while they stay in the room; leaving clears them.
- The server `MAP` env pins the map in every room, overriding the host's mode (the waiting room shows "Map locked").

### Host migration and leaving
- If the host leaves (or disconnects), the **oldest remaining human** (earliest join time in this room; ties by player id) becomes host at
  once, in the waiting room, during the countdown or mid-match. Being dead or spectating does not matter.
- A room closes when its last human leaves; a running match in it is discarded.
- **Kick (host, M2b if cheap, else Later)**: the kicked player goes back to the browser and cannot rejoin that room for
  `rooms.kickRejoinBlockSeconds` (120). A host cannot kick themself.

### Joining mid-match and returning after results
- Joining a room whose match is running: you spectate it (M1 spectate rules), then you are in the waiting room for the next one. You never
  drop into a running match.
- After results (`match.resultsSeconds` 12) everyone in the room, including spectators, returns to its **waiting room**: same host, same
  settings, same votes; every **ready** flag resets to not ready; the public auto-start timer restarts if the room qualifies.

## States and transitions (per room)
`Waiting` -> Start / all ready / public timer -> `Countdown` -> (lock at -3 s: map + route) -> `Playing` -> winner -> `Results` -> `Waiting`.
`Countdown` -> host Cancel or below minimum -> `Waiting`. Any state -> last human leaves -> `Closed`.

## Proposed balance keys (for the tech-lead)
```json
"rooms": {
  "_note": "systems/rooms.md. Countdown length stays match.countdownSeconds; the map lock is match.mapVoteLockSeconds (maps.md).",
  "defaultMaxHumans": 12,
  "minMaxHumans": 1,
  "maxMaxHumans": 16,
  "fillWithBotsDefault": true,
  "minHumansToStartWithBots": 1,
  "minHumansToStartWithoutBots": 2,
  "autoStartAllReadyMinHumans": 2,
  "publicAutoStartMinHumans": 2,
  "publicAutoStartSeconds": 60,
  "nameMaxLength": 24,
  "kickRejoinBlockSeconds": 120
}
```
Server limits that are ops, not gameplay (`MAX_ROOMS` env default 8, create/join rate limits, room-list throttle) belong to the
network-engineer; suggested defaults: create once per 10 s per connection, 5 join attempts per 10 s, list updates at most once per second.
Validation suggestions: `minMaxHumans <= defaultMaxHumans <= maxMaxHumans <= match.maxPlayers`; `minHumansToStartWithoutBots >= 2`.

## What the UI must show (ui-ux-designer; text from narrative)
Browser: public rooms with name, map mode, humans / capacity, status (Waiting / In match + elapsed), Create and Join-by-code. Waiting room:
player list with host crown and ready ticks, the code big with a copy button, map or vote panel, the settings (editable for the host),
Start / Cancel for the host, "Waiting for host..." for others, the auto-start countdown when a timer runs, and why Start is disabled
("Need 2 players without bots").

## Acceptance criteria (QA)
1. A new room has max humans 12, Vote mode, fill with bots on, Public; max humans outside 1..16 is rejected.
2. Fill on, 1 human, host Start -> match with 12 participants (11 bots). Fill off, 1 human -> Start refused; 2 humans -> match with 2 players, no bots.
   14 humans with fill on -> no bots.
3. 3 humans, all ready (host counts as ready) -> the countdown starts without Start. 1 human ready alone -> nothing.
4. Public room with 2 humans, nobody presses anything -> the countdown starts after 60 s; private room -> never. The timer resets when one leaves.
5. The countdown lasts 10 s; the map and route are in the room's match state 3 s before the end; host Cancel returns to Waiting.
6. Host leaves in the waiting room, the countdown and mid-match: the oldest remaining human is host each time; the last human leaving closes the room.
7. Map mode Office -> office with no vote; Vote -> `maps.md` vote tests pass per room, and two rooms rotate independently; `MAP=island01` pins both rooms.
8. Join mid-match -> spectating, not in the match's standings; after results -> in the waiting room with everyone else.
9. After results: same host, settings and votes; all ready flags false.
10. Full room -> join refused `roomFull`; a private room never appears in the list but joins by code (case-insensitive).
11. Kick (if built): the kicked player cannot rejoin for 120 s, then can.
