import { describe, expect, it } from 'vitest';
import type { GameEvents } from '../shared/events';
import { AudioDirector, LOOP_KEY, type AudioCommand, type PlayCommand } from './AudioDirector';

const P = { x: 10, y: 0, z: 5 };

function setup(): { d: AudioDirector; cmds: AudioCommand[]; plays: () => PlayCommand[]; take: () => AudioCommand[] } {
  const cmds: AudioCommand[] = [];
  const d = new AudioDirector((c) => cmds.push(c));
  return {
    d,
    cmds,
    plays: () => cmds.filter((c): c is PlayCommand => c.kind === 'play'),
    take: () => cmds.splice(0, cmds.length),
  };
}

const dmg = (o: Partial<GameEvents['playerDamaged']>): GameEvents['playerDamaged'] => ({
  victimId: 2,
  attackerId: 1,
  amount: 20,
  headshot: false,
  cause: 'weapon',
  sourcePos: P,
  victimPos: P,
  hpAfter: 80,
  armorAfter: 0,
  isLocalVictim: false,
  isLocalAttacker: false,
  ...o,
});

describe('AudioDirector: weapons', () => {
  it('plays local shots 2D and remote shots at the origin, plus one impact per surface', () => {
    const { d, plays } = setup();
    d.shotFired({
      shooterId: 1,
      weapon: 'shotgun',
      origin: P,
      isLocal: false,
      impacts: [
        { point: { x: 1, y: 0, z: 1 }, surface: 'terrain', playerId: null, headshot: false },
        { point: { x: 2, y: 0, z: 1 }, surface: 'terrain', playerId: null, headshot: false },
        { point: { x: 3, y: 0, z: 1 }, surface: 'prop', playerId: null, headshot: false },
        { point: { x: 4, y: 0, z: 1 }, surface: 'player', playerId: 3, headshot: false },
      ],
    });
    expect(plays().map((p) => p.cue)).toEqual(['shot.shotgun.remote', 'impact.ground', 'impact.prop']);
    expect(plays()[0]?.pos).toBe(P);

    const s2 = setup();
    s2.d.shotFired({ shooterId: 1, weapon: 'pistol', origin: P, isLocal: true, impacts: [] });
    expect(s2.plays()).toEqual([{ kind: 'play', cue: 'shot.pistol.local', pos: null, variant: 'pistol' }]);
  });

  it('keys reloads per player and stops them on finish/cancel', () => {
    const { d, cmds } = setup();
    d.reloadStarted({ playerId: 4, weapon: 'shotgun', durationMs: 2600, pos: P, isLocal: false });
    expect(cmds[0]).toMatchObject({ cue: 'reload.start', loopKey: LOOP_KEY.reload(4), durationS: 2.6, pos: P });
    d.reloadFinished({ playerId: 4, weapon: 'shotgun', completed: false, pos: P, isLocal: false });
    expect(cmds.slice(1)).toEqual([{ kind: 'stop', loopKey: LOOP_KEY.reload(4) }]);
    d.reloadFinished({ playerId: 4, weapon: 'shotgun', completed: true, pos: P, isLocal: true });
    expect(cmds.at(-1)).toMatchObject({ cue: 'reload.finish', pos: null, variant: 'shotgun' });
  });
});

