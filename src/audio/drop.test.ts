import { describe, expect, it } from 'vitest';
import type { DropRoute, Vec3 } from '../shared/types';
import { AUDIO_TUNING } from './cues';
import { DropTracker } from './drop';

const ROUTE: DropRoute = {
  mapId: 'office',
  entry: { x: -100, z: 0 },
  exit: { x: 100, z: 0 },
  eject: { x: 80, z: 0 },
  altitude: 25,
  speed: 10,
  startsAt: 1000,
  noJumpUntil: 2500,
  ejectAt: 19000,
  endsAt: 21000,
};

const at = (x: number, y: number, z = 0): Vec3 => ({ x, y, z });

/** Feeds `frames` frames of a listener falling at `speed` m/s; returns the last mix's wind. */
function fall(t: DropTracker, speed: number, frames = 60, dt = 1 / 60): number {
  let y = 100;
  let w = 0;
  for (let i = 0; i < frames; i++) {
    y -= speed * dt;
    w = t.frame(5000, at(0, y), dt).wind;
  }
  return w;
}

describe('DropTracker', () => {
  it('places the carrier along the route at the route altitude until endsAt', () => {
    const t = new DropTracker();
    t.setModel('drone');
    expect(t.frame(1000, at(0, 0), 0.016).carrierActive).toBe(false); // no route yet
    t.carrierDeparted(ROUTE);
    const m = t.frame(11000, at(0, 0), 0.016);
    expect(m.carrierActive).toBe(true);
    expect(m.carrierModel).toBe('drone');
    expect(m.carrierPos).toEqual({ x: 0, y: 25, z: 0 });
    expect(t.frame(21000, at(0, 0), 0.016).carrierActive).toBe(false);
  });

  it('is aboard only after the local spawn, while the carrier flies, and until the eject grace', () => {
    const t = new DropTracker();
    t.carrierDeparted(ROUTE);
    expect(t.frame(2000, at(0, 0), 0.016).aboard).toBe(0); // spectator: no spawn
    t.localSpawned(1);
    expect(t.frame(2000, at(0, 0), 0.016).aboard).toBe(1);
    expect(t.frame(ROUTE.ejectAt + AUDIO_TUNING.carrierEjectGraceMs + 1, at(0, 0), 0.016).aboard).toBe(0);
    t.jumped(2, false); // someone else
    expect(t.localPhase).toBe('aboard');
    t.jumped(1, true);
    expect(t.frame(3000, at(0, 0), 0.016).aboard).toBe(0);
  });

  it('freefall wind rises with the measured fall speed and has a floor; the chute is quieter and flutters', () => {
    const slow = new DropTracker();
    slow.localSpawned(1);
    slow.jumped(1, true);
    const fast = new DropTracker();
    fast.localSpawned(1);
    fast.jumped(1, true);
    const ws = fall(slow, 15);
    const wf = fall(fast, 30);
    expect(wf).toBeGreaterThan(ws);
    expect(wf).toBeCloseTo(1, 1);
    expect(ws).toBeGreaterThanOrEqual(AUDIO_TUNING.freefallWindFloor);

    const still = new DropTracker();
    still.jumped(1, true);
    expect(fall(still, 0)).toBe(AUDIO_TUNING.freefallWindFloor);

    fast.chuteOpened(1, true);
    const m = fast.frame(5000, at(0, 50), 1 / 60);
    expect(m.flutter).toBe(1);
    const chute = fall(fast, 8);
    expect(chute).toBeLessThan(ws);
    expect(chute).toBeLessThanOrEqual(AUDIO_TUNING.chuteWindMax);
    expect(chute).toBeGreaterThanOrEqual(AUDIO_TUNING.chuteWindFloor);
  });

  it('ignores teleports in the speed measurement', () => {
    const t = new DropTracker();
    t.jumped(1, true);
    t.frame(0, at(0, 0), 1 / 60);
    t.frame(0, at(0, 500), 1 / 60); // camera cut
    expect(t.measuredSpeed).toBe(0);
  });

  it('landing ends the drop (local and remote chutes); death and reset clear it', () => {
    const t = new DropTracker();
    t.localSpawned(1);
    t.jumped(1, true);
    t.chuteOpened(1, true);
    expect(t.landed(1, true)).toBe(true);
    expect(t.landed(1, true)).toBe(false); // an ordinary landing afterwards
    expect(t.frame(0, at(0, 0), 0.016)).toMatchObject({ wind: 0, flutter: 0 });

    t.chuteOpened(7, false);
    expect(t.landed(7, false)).toBe(true);
    expect(t.landed(7, false)).toBe(false);

    t.jumped(1, true);
    t.died(1, true);
    expect(t.localPhase).toBe('none');
    t.carrierDeparted(ROUTE);
    t.reset();
    expect(t.activeRoute).toBeNull();
    expect(t.frame(5000, at(0, 0), 0.016).carrierActive).toBe(false);
  });
});
