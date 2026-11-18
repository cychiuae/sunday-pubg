import { describe, expect, it } from 'vitest';
import { CUE_IDS, type CueId } from './cues';
import { FakeAudioContext, FakeNode, seededRand } from './fakeAudioContext';
import { createNoiseBank } from './noise';
import { RECIPES } from './recipes';
import type { Voice } from './synth';

const VARIANTS: Partial<Record<CueId, string[]>> = {
  'weapon.dryFire': ['pistol', 'smg', 'shotgun', 'rifle'],
  'weapon.switch': ['fists', 'pistol', 'smg', 'shotgun', 'rifle'],
  'reload.start': ['pistol', 'smg', 'shotgun', 'rifle'],
  'reload.finish': ['pistol', 'smg', 'shotgun', 'rifle'],
  'hit.remote': ['body', 'armor', 'armorBreak'],
  'damage.hp': ['body', 'head'],
  'foot.local': ['sand', 'grass', 'water'],
  'foot.remote': ['sand', 'grass', 'water'],
  'land.local': ['sand', 'grass', 'water'],
  'land.remote': ['sand', 'grass', 'water'],
  'pickup.ammo': ['ammo_light', 'ammo_heavy', 'ammo_shell'],
  'pickup.heal': ['bandage', 'medkit'],
  'heal.start': ['bandage', 'medkit'],
  'heal.loop': ['bandage', 'medkit'],
  'ui.prompt': ['weapon', 'ammo'],
  'ui.nope': ['noHeals', 'fullHp', 'inventoryFull', 'betterArmor', 'noAmmo'],
  'death.remote': ['', 'head'],
};

function run(cue: CueId, variant: string, intensity: number, distance: number): { len: number; ctx: FakeAudioContext; v: Voice & { nodes: AudioNode[]; sources: AudioScheduledSourceNode[] } } {
  const ctx = new FakeAudioContext();
  const noise = createNoiseBank(ctx.asAudioContext());
  const out = ctx.createGain();
  const nodes: AudioNode[] = [];
  const sources: AudioScheduledSourceNode[] = [];
  const v = {
    ctx: ctx.asAudioContext(),
    out: out as unknown as AudioNode,
    t: 1,
    pitch: 1,
    intensity,
    variant,
    local: distance === 0,
    distance,
    durationS: 2.5,
    noise,
    rand: seededRand(5),
    addSource: (s: AudioScheduledSourceNode) => sources.push(s),
    addNode: (n: AudioNode) => nodes.push(n),
    nodes,
    sources,
  };
  const len = RECIPES[cue](v);
  return { len, ctx, v };
}

describe('recipes', () => {
  for (const cue of CUE_IDS) {
    it(`${cue} builds a finite, fully-registered voice`, () => {
      for (const variant of VARIANTS[cue] ?? ['']) {
        for (const [intensity, distance] of [[0, 0], [1, 120]] as const) {
          const { len, ctx, v } = run(cue, variant, intensity, distance);
          expect(Number.isFinite(len) && len > 0, `${cue}/${variant} length ${len}`).toBe(true);
          expect(len).toBeLessThan(cue.endsWith('Loop') || cue.endsWith('.loop') || cue === 'drop.wind' ? 200 : 4);

          // Every node the recipe created (all but the voice's own `out`) is registered for disconnect,
          // every source is started, and none is scheduled to stop long after the reported length.
          const created = ctx.nodes.slice(1);
          expect(created.length).toBeGreaterThan(0);
          const registered = new Set(v.nodes as unknown as FakeNode[]);
          for (const n of created) expect(registered.has(n), `${cue}: unregistered ${n.kind}`).toBe(true);
          const sources = v.sources as unknown as FakeNode[];
          expect(sources.length).toBeGreaterThan(0);
          for (const s of sources) {
            expect(s.started).not.toBeNull();
            expect(s.stopped).not.toBeNull();
            expect(s.stopped as number).toBeLessThanOrEqual(v.t + len + 0.05);
          }
        }
      }
    });
  }

  it('remote gunshots get a distant tail layer far away', () => {
    const near = run('shot.rifle.remote', '', 0, 10).ctx.nodes.length;
    const far = run('shot.rifle.remote', '', 0, 150).ctx.nodes.length;
    expect(far).toBeGreaterThan(near);
  });

  it('shotgun reload schedules shells across the reload length', () => {
    const { len, v } = run('reload.start', 'shotgun', 0, 0);
    expect(len).toBeCloseTo(2.5, 6);
    const starts = (v.sources as unknown as FakeNode[]).map((s) => s.started as number);
    expect(Math.max(...starts) - v.t).toBeGreaterThan(1.5);
  });
});