describe('AudioDirector: hits and damage', () => {
  it('local victim: hp thump, armor thump, armor break, and ducks ambience', () => {
    const { d, plays, cmds } = setup();
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, armorAfter: 35, hpAfter: 85 }));
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, armorAfter: 0, hpAfter: 20 }));
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, armorAfter: 0, hpAfter: 10 }));
    expect(plays().map((p) => p.cue)).toEqual(['damage.armor', 'damage.armorBreak', 'damage.hp']);
    expect(cmds.filter((c) => c.kind === 'duck' && c.bus === 'ambience')).toHaveLength(3);
  });

  it('zone and fall damage use their own cues', () => {
    const { d, plays } = setup();
    d.playerDamaged(dmg({ isLocalVictim: true, cause: 'zone', attackerId: null }));
    d.playerDamaged(dmg({ isLocalVictim: true, cause: 'fall', attackerId: null }));
    expect(plays().map((p) => p.cue)).toEqual(['zone.hurtTick', 'damage.fall']);
  });

  it('local attacker: hit confirm picks head / armor / break / body / kill', () => {
    const { d, plays, take } = setup();
    const confirm = (o: Partial<GameEvents['localHitConfirmed']>): void =>
      d.localHitConfirmed({ victimId: 2, amount: 20, headshot: false, killed: false, ...o });

    d.playerDamaged(dmg({ isLocalAttacker: true, armorAfter: 30 }));
    expect(plays()).toEqual([]); // no positional thwack for our own hits
    confirm({});
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.armor']);
    take();

    d.playerDamaged(dmg({ isLocalAttacker: true, armorAfter: 0 }));
    confirm({});
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.armorBreak']);
    take();

    d.playerDamaged(dmg({ isLocalAttacker: true, armorAfter: 0 }));
    confirm({ headshot: true });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.head']);
    take();

    d.playerDamaged(dmg({ isLocalAttacker: true, armorAfter: 0 }));
    confirm({});
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.body']);
    take();

    d.playerDamaged(dmg({ isLocalAttacker: true, armorAfter: 0, hpAfter: 0 }));
    confirm({ killed: true, headshot: true });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.kill', 'hitConfirm.head']);
  });

  it('remote-on-remote weapon hits play a positional thwack at the victim', () => {
    const { d, plays } = setup();
    d.playerDamaged(dmg({}));
    expect(plays()).toEqual([expect.objectContaining({ cue: 'hit.remote', pos: P, variant: 'body' })]);
  });

  it('heartbeat threshold is 30 HP by default (matches the HUD) and can be injected', () => {
    const { d, cmds } = setup();
    d.playerDamaged(dmg({ isLocalVictim: true, hpAfter: 31 }));
    expect(cmds.filter((c) => c.kind === 'lowHealth')).toEqual([]);
    d.playerDamaged(dmg({ isLocalVictim: true, hpAfter: 30 }));
    expect(cmds.filter((c) => c.kind === 'lowHealth')).toEqual([{ kind: 'lowHealth', active: true }]);

    const cmds2: AudioCommand[] = [];
    const d2 = new AudioDirector((c) => cmds2.push(c), { lowHealthHp: 50 });
    d2.playerDamaged(dmg({ isLocalVictim: true, hpAfter: 45 }));
    expect(cmds2.filter((c) => c.kind === 'lowHealth')).toEqual([{ kind: 'lowHealth', active: true }]);
  });

  it('armorBefore drives armor / armor-break cues and overrides stale tracking', () => {
    const { d, plays, take } = setup();
    // No prior event for this victim: inference alone would call this a body hit.
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, armorBefore: 20, armorAfter: 0, hpAfter: 70 }));
    expect(plays().map((p) => p.cue)).toEqual(['damage.armorBreak']);
    take();
    // Tracking says 0 armor left, but the vest was re-equipped since: armorBefore wins.
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, armorBefore: 50, armorAfter: 30, hpAfter: 65 }));
    expect(plays().map((p) => p.cue)).toEqual(['damage.armor']);
    take();
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, armorBefore: 0, armorAfter: 0, hpAfter: 50 }));
    expect(plays().map((p) => p.cue)).toEqual(['damage.hp']);
    take();
    // Local attacker: break confirm without any earlier hit on that victim.
    d.playerDamaged(dmg({ victimId: 7, isLocalAttacker: true, armorBefore: 10, armorAfter: 0 }));
    d.localHitConfirmed({ victimId: 7, amount: 20, headshot: false, killed: false });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.armorBreak']);
  });

  it('starts and stops the heartbeat from tracked local HP', () => {
    const { d, cmds } = setup();
    const lowCmds = (): AudioCommand[] => cmds.filter((c) => c.kind === 'lowHealth');
    d.playerDamaged(dmg({ isLocalVictim: true, hpAfter: 60 }));
    expect(lowCmds()).toEqual([]);
    d.playerDamaged(dmg({ isLocalVictim: true, hpAfter: 20 }));
    expect(lowCmds()).toEqual([{ kind: 'lowHealth', active: true }]);
    d.playerDamaged(dmg({ isLocalVictim: true, hpAfter: 10 }));
    expect(lowCmds()).toHaveLength(1);
    d.healFinished({ playerId: 1, item: 'bandage', hpAfter: 40, pos: P, isLocal: true });
    expect(lowCmds().at(-1)).toEqual({ kind: 'lowHealth', active: false });
    expect(d.trackedLocalHp).toBe(40);
  });

  it('local death: defeat sting, stops own loops and heartbeat, but not the tide', () => {
    const { d, cmds, plays } = setup();
    d.zoneChanged({ zone: zone(true) });
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, hpAfter: 5 }));
    cmds.length = 0;
    d.playerKilled({
      killerId: 2, killerName: 'B', victimId: 1, victimName: 'A', weapon: 'rifle', cause: 'weapon', victimPos: P,
      placement: 5, isLocalVictim: true, isLocalKiller: false,
    });
    expect(plays().map((p) => p.cue)).toEqual(['ui.defeat']);
    expect(cmds).toContainEqual({ kind: 'lowHealth', active: false });
    expect(cmds).toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.heal(1) });
    expect(cmds).toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.drop });
    expect(cmds).not.toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.tide });
    expect(cmds.some((c) => c.kind === 'stopLoops')).toBe(false);
  });

  it('other eliminations play a positional bonk-splash', () => {
    const { d, plays } = setup();
    d.playerKilled({
      killerId: 1, killerName: 'A', victimId: 3, victimName: 'C', weapon: 'smg', cause: 'weapon', victimPos: P,
      placement: 4, isLocalVictim: false, isLocalKiller: true,
    });
    expect(plays()).toEqual([expect.objectContaining({ cue: 'death.remote', pos: P, variant: 'body' })]);
  });

  it('headshot eliminations use the head variant of the remote death', () => {
    const { d, plays } = setup();
    d.playerKilled({
      killerId: 4, killerName: 'D', victimId: 3, victimName: 'C', weapon: 'rifle', cause: 'weapon', victimPos: P,
      placement: 4, headshot: true, isLocalVictim: false, isLocalKiller: false,
    });
    expect(plays()).toEqual([expect.objectContaining({ cue: 'death.remote', variant: 'head' })]);
  });
});

