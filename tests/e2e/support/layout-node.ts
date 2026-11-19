/**
 * Node side of the browser-vs-Node layout determinism check (tests/e2e/m2c-layout.spec.ts, REVIEW-M2c MF2).
 * Run with tsx: prints JSON { "<mapId>:<seed>": { hash, digest, look, props, decor } } for the seeds in argv[2] (JSON).
 * `digest` is FNV-1a 32 over JSON.stringify of the whole layout (sim part, decor, picks, look, lightsOn), so it also
 * catches client-only decor differences that layoutHash ignores.
 */
import { getMap } from '../../../src/game/levels';
import { buildMatchLayout } from '../../../src/game/levels/layout/index';

export function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}

const seeds = JSON.parse(process.argv[2] ?? '[0]') as number[];
const out: Record<string, { hash: number; digest: number; look: string; props: number; decor: number }> = {};
for (const mapId of ['island01', 'office']) {
  const base = getMap(mapId);
  for (const seed of seeds) {
    const l = buildMatchLayout(base, seed);
    out[`${mapId}:${seed}`] = { hash: l.hash, digest: fnv(JSON.stringify(l)), look: l.look, props: l.props.length, decor: l.decor.length };
  }
}
process.stdout.write(JSON.stringify(out));
