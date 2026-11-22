import { describe, expect, it } from 'vitest';
import { BALANCE } from './balance';
import { GRASS_PATCH_RADIUS, concealedInGrass, grassHides, grassPatches, inGrass, type GrassSubject } from './grass';
import { ISLAND } from '../game/levels/island';
import { OFFICE } from '../game/levels/office';

const cfg = BALANCE.grass;
const patches = [{ x: 0, z: 0, r: GRASS_PATCH_RADIUS }];
const subject = (over: Partial<GrassSubject> = {}): GrassSubject => ({
  x: 0,
  z: 0,
  stance: 'crouch',
  stanceFrom: 'crouch',
  lastShotAt: -Infinity,
  ...over,
});
const NOW = 100_000;
const FAR = cfg.revealRange + 5;

describe('tall grass (systems/grass.md)', () => {
  it('reads patches from island grass props only', () => {
    const list = grassPatches(ISLAND);
    expect(list.length).toBe(ISLAND.props.filter((p) => p.kind === 'grass').length);
    expect(list.length).toBeGreaterThan(0);
    expect(grassPatches(ISLAND)).toBe(list); // cached
    expect(grassPatches(OFFICE)).toEqual([]);
  });

  it('inGrass honours the edge inset', () => {
    expect(inGrass(patches, 0, 0, cfg.edgeInset)).toBe(true);
    expect(inGrass(patches, GRASS_PATCH_RADIUS - cfg.edgeInset - 0.01, 0, cfg.edgeInset)).toBe(true);
    expect(inGrass(patches, GRASS_PATCH_RADIUS - cfg.edgeInset + 0.01, 0, cfg.edgeInset)).toBe(false);
  });

  it('hides crouched and prone players, never standing ones or a transition from/to stand', () => {
    expect(grassHides(patches, subject(), FAR, 0, NOW, cfg)).toBe(true);
    expect(grassHides(patches, subject({ stance: 'prone', stanceFrom: 'prone' }), FAR, 0, NOW, cfg)).toBe(true);
    expect(grassHides(patches, subject({ stance: 'prone', stanceFrom: 'crouch' }), FAR, 0, NOW, cfg)).toBe(true);
    expect(grassHides(patches, subject({ stance: 'stand', stanceFrom: 'stand' }), FAR, 0, NOW, cfg)).toBe(false);
    expect(grassHides(patches, subject({ stance: 'crouch', stanceFrom: 'stand' }), FAR, 0, NOW, cfg)).toBe(false);
    expect(grassHides(patches, subject({ stance: 'stand', stanceFrom: 'crouch' }), FAR, 0, NOW, cfg)).toBe(false);
  });

  it('reveals to close viewers and after a shot', () => {
    expect(grassHides(patches, subject(), cfg.revealRange, 0, NOW, cfg)).toBe(false);
    expect(grassHides(patches, subject(), cfg.revealRange + 0.01, 0, NOW, cfg)).toBe(true);
    expect(grassHides(patches, subject({ lastShotAt: NOW - cfg.revealAfterShotMs + 1 }), FAR, 0, NOW, cfg)).toBe(false);
    expect(grassHides(patches, subject({ lastShotAt: NOW - cfg.revealAfterShotMs }), FAR, 0, NOW, cfg)).toBe(true);
  });

  it('outside every patch nobody is hidden', () => {
    expect(concealedInGrass(patches, subject({ x: 10 }), NOW, cfg)).toBe(false);
    expect(concealedInGrass([], subject(), NOW, cfg)).toBe(false);
  });
});