function zone(shrinking: boolean): GameEvents['zoneChanged']['zone'] {
  return {
    phaseIndex: 0, phaseCount: 4, center: { x: 0, z: 0 }, radius: 100, targetCenter: { x: 0, z: 0 }, targetRadius: 50,
    phaseEndsAt: 0, shrinking, dps: 1,
  };
}

describe('AudioDirector: tide, heals, movement, UI', () => {
  it('starts the tide whoosh + loop when shrinking begins and stops the loop when it ends', () => {
    const { d, cmds } = setup();
    d.zoneChanged({ zone: zone(false) });
    expect(cmds).toEqual([]);
    d.zoneChanged({ zone: zone(true) });
    d.zoneChanged({ zone: zone(true) });
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : c.kind))).toEqual(['zone.tideRising', 'zone.tideLoop']);
    d.zoneChanged({ zone: zone(false) });
    expect(cmds.at(-1)).toEqual({ kind: 'stop', loopKey: LOOP_KEY.tide });
  });

  it('zone warning plays the horn and ducks ambience; surf toggles once per crossing', () => {
    const { d, cmds } = setup();
    d.zoneWarning({ phaseIndex: 0, secondsUntilShrink: 10 });
    expect(cmds[0]).toMatchObject({ cue: 'zone.warning' });
    expect(cmds[1]).toMatchObject({ kind: 'duck', bus: 'ambience' });
    cmds.length = 0;
    d.localZoneStatusChanged({ outside: true });
    d.localZoneStatusChanged({ outside: true });
    d.localZoneStatusChanged({ outside: false });
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : `${c.kind}:${'active' in c ? c.active : ''}`))).toEqual([
      'zone.enterSurf', 'surf:true', 'zone.exitSurf', 'surf:false',
    ]);
  });

  it('heal start runs a keyed loop; finish chimes; cancel blips locally only', () => {
    const { d, cmds } = setup();
    d.healStarted({ playerId: 1, item: 'medkit', durationMs: 5000, pos: P, isLocal: true });
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : c.kind))).toEqual(['heal.start', 'heal.loop']);
    expect(cmds[1]).toMatchObject({ loopKey: LOOP_KEY.heal(1), pos: null });
    cmds.length = 0;
    d.healCancelled({ playerId: 1, item: 'medkit', pos: P, isLocal: true });
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : c.kind))).toEqual(['stop', 'heal.cancel']);
    cmds.length = 0;
    d.healCancelled({ playerId: 9, item: 'bandage', pos: P, isLocal: false });
    expect(cmds.map((c) => c.kind)).toEqual(['stop']);
  });

  it('footsteps: local 2D, remote positional, surface as variant, sprint louder', () => {
    const { d, plays } = setup();
    d.footstep({ playerId: 1, pos: P, surface: 'grass', sprinting: true, isLocal: true });
    d.footstep({ playerId: 2, pos: P, surface: 'water', sprinting: false, isLocal: false });
    expect(plays()).toEqual([
      expect.objectContaining({ cue: 'foot.local', pos: null, variant: 'grass', intensity: 1 }),
      expect.objectContaining({ cue: 'foot.remote', pos: P, variant: 'water' }),
    ]);
    expect(plays()[1]?.intensity).toBeLessThan(1);
  });

  it('local landing stops the drop wind; tiny remote landings are silent', () => {
    const { d, cmds } = setup();
    d.localPlayerSpawned({ playerId: 1, pos: P });
    expect(cmds.at(-1)).toMatchObject({ cue: 'drop.wind', loopKey: LOOP_KEY.drop });
    cmds.length = 0;
    d.land({ playerId: 1, pos: P, fallSpeed: 10, surface: 'sand', isLocal: true });
    expect(cmds[0]).toEqual({ kind: 'stop', loopKey: LOOP_KEY.drop });
    expect(cmds[1]).toMatchObject({ cue: 'land.local', variant: 'sand' });
    cmds.length = 0;
    d.land({ playerId: 2, pos: P, fallSpeed: 0.5, surface: 'sand', isLocal: false });
    expect(cmds).toEqual([]);
  });

  it('match flow: countdown beeps, start fanfare only from countdown, victory vs results', () => {
    const { d, plays, take } = setup();
    d.countdown({ secondsLeft: 5 });
    d.countdown({ secondsLeft: 2 });
    expect(plays().map((p) => [p.cue, p.intensity])).toEqual([['ui.countdown', 0], ['ui.countdown', 1]]);
    take();
    d.matchPhaseChanged({ phase: 'playing', prev: null, endsAt: null });
    expect(plays()).toEqual([]);
    d.matchPhaseChanged({ phase: 'playing', prev: 'countdown', endsAt: null });
    expect(plays().map((p) => p.cue)).toEqual(['ui.matchStart']);
    take();
    const ended = { winnerId: 1, winnerName: 'A', localKills: 3, totalPlayers: 12, standings: [] };
    d.matchEnded({ ...ended, localPlacement: 1, isLocalWinner: true });
    d.matchEnded({ ...ended, localPlacement: 4, isLocalWinner: false });
    d.matchEnded({ ...ended, localPlacement: null, isLocalWinner: false });
    expect(plays().map((p) => p.cue)).toEqual(['ui.victory', 'ui.results']);
  });

  it('lobby resets state and stops every loop', () => {
    const { d, cmds } = setup();
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, hpAfter: 5 }));
    cmds.length = 0;
    d.matchPhaseChanged({ phase: 'lobby', prev: 'results', endsAt: null });
    expect(cmds).toContainEqual({ kind: 'stopLoops' });
    expect(cmds).toContainEqual({ kind: 'lowHealth', active: false });
    expect(d.trackedLocalHp).toBeNull();
  });

  it('interact prompt ticks only when a new loot comes into range', () => {
    const { d, plays } = setup();
    d.interactPromptChanged({ lootId: 5, item: 'smg', qty: 1 });
    d.interactPromptChanged({ lootId: 5, item: 'smg', qty: 1 });
    d.interactPromptChanged({ lootId: null, item: null, qty: 0 });
    d.interactPromptChanged({ lootId: 5, item: 'smg', qty: 1 });
    expect(plays()).toHaveLength(2);
  });

  it('remote weapon switches play at pos (silent without it); local ones click 2D', () => {
    const { d, plays } = setup();
    d.weaponSwitched({ playerId: 2, weapon: 'rifle', slot: 0, isLocal: false });
    d.weaponSwitched({ playerId: 1, weapon: 'fists', slot: 2, isLocal: true });
    d.weaponSwitched({ playerId: 3, weapon: 'smg', slot: 1, isLocal: false, pos: P });
    expect(plays()).toEqual([
      expect.objectContaining({ cue: 'weapon.switch', variant: 'fists', pos: null }),
      expect.objectContaining({ cue: 'weapon.switch', variant: 'smg', pos: P }),
    ]);
  });

  it('actionFailed: soft nope for local refusals (reason as variant); ignores fire and remotes', () => {
    const { d, plays } = setup();
    d.actionFailed({ playerId: 1, action: 'pickup', reason: 'inventoryFull', isLocal: true });
    d.actionFailed({ playerId: 1, action: 'heal', reason: 'noHeals', isLocal: true });
    d.actionFailed({ playerId: 1, action: 'reload', reason: 'noAmmo', isLocal: true });
    d.actionFailed({ playerId: 1, action: 'fire', reason: 'noAmmo', isLocal: true });
    d.actionFailed({ playerId: 2, action: 'heal', reason: 'fullHp', isLocal: false });
    expect(plays().map((p) => [p.cue, p.variant, p.pos])).toEqual([
      ['ui.nope', 'inventoryFull', null],
      ['ui.nope', 'noHeals', null],
      ['ui.nope', 'noAmmo', null],
    ]);
  });
});
