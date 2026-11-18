/** Prints snapshot size breakdown for a running real World (dev tool). npx tsx server/tools/measure-snapshot.ts */
import { deflateRawSync } from 'node:zlib';
import { keysWithPrefix, t } from '../../src/content/strings';
import { DEFAULT_MAP_ID, getMap } from '../../src/game/levels';
import { SIM_DT } from '../../src/shared/constants';
import { encode, encodeQuantized } from '../../src/shared/protocol/messages';
import { createWorld } from '../../src/shared/sim/World';
import { loadBalance } from '../config';

const balance = loadBalance('{"match":{"countdownSeconds":0.2,"targetPlayers":16}}');
const world = createWorld({ map: getMap(DEFAULT_MAP_ID), balance, seed: 7, botNames: keysWithPrefix('bot.name').map((k) => t(k)) });
const me = world.addPlayer('Measure')!;
for (let i = 0; i < 30 * 20; i++) world.step(SIM_DT); // 20 s into the match: landed, looting, fighting
const snap = world.snapshotFor(me);
const { loot, ...noLoot } = snap;
const rows: [string, unknown][] = [
  ['full snapshot', { t: 'snapshot', snap }],
  ['without loot', { t: 'snapshot', snap: noLoot }],
  ['players only', snap.players],
  ['one player', snap.players[0]],
  ['local', snap.local],
  ['loot', loot],
];
console.info(`players ${snap.players.length}, loot ${loot.length}`);
for (const [name, v] of rows) {
  const raw = encode(v as never);
  const q = encodeQuantized(v as never);
  console.info(`${name.padEnd(15)} json ${String(raw.length).padStart(6)} B  quantized ${String(q.length).padStart(6)} B  deflated(q) ${String(deflateRawSync(q).length).padStart(5)} B`);
}
