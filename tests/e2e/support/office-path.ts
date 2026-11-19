/**
 * Office nav paths for E2E steering (tsx child process; qa-tester). The W-pulse walker stalls on office furniture, so
 * office specs follow the same nav graph the bots use. Args: JSON { layoutSeed, from: Vec3, to: Vec3 }[] ; prints JSON
 * (Vec3[] | null)[] - the path points (floor and plateaus) for each request, on the layout-applied office map.
 */
import { getMap } from '../../../src/game/levels';
import { applyLayout, buildMatchLayout } from '../../../src/game/levels/layout/index';
import { BALANCE, balanceForMap } from '../../../src/shared/balance';
import { findPath, PathCache } from '../../../src/shared/sim/nav';
import { prepareMap } from '../../../src/shared/sim/movement';
import type { Vec3 } from '../../../src/shared/types';

const reqs = JSON.parse(process.argv[2] ?? '[]') as { layoutSeed: number; from: Vec3; to: Vec3 }[];
const out: (Vec3[] | null)[] = [];
const runtimes = new Map<number, ReturnType<typeof prepareMap>>();
for (const r of reqs) {
  let rt = runtimes.get(r.layoutSeed);
  if (!rt) {
    const base = getMap('office');
    const map = applyLayout(base, buildMatchLayout(base, r.layoutSeed, { decor: false }));
    rt = prepareMap(map, balanceForMap(BALANCE, 'office'), { nav: true });
    runtimes.set(r.layoutSeed, rt);
  }
  const path = findPath(rt.nav!, r.from, r.to, new PathCache(64));
  out.push(path ? path.points.map((p) => ({ x: +p.x.toFixed(2), y: +p.y.toFixed(2), z: +p.z.toFixed(2) })) : null);
}
process.stdout.write(JSON.stringify(out));
