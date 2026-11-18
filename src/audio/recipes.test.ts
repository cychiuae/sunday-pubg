import { describe, expect, it } from 'vitest';
import { AUDIO_TUNING, CUE_IDS, type CueId } from './cues';
import { FakeAudioContext, FakeNode, seededRand } from './fakeAudioContext';
import { createNoiseBank } from './noise';
import { RECIPES } from './recipes';
import type { Voice } from './synth';

const VARIANTS: Partial<Record<CueId, string[]>> = {
  'weapon.dryFire': ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper'],
  'weapon.switch': ['fists', 'pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper', 'grenade'],
  'reload.start': ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper'],
  'reload.finish': ['pistol', 'smg', 'shotgun', 'rifle', 'lmg', 'dmr', 'sniper'],
  'hit.remote': ['body', 'head', 'vest1', 'vest3', 'helmet1', 'helmet3', 'vestBreak', 'helmetBreak'],
  'hitConfirm.vest': ['vest1', 'vest3'],
  'hitConfirm.helmet': ['helmet1', 'helmet3'],
  'damage.vest': ['vest1', 'vest2', 'vest3'],
  'damage.helmet': ['helmet1', 'helmet2', 'helmet3'],
  'ads.in': ['iron', 'red_dot', 'scope_4x', 'scope_8x'],
  'ads.out': ['iron', 'red_dot', 'scope_4x', 'scope_8x'],
  'stance.change': ['stand_crouch', 'stand_prone', 'crouch_stand', 'crouch_prone', 'prone_stand', 'prone_crouch'],
  'foot.crouch.remote': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'foot.crawl.local': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'foot.crawl.remote': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'pickup.vest': ['vest_1', 'vest_3'],
  'pickup.helmet': ['helmet_1', 'helmet_3'],
  'grenade.bounce': ['terrain', 'prop', 'water', 'edge', 'glass'],
  explosion: ['ground', 'water'],
  'damage.hp': ['body', 'head'],
  'foot.local': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'foot.remote': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'land.local': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'land.remote': ['sand', 'grass', 'water', 'wood', 'carpet', 'tile'],
  'pickup.ammo': ['ammo_light', 'ammo_heavy', 'ammo_shell', 'ammo_sniper'],
  'pickup.heal': ['bandage', 'medkit'],
  'heal.start': ['bandage', 'medkit'],
  'heal.loop': ['bandage', 'medkit'],
  'ui.prompt': ['weapon', 'ammo'],
  'ui.nope': ['noHeals', 'fullHp', 'inventoryFull', 'betterArmor', 'noAmmo'],
  'death.remote': ['', 'head'],
  'zone.warning': ['tide', 'sprinklers', 'lightsOut'],
  'zone.lights': ['down', 'enter', 'exit'],
  'drop.jump': ['manual', 'auto'],
  'drop.land': ['sand', 'wood', 'carpet', 'tile'],
};

function run(cue: CueId, variant: string, intensity: number, distance: number, durationS = 2.5): { len: number; ctx: FakeAudioContext; v: Voice & { nodes: AudioNode[]; sources: AudioScheduledSourceNode[] } } {
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
    durationS,
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
          expect(len).toBeLessThan(cue.endsWith('Loop') || cue.endsWith('.loop') ? 200 : 4);

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

  it('sniper bolt: the lock click lands at durationS (fireIntervalMs) and nothing runs past it', () => {
    const { len, v } = run('weapon.bolt', 'sniper', 0, 0, 1.4);
    expect(len).toBeGreaterThan(1.38);
    expect(len).toBeLessThan(1.45);
    const starts = (v.sources as unknown as FakeNode[]).map((s) => (s.started as number) - v.t);
    expect(Math.min(...starts)).toBeGreaterThan(0.3); // the bolt opens after the shot, not on it
    expect(Math.max(...starts)).toBeCloseTo(1.38, 2);
  });

  it('sniper shot has a long tail and bay echo, longer than the rifle', () => {
    expect(run('shot.sniper.local', '', 0, 0).len).toBeGreaterThan(run('shot.rifle.local', '', 0, 0).len + 0.8);
  });

  it('far explosions are delayed by the speed of sound (capped) and near ones are not', () => {
    const first = (d: number): number => {
      const { v } = run('explosion', 'ground', 0, d);
      return Math.min(...(v.sources as unknown as FakeNode[]).map((s) => s.started as number)) - v.t;
    };
    expect(first(0)).toBeCloseTo(0, 6);
    expect(first(68.6)).toBeCloseTo(0.2, 3);
    expect(first(5000)).toBeCloseTo(AUDIO_TUNING.maxSoundDelayS, 6);
    expect(run('explosion', 'water', 0, 10).len).toBeGreaterThan(run('explosion', 'ground', 0, 10).len); // geyser spray falls back
  });

  it('prone transition ends with a body thud at durationS; crouch does not need one', () => {
    const { len } = run('stance.change', 'stand_prone', 0, 0, 0.6);
    expect(len).toBeGreaterThan(0.6);
    expect(run('stance.change', 'stand_crouch', 0, 0, 0.2).len).toBeLessThan(0.45);
  });

  it('cook tick spans the fuse and speeds up toward the end', () => {
    const { len, v } = run('grenade.tick', '', 0, 0, 3.5);
    expect(len).toBeGreaterThanOrEqual(3.5);
    const clicks = (v.sources as unknown as FakeNode[]).filter((s) => s.kind === 'bufferSource').map((s) => (s.started as number) - v.t);
    expect(clicks.length).toBeGreaterThan(6);
    const gaps = clicks.slice(1).map((t, i) => t - (clicks[i] as number));
    expect(gaps.at(-1) as number).toBeLessThan(gaps[0] as number);
  });

  it('shotgun reload schedules shells across the reload length', () => {
    const { len, v } = run('reload.start', 'shotgun', 0, 0);
    expect(len).toBeCloseTo(2.5, 6);
    const starts = (v.sources as unknown as FakeNode[]).map((s) => s.started as number);
    expect(Math.max(...starts) - v.t).toBeGreaterThan(1.5);
  });

  it('M2b: indoor floors each sound different from sand (distinct layer sets)', () => {
    const sig = (variant: string): string =>
      run('foot.remote', variant, 0.5, 0)
        .ctx.nodes.map((n) => `${n.kind}:${n.type}`)
        .join(',');
    const sigs = new Set(['sand', 'wood', 'carpet', 'tile'].map(sig));
    expect(sigs.size).toBe(4);
  });

  it('M2b: the indoor zone warning swaps the conch for a chime but keeps the whistles', () => {
    const conch = run('zone.warning', 'tide', 0, 0).ctx.nodes.filter((n) => n.kind === 'oscillator' && n.type === 'sawtooth').length;
    const chime = run('zone.warning', 'sprinklers', 0, 0).ctx.nodes.filter((n) => n.kind === 'oscillator' && n.type === 'sawtooth').length;
    expect(conch).toBeGreaterThan(0);
    expect(chime).toBe(0);
  });
});
