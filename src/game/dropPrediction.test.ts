/**
 * Drop prediction against the real World (drop.md, ADR 0005 §8): ClientGame (real shared movement + action steps)
 * talks to a DebugWorld through a latency-delayed fake net. Through the carrier jump, freefall, a manual deploy, the
 * chute and the landing, reconciliation corrections stay tiny, and the local drop events come once each from
 * prediction.
 */
import { describe, expect, it } from 'vitest';
import { SIM_DT } from '../shared/constants';
import type { ClientGameDeps } from '../shared/contracts';
import { EventBus, type GameEvents } from '../shared/events';
import { balanceWith, flatMap } from '../shared/sim/testkit';
import { createDebugWorld } from '../shared/sim/World';
import type { PlayerInput, SimEvent, WorldSnapshot } from '../shared/types';
import { ClientGame } from './ClientGame';
import type { DevGameState } from './devHook';
import { FakeInput, FakeNet } from './testFixtures';

const TICK_MS = SIM_DT * 1000;

function harness(latencyTicks: number) {
  const balance = balanceWith((b) => {
    b.match.minHumansToStart = 2;
    b.match.targetPlayers = 2;
    b.match.countdownSeconds = 0;
  });
  const map = flatMap();
  const w = createDebugWorld({ map, balance, seed: 3, botNames: ['Bot'], drop: true });
  const id = w.addPlayer('Me')!;
  w.addPlayer('Other');

  const bus = new EventBus<GameEvents>();
  const events: { type: keyof GameEvents; payload: unknown }[] = [];
  const emit = bus.emit.bind(bus);
  bus.emit = (type, payload) => {
    events.push({ type, payload });
    emit(type, payload);
  };
  const net = new FakeNet();
  const input = new FakeInput();
  const deps: ClientGameDeps = { bus, net, inputTarget: {} as HTMLElement, balance, getMap: () => map, initialMap: map, serverUrl: 'ws://x' };
  const dev: { read: (() => DevGameState) | null } = { read: null };
  const game = new ClientGame(deps, { input, grenadeArc: null, installDevHook: (r) => ((dev.read = r), () => {}) });

  const toServer: { at: number; input: PlayerInput }[] = [];
  const toClient: { at: number; snap: WorldSnapshot; events: SimEvent[]; time: number }[] = [];
  let tick = 0;
  let worst = 0;
  net.pushWelcome({ playerId: id, mapId: map.id });

  /** One server tick and one client frame of one fixed step. */
  const step = (): void => {
    tick++;
    // Client clock: the server time at which an input sent now is processed (it arrives `latencyTicks` later and is
    // consumed by the next World.step, whose clock is one tick ahead of w.timeMs). A perfect estimate isolates the
    // prediction rules; a real clock error shifts the jump start by error x carrier speed (ADR 0005 §8).
    net.now = w.timeMs + (latencyTicks + 1) * TICK_MS;
    const sentBefore = net.sent.length;
    game.update(SIM_DT + 1e-9);
    for (const i of net.sent.slice(sentBefore)) toServer.push({ at: tick + latencyTicks, input: i });
    while (toServer.length && toServer[0]!.at <= tick) w.applyInput(id, toServer.shift()!.input);
    const evs = w.step(SIM_DT);
    toClient.push({ at: tick + latencyTicks, snap: w.snapshotFor(id), events: evs, time: w.timeMs });
    while (toClient.length && toClient[0]!.at <= tick) {
      const m = toClient.shift()!;
      net.pushEvents(m.events, m.time);
      net.pushSnapshot(m.snap);
    }
    worst = Math.max(worst, dev.read!().lastCorrection);
  };
  const of = <K extends keyof GameEvents>(k: K) => events.filter((e) => e.type === k).map((e) => e.payload as GameEvents[K]);
  return { w, id, game, net, input, step, of, dev, worst: () => worst, balance };
}

describe('drop prediction vs the real World', () => {
  it('jump, freefall, manual deploy, chute and landing: no visible correction, one local event each', () => {
    const h = harness(2);
    // Wait aboard until jumping is allowed.
    for (let i = 0; i < 10; i++) h.step();
    expect(h.dev.read!()).toMatchObject({ aboard: true, cameraView: 'carrier' });
    const route = h.w.getMatch().route!;
    expect(route).not.toBeNull();
    while (h.net.now < route.noJumpUntil + 3 * TICK_MS) h.step();
    h.input.state.keyDown('Space');
    h.step();
    h.input.state.keyUp('Space');
    for (let i = 0; i < 3; i++) h.step();
    expect(h.dev.read!()).toMatchObject({ dropPhase: 'freefall', cameraView: 'firstPerson' });
    // Manual deploy after minFreefallMs (F).
    for (let i = 0; i < Math.ceil(h.balance.drop.minFreefallMs / TICK_MS) + 2; i++) h.step();
    h.input.state.keyDown('KeyF');
    h.step();
    h.input.state.keyUp('KeyF');
    for (let i = 0; i < 6; i++) h.step();
    expect(h.dev.read!().dropPhase).toBe(h.balance.drop.manualDeploy ? 'chute' : 'freefall');
    // Down to the ground.
    for (let i = 0; i < 600 && h.dev.read!().dropPhase !== null; i++) h.step();
    for (let i = 0; i < 6; i++) h.step();
    expect(h.dev.read!().dropPhase).toBeNull();
    expect(h.w.debugPlayer(h.id)!.move.dropping).toBe(false);

    const local = <T extends { isLocal: boolean }>(xs: T[]): T[] => xs.filter((x) => x.isLocal);
    expect(local(h.of('playerJumped'))).toEqual([expect.objectContaining({ auto: false })]);
    if (h.balance.drop.manualDeploy) expect(local(h.of('parachuteOpened'))).toEqual([expect.objectContaining({ manual: true })]);
    expect(h.of('carrierDeparted')).toHaveLength(1);
    expect(h.worst()).toBeLessThan(1e-6);
  });

  it('auto-eject: nobody jumps; the client follows the server jump and predicts the fall', () => {
    const h = harness(2);
    for (let i = 0; i < 5; i++) h.step();
    const route = h.w.getMatch().route!;
    for (let i = 0; i < 2000 && h.net.now < route.ejectAt + 10 * TICK_MS; i++) h.step();
    expect(h.dev.read!().aboard).toBe(false);
    expect(h.dev.read!().cameraView).toBe('firstPerson');
    expect(h.of('playerJumped').filter((e) => e.isLocal)).toEqual([expect.objectContaining({ auto: true })]);
    for (let i = 0; i < 600 && h.dev.read!().dropPhase !== null; i++) h.step();
    expect(h.of('parachuteOpened').filter((e) => e.isLocal)).toHaveLength(1);
    expect(h.worst()).toBeLessThan(1e-6);
  });
});
