/**
 * Office glass panes for E2E steering (tsx child process): prints JSON [{ id, x1, z1, x2, z2, cx, cz }] for the glass
 * WALL panes (pane ids follow src/shared/maps.ts glassPanes: glass walls first, in wall order).
 */
import { getMap } from '../../../src/game/levels';
import { glassPanes, isIndoor } from '../../../src/shared/maps';

const map = getMap('office');
if (!isIndoor(map)) throw new Error('office is not indoor');
const out = glassPanes(map)
  .flatMap((p) => ('wall' in p ? [p] : []))
  .map((p) => {
    const w = map.walls[p.wall]!;
    return { id: p.id, x1: w.x1, z1: w.z1, x2: w.x2, z2: w.z2, cx: (w.x1 + w.x2) / 2, cz: (w.z1 + w.z2) / 2 };
  });
process.stdout.write(JSON.stringify(out));
