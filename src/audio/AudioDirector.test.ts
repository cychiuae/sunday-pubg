import { describe, expect, it } from 'vitest';
import type { GameEvents } from '../shared/events';
import { BALANCE } from '../shared/balance';
import type { ArmorHit } from '../shared/types';
import { AudioDirector, DUCKS, LOOP_KEY, type AudioCommand, type PlayCommand } from './AudioDirector';
import { AUDIO_TUNING } from './cues';

const hit = (tier: 1 | 2 | 3, broken = false): ArmorHit => ({ tier, absorbed: 10, broken });

const P = { x: 10, y: 0, z: 5 };

function setup(): { d: AudioDirector; cmds: AudioCommand[]; plays: () => PlayCommand[]; take: () => AudioCommand[] } {
  const cmds: AudioCommand[] = [];
  const d = new AudioDirector((c) => cmds.push(c), { balance: BALANCE });
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
  vest: null,
  helmet: null,
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
  it('local victim: vest clink, helmet tonk, per-piece breaks, bare hp thump; ducks ambience', () => {
    const { d, plays, cmds } = setup();
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, vest: hit(2), hpAfter: 85 }));
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, headshot: true, helmet: hit(3), hpAfter: 75 }));
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, vest: hit(2, true), hpAfter: 60 }));
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, headshot: true, helmet: hit(1, true), hpAfter: 40 }));
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, hpAfter: 30 }));
    expect(plays().map((p) => [p.cue, p.variant])).toEqual([
      ['damage.vest', 'vest2'],
      ['damage.helmet', 'helmet3'],
      ['damage.vestBreak', 'vest2'],
      ['damage.helmetBreak', 'helmet1'],
      ['damage.hp', 'body'],
    ]);
    expect(cmds.filter((c) => c.kind === 'duck' && c.bus === 'ambience')).toHaveLength(5);
  });

  it('a shotgun event that hits both pieces plays both; a grenade hits the vest only', () => {
    const { d, plays, take } = setup();
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, helmet: hit(1), vest: hit(1, true) }));
    expect(plays().map((p) => p.cue)).toEqual(['damage.helmet', 'damage.vestBreak']);
    take();
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, cause: 'explosion', attackerId: 3, vest: hit(3) }));
    expect(plays().map((p) => p.cue)).toEqual(['damage.vest']);
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
      d.localHitConfirmed({ victimId: 2, amount: 20, headshot: false, killed: false, vest: null, helmet: null, cause: 'weapon', ...o });

    d.playerDamaged(dmg({ isLocalAttacker: true, vest: hit(2) }));
    expect(plays()).toEqual([]); // no positional thwack for our own hits
    confirm({ vest: hit(2) });
    expect(plays().map((p) => [p.cue, p.variant])).toEqual([['hitConfirm.vest', 'vest2']]);
    take();

    confirm({ vest: hit(1, true) });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.vestBreak']);
    take();

    confirm({ headshot: true, helmet: hit(3) });
    expect(plays().map((p) => [p.cue, p.variant])).toEqual([['hitConfirm.helmet', 'helmet3']]);
    take();

    confirm({ headshot: true, helmet: hit(2, true) });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.helmetBreak']);
    take();

    confirm({ headshot: true });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.head']);
    take();

    confirm({});
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.body']);
    take();

    confirm({ cause: 'explosion', vest: hit(1) });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.vest']);
    take();

    confirm({ killed: true, headshot: true, helmet: hit(1, true) });
    expect(plays().map((p) => p.cue)).toEqual(['hitConfirm.kill', 'hitConfirm.head']);
  });

  it('remote-on-remote weapon hits play a positional thwack at the victim, armor in the variant', () => {
    const { d, plays } = setup();
    d.playerDamaged(dmg({}));
    d.playerDamaged(dmg({ headshot: true, helmet: hit(2) }));
    d.playerDamaged(dmg({ vest: hit(3, true) }));
    d.playerDamaged(dmg({ cause: 'explosion', vest: hit(1) })); // the blast already said it all
    d.playerDamaged(dmg({ cause: 'explosion', vest: hit(1, true) })); // ...except a break
    expect(plays().map((p) => [p.cue, p.variant, p.pos])).toEqual([
      ['hit.remote', 'body', P],
      ['hit.remote', 'helmet2', P],
      ['hit.remote', 'vestBreak', P],
      ['hit.remote', 'vestBreak', P],
    ]);
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
      placement: 5, isLocalVictim: true, isLocalKiller: false, weaponLevel: null,
    });
    expect(plays().map((p) => p.cue)).toEqual(['ui.defeat']);
    expect(cmds).toContainEqual({ kind: 'lowHealth', active: false });
    expect(cmds).toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.heal(1) });
    expect(cmds).not.toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.zone });
    expect(cmds.some((c) => c.kind === 'stopLoops')).toBe(false);
  });

  it('other eliminations play a positional bonk-splash', () => {
    const { d, plays } = setup();
    d.playerKilled({
      killerId: 1, killerName: 'A', victimId: 3, victimName: 'C', weapon: 'smg', cause: 'weapon', victimPos: P,
      placement: 4, isLocalVictim: false, isLocalKiller: true, weaponLevel: null,
    });
    expect(plays()).toEqual([expect.objectContaining({ cue: 'death.remote', pos: P, variant: 'body' })]);
  });

  it('headshot eliminations use the head variant of the remote death', () => {
    const { d, plays } = setup();
    d.playerKilled({
      killerId: 4, killerName: 'D', victimId: 3, victimName: 'C', weapon: 'rifle', cause: 'weapon', victimPos: P,
      placement: 4, headshot: true, isLocalVictim: false, isLocalKiller: false, weaponLevel: null,
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
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : c.kind))).toEqual(['zone.tideRising', 'zone.tideLoop', 'zoneBed']);
    d.zoneChanged({ zone: zone(false) });
    expect(cmds.at(-1)).toEqual({ kind: 'stop', loopKey: LOOP_KEY.zone });
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
      'zone.enterSurf', 'outside:true', 'zone.exitSurf', 'outside:false',
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

  it('spawning aboard plays nothing; a plain local landing is just the surface; tiny remote landings are silent', () => {
    const { d, cmds } = setup();
    d.localPlayerSpawned({ playerId: 1, pos: P });
    expect(cmds).toEqual([]);
    d.land({ playerId: 1, pos: P, fallSpeed: 10, surface: 'sand', isLocal: true });
    expect(cmds).toEqual([expect.objectContaining({ cue: 'land.local', variant: 'sand' })]);
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
    const none = { durability: null, refusal: null, level: null };
    d.interactPromptChanged({ lootId: 5, item: 'smg', qty: 1, ...none });
    d.interactPromptChanged({ lootId: 5, item: 'smg', qty: 1, ...none });
    d.interactPromptChanged({ lootId: null, item: null, qty: 0, ...none });
    d.interactPromptChanged({ lootId: 5, item: 'vest_2', qty: 1, durability: 40, refusal: 'betterArmor', level: null });
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

describe('AudioDirector: M2a arsenal', () => {
  it('sniper shots schedule a keyed bolt cycle of fireIntervalMs; other guns do not', () => {
    const { d, plays, cmds } = setup();
    d.shotFired({ shooterId: 4, weapon: 'sniper', origin: P, isLocal: false, impacts: [] });
    d.shotFired({ shooterId: 1, weapon: 'sniper', origin: P, isLocal: true, impacts: [] });
    d.shotFired({ shooterId: 5, weapon: 'dmr', origin: P, isLocal: false, impacts: [] });
    expect(plays().map((p) => [p.cue, p.pos])).toEqual([
      ['shot.sniper.remote', P],
      ['weapon.bolt', P],
      ['shot.sniper.local', null],
      ['weapon.bolt', null],
      ['shot.dmr.remote', P],
    ]);
    expect(plays()[1]).toMatchObject({ loopKey: LOOP_KEY.bolt(4), durationS: BALANCE.weapons.sniper.fireIntervalMs / 1000 });
    cmds.length = 0;
    d.reloadStarted({ playerId: 4, weapon: 'sniper', durationMs: 3500, pos: P, isLocal: false });
    expect(cmds[0]).toEqual({ kind: 'stop', loopKey: LOOP_KEY.bolt(4) });
  });

  it('bolt timing follows the injected balance', () => {
    const cmds: AudioCommand[] = [];
    const balance = { ...BALANCE, weapons: { ...BALANCE.weapons, sniper: { ...BALANCE.weapons.sniper, fireIntervalMs: 2000 } } };
    const d = new AudioDirector((c) => cmds.push(c), { balance });
    d.shotFired({ shooterId: 4, weapon: 'sniper', origin: P, isLocal: false, impacts: [] });
    expect(cmds[1]).toMatchObject({ cue: 'weapon.bolt', durationS: 2 });
  });

  it('ADS: in/out rustle for the local player, sight as variant', () => {
    const { d, plays } = setup();
    d.localAdsChanged({ engaged: true, weapon: 'sniper', sight: 'scope_8x' });
    d.localAdsChanged({ engaged: false, weapon: 'sniper', sight: 'scope_8x' });
    d.localAdsChanged({ engaged: true, weapon: 'rifle', sight: 'red_dot' });
    expect(plays().map((p) => [p.cue, p.variant, p.pos])).toEqual([
      ['ads.in', 'scope_8x', null],
      ['ads.out', 'scope_8x', null],
      ['ads.in', 'red_dot', null],
    ]);
  });

  it('stance: rustle (2D local, positional remote) with transition key and length; forced flag as intensity', () => {
    const { d, plays } = setup();
    d.stanceChanged({ playerId: 1, from: 'stand', to: 'prone', forced: false, durationMs: 600, pos: P, isLocal: true });
    d.stanceChanged({ playerId: 2, from: 'prone', to: 'stand', forced: true, durationMs: 700, pos: P, isLocal: false });
    expect(plays()).toEqual([
      expect.objectContaining({ cue: 'stance.change', pos: null, variant: 'stand_prone', durationS: 0.6, intensity: 0 }),
      expect.objectContaining({ cue: 'stance.change', pos: P, variant: 'prone_stand', durationS: 0.7, intensity: 1 }),
    ]);
  });

  it('footsteps follow the last stance: crouch quieter, prone crawl', () => {
    const { d, plays, take } = setup();
    const step = (playerId: number, isLocal: boolean): void =>
      d.footstep({ playerId, pos: P, surface: 'sand', sprinting: false, isLocal });
    d.stanceChanged({ playerId: 2, from: 'stand', to: 'crouch', forced: false, durationMs: 200, pos: P, isLocal: false });
    d.stanceChanged({ playerId: 3, from: 'stand', to: 'prone', forced: false, durationMs: 600, pos: P, isLocal: false });
    d.stanceChanged({ playerId: 1, from: 'stand', to: 'crouch', forced: false, durationMs: 200, pos: P, isLocal: true });
    take();
    step(2, false);
    step(3, false);
    step(1, true);
    step(9, false);
    expect(plays().map((p) => p.cue)).toEqual(['foot.crouch.remote', 'foot.crawl.remote', 'foot.local', 'foot.remote']);
    expect(plays()[2]?.gain).toBeLessThan(1);
    take();
    // Death clears the remembered stance.
    d.playerKilled({
      killerId: 1, killerName: 'A', victimId: 3, victimName: 'C', weapon: 'grenade', cause: 'explosion', victimPos: P,
      placement: 4, isLocalVictim: false, isLocalKiller: true, weaponLevel: null,
    });
    take();
    step(3, false);
    expect(plays().map((p) => p.cue)).toEqual(['foot.remote']);
  });

  it('grenade cook: local pin + keyed fuse tick (balance fuse), stopped on throw; remote pin is positional', () => {
    const { d, cmds, plays } = setup();
    d.grenadeCooked({ playerId: 1, pos: P, explodesAt: 9000, isLocal: true, kind: 'grenade' });
    expect(plays().map((p) => [p.cue, p.pos])).toEqual([['grenade.pin', null], ['grenade.tick', null]]);
    expect(plays()[1]?.loopKey).toBe(LOOP_KEY.cook);
    expect(plays()[1]?.durationS as number).toBeGreaterThanOrEqual(BALANCE.items.grenade.fuseMs / 1000);
    cmds.length = 0;
    d.grenadeThrown({ id: 1, ownerId: 1, pos: P, vel: P, explodesAt: 9000, dropped: false, isLocal: true, kind: 'grenade' });
    expect(cmds).toEqual([{ kind: 'stop', loopKey: LOOP_KEY.cook }, expect.objectContaining({ cue: 'grenade.throw', pos: null })]);
    cmds.length = 0;
    d.grenadeCooked({ playerId: 2, pos: P, explodesAt: 9000, isLocal: false, kind: 'grenade' });
    d.grenadeThrown({ id: 2, ownerId: 2, pos: P, vel: P, explodesAt: 9000, dropped: true, isLocal: false, kind: 'grenade' });
    expect(cmds).toEqual([expect.objectContaining({ cue: 'grenade.pin', pos: P })]); // a drop has no whoosh
  });

  it('cook tick stops on an in-hand blast and on local death', () => {
    const { d, cmds } = setup();
    d.grenadeCooked({ playerId: 1, pos: P, explodesAt: 9000, isLocal: true, kind: 'grenade' });
    cmds.length = 0;
    d.explosion({ id: 1, ownerId: 1, pos: P, radius: 6, inHand: true, isLocalOwner: true, localDistance: 0.5, source: 'grenade' });
    expect(cmds[0]).toEqual({ kind: 'stop', loopKey: LOOP_KEY.cook });
    cmds.length = 0;
    d.playerKilled({
      killerId: 1, killerName: 'A', victimId: 1, victimName: 'A', weapon: 'grenade', cause: 'explosion', victimPos: P,
      placement: 5, isLocalVictim: true, isLocalKiller: true, weaponLevel: null,
    });
    expect(cmds).toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.cook });
  });

  it('bounces: surface variant and speed intensity', () => {
    const { d, plays } = setup();
    d.grenadeBounced({ id: 3, pos: P, surface: 'prop', speed: 12, kind: 'grenade' });
    d.grenadeBounced({ id: 3, pos: P, surface: 'water', speed: 3, kind: 'grenade' });
    expect(plays().map((p) => [p.cue, p.variant, p.pos, p.intensity])).toEqual([
      ['grenade.bounce', 'prop', P, 1],
      ['grenade.bounce', 'water', P, 0.25],
    ]);
  });

  it('explosion: positional boom; water variant from the last contact or below sea level', () => {
    const { d, plays } = setup();
    const boom = (id: number, pos = P): void =>
      d.explosion({ id, ownerId: 2, pos, radius: 6, inHand: false, isLocalOwner: false, localDistance: 50, source: 'grenade' });
    d.grenadeBounced({ id: 7, pos: P, surface: 'water', speed: 5, kind: 'grenade' });
    boom(7);
    boom(8);
    boom(9, { x: 0, y: -0.4, z: 0 });
    boom(7); // contact forgotten after its blast
    expect(plays().filter((p) => p.cue === 'explosion').map((p) => p.variant)).toEqual(['water', 'ground', 'water', 'ground']);
    expect(plays()[0]?.pos).toBe(P);
  });

  it('explosion inside the radius: ear ring, sfx/ambience muffle and a deep ambience duck; near: light duck; far: none', () => {
    const { d, cmds } = setup();
    const boom = (localDistance: number | null): void =>
      d.explosion({ id: 1, ownerId: 2, pos: P, radius: 6, inHand: false, isLocalOwner: false, localDistance, source: 'grenade' });
    boom(1.5);
    const ring = cmds.find((c): c is PlayCommand => c.kind === 'play' && c.cue === 'explosion.ring');
    expect(ring?.intensity).toBeCloseTo(0.75, 6);
    const muffle = cmds.find((c) => c.kind === 'muffle');
    expect(muffle).toMatchObject({ kind: 'muffle' });
    expect(cmds).toContainEqual({ kind: 'duck', ...DUCKS.explosionClose });
    // Closer = darker and longer.
    cmds.length = 0;
    boom(0);
    const m0 = cmds.find((c) => c.kind === 'muffle') as Extract<AudioCommand, { kind: 'muffle' }>;
    const m1 = muffle as Extract<AudioCommand, { kind: 'muffle' }>;
    expect(m0.cutoffHz).toBeLessThan(m1.cutoffHz);
    expect(m0.holdS).toBeGreaterThan(m1.holdS);
    cmds.length = 0;
    boom(9);
    expect(cmds.map((c) => c.kind)).toEqual(['play', 'duck']);
    expect(cmds[1]).toEqual({ kind: 'duck', ...DUCKS.explosionNear });
    cmds.length = 0;
    boom(40);
    boom(null);
    expect(cmds.map((c) => c.kind)).toEqual(['play', 'play']);
  });

  it('armor pickups: velcro for vests, strap click for helmets; grenades clink', () => {
    const { d, plays } = setup();
    d.itemPickedUp({ playerId: 1, item: 'vest_3', qty: 1, pos: P, isLocal: true, durability: 100 });
    d.itemPickedUp({ playerId: 2, item: 'helmet_1', qty: 1, pos: P, isLocal: false, durability: 30 });
    d.itemPickedUp({ playerId: 1, item: 'grenade', qty: 2, pos: P, isLocal: true });
    expect(plays().map((p) => [p.cue, p.variant, p.pos])).toEqual([
      ['pickup.vest', 'vest_3', null],
      ['pickup.level', '3', null], // M2c: the local level sparkle (armor level = tier)
      ['pickup.helmet', 'helmet_1', P],
      ['pickup.grenade', 'grenade', null],
    ]);
  });
});

// --- M2b ------------------------------------------------------------------------------------------------------
const ROUTE = {
  mapId: 'office', entry: { x: -100, z: 0 }, exit: { x: 100, z: 0 }, eject: { x: 80, z: 0 }, altitude: 25, speed: 10,
  startsAt: 1000, noJumpUntil: 2500, ejectAt: 19000, endsAt: 21000,
};

/** Minimal map stand-ins: the director reads only `kind` and `carrier`. */
const mapEvent = (kind: 'island' | 'indoor', zoneTheme: GameEvents['mapChanged']['zoneTheme'], balance = BALANCE): GameEvents['mapChanged'] => ({
  mapId: kind === 'indoor' ? 'office' : 'island01',
  map: { kind, carrier: kind === 'indoor' ? 'drone' : 'seaplane' } as unknown as GameEvents['mapChanged']['map'],
  balance,
  zoneTheme,
  layout: null,
  look: kind === 'indoor' ? 'day' : 'noon',
});

/** Footstep with an indoor floor material (typed wide until the C-gate adds FloorMaterial to the event). */
const indoorStep = (o: Omit<GameEvents['footstep'], 'surface'> & { surface: string }): GameEvents['footstep'] =>
  o as unknown as GameEvents['footstep'];

describe('AudioDirector: M2b maps, zone themes and per-map balance', () => {
  it('mapChanged switches the scene and theme, resets the match, and adopts the per-map balance (no BALANCE fallback)', () => {
    const cmds: AudioCommand[] = [];
    const d = new AudioDirector((c) => cmds.push(c)); // no balance injected
    d.shotFired({ shooterId: 4, weapon: 'sniper', origin: P, isLocal: false, impacts: [] });
    d.grenadeCooked({ playerId: 1, pos: P, explodesAt: 9000, isLocal: true, kind: 'grenade' });
    expect(cmds.filter((c) => c.kind === 'play').map((c) => (c as PlayCommand).cue)).toEqual(['shot.sniper.remote', 'grenade.pin']);
    expect(d.fuseMs).toBeNull();

    cmds.length = 0;
    const office = {
      ...BALANCE,
      weapons: { ...BALANCE.weapons, sniper: { ...BALANCE.weapons.sniper, fireIntervalMs: 1700 } },
      items: { ...BALANCE.items, grenade: { ...BALANCE.items.grenade, fuseMs: 4100 } },
    };
    d.mapChanged(mapEvent('indoor', 'sprinklers', office));
    expect(cmds).toContainEqual({ kind: 'stopLoops' });
    expect(cmds.at(-1)).toEqual({ kind: 'map', scene: 'indoor', theme: 'sprinklers', look: 'day' });
    expect(d.zoneTheme).toBe('sprinklers');
    expect(d.fuseMs).toBe(4100);
    cmds.length = 0;
    d.shotFired({ shooterId: 4, weapon: 'sniper', origin: P, isLocal: false, impacts: [] });
    d.grenadeCooked({ playerId: 1, pos: P, explodesAt: 9000, isLocal: true, kind: 'grenade' });
    const plays = cmds.filter((c): c is PlayCommand => c.kind === 'play');
    expect(plays[1]).toMatchObject({ cue: 'weapon.bolt', durationS: 1.7 });
    expect(plays[3]).toMatchObject({ cue: 'grenade.tick', durationS: 4.1 + AUDIO_TUNING.cookTickSafetyS });
  });

  it('sprinklers: pipe start + rain loop + rain bed on the first shrink; spray in and out; PA warning chime', () => {
    const { d, cmds, take } = setup();
    d.mapChanged(mapEvent('indoor', 'sprinklers'));
    take();
    d.zoneChanged({ zone: zone(true) });
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : c.kind))).toEqual(['zone.sprinklerStart', 'zone.sprinklerLoop', 'zoneBed']);
    expect(cmds[1]).toMatchObject({ loopKey: LOOP_KEY.zone });
    take();
    d.zoneChanged({ zone: zone(false) });
    d.zoneChanged({ zone: zone(true) }); // second phase: the bed is already on
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : c.kind))).toEqual(['stop', 'zone.sprinklerStart', 'zone.sprinklerLoop']);
    take();
    d.localZoneStatusChanged({ outside: true });
    d.localZoneStatusChanged({ outside: false });
    expect(cmds.map((c) => (c.kind === 'play' ? c.cue : `${c.kind}:${'active' in c ? c.active : ''}`))).toEqual([
      'zone.enterSpray', 'outside:true', 'zone.exitSpray', 'outside:false',
    ]);
    take();
    d.zoneWarning({ phaseIndex: 0, secondsUntilShrink: 10 });
    expect(cmds[0]).toMatchObject({ cue: 'zone.warning', variant: 'sprinklers' });
  });

  it('a new map resets the zone bed; lightsOut has a sting but no loop', () => {
    const { d, cmds, take } = setup();
    d.mapChanged(mapEvent('indoor', 'sprinklers'));
    d.zoneChanged({ zone: zone(true) });
    take();
    d.mapChanged(mapEvent('indoor', 'lightsOut'));
    expect(cmds).toContainEqual({ kind: 'zoneBed', active: false });
    expect(cmds).toContainEqual({ kind: 'stop', loopKey: LOOP_KEY.zone });
    take();
    d.zoneChanged({ zone: zone(true) });
    expect(cmds.filter((c) => c.kind === 'play')).toEqual([expect.objectContaining({ cue: 'zone.lights', variant: 'down' })]);
    take();
    d.localZoneStatusChanged({ outside: true });
    expect(cmds[0]).toMatchObject({ cue: 'zone.lights', variant: 'enter' });
  });

  it('the island stays on the tide', () => {
    const { d, cmds, take } = setup();
    d.mapChanged(mapEvent('island', 'tide'));
    expect(cmds.at(-1)).toEqual({ kind: 'map', scene: 'island', theme: 'tide', look: 'noon' });
    take();
    d.zoneChanged({ zone: zone(true) });
    expect(cmds.filter((c) => c.kind === 'play').map((c) => (c as PlayCommand).cue)).toEqual(['zone.tideRising', 'zone.tideLoop']);
  });
});

describe('AudioDirector: M2b glass, indoor floors and footstep.stance', () => {
  it('glass impacts get their own cue next to the other surfaces', () => {
    const { d, plays } = setup();
    const glass = { point: P, surface: 'glass', playerId: null, headshot: false } as unknown as GameEvents['shotFired']['impacts'][number];
    d.shotFired({ shooterId: 1, weapon: 'rifle', origin: P, isLocal: false, impacts: [glass] });
    expect(plays().map((p) => p.cue)).toEqual(['shot.rifle.remote', 'impact.glass']);
  });

  it('footstep.stance wins over the stanceChanged history (REVIEW-M2a M4); history is only the fallback', () => {
    const { d, plays, take } = setup();
    d.stanceChanged({ playerId: 2, from: 'stand', to: 'crouch', forced: false, durationMs: 200, pos: P, isLocal: false });
    take();
    d.footstep({ playerId: 2, pos: P, surface: 'sand', sprinting: false, isLocal: false, stance: 'prone' });
    d.footstep({ playerId: 5, pos: P, surface: 'sand', sprinting: false, isLocal: false, stance: 'crouch' }); // never sent stanceChanged
    d.footstep({ playerId: 2, pos: P, surface: 'sand', sprinting: false, isLocal: false }); // no stance: history
    expect(plays().map((p) => p.cue)).toEqual(['foot.crawl.remote', 'foot.crouch.remote', 'foot.crouch.remote']);
  });

  it('indoor floor materials pass through as the step variant', () => {
    const { d, plays } = setup();
    for (const surface of ['wood', 'carpet', 'tile']) {
      d.footstep(indoorStep({ playerId: 2, pos: P, surface, sprinting: false, isLocal: false, stance: 'stand' }));
    }
    expect(plays().map((p) => p.variant)).toEqual(['wood', 'carpet', 'tile']);
  });
});

describe('AudioDirector: M2b carrier drop', () => {
  it('jump whoosh and chute pop: big 2D for the local player, positional for others', () => {
    const { d, plays } = setup();
    d.carrierDeparted({ route: ROUTE });
    d.localPlayerSpawned({ playerId: 1, pos: P });
    d.playerJumped({ playerId: 1, pos: P, auto: false, isLocal: true });
    d.playerJumped({ playerId: 2, pos: P, auto: true, isLocal: false });
    d.parachuteOpened({ playerId: 1, pos: P, manual: true, isLocal: true });
    d.parachuteOpened({ playerId: 2, pos: P, manual: false, isLocal: false });
    expect(plays().map((p) => [p.cue, p.pos, p.intensity])).toEqual([
      ['drop.jump', null, 1],
      ['drop.jump', P, 0],
      ['drop.chutePop', null, 1],
      ['drop.chutePop', P, 0],
    ]);
    expect(d.drop.localPhase).toBe('chute');
    expect(d.drop.activeRoute).toBe(ROUTE);
  });

  it('a landing that ends a drop adds the canopy fold (local 2D, remote at the landing)', () => {
    const { d, plays, take } = setup();
    d.localPlayerSpawned({ playerId: 1, pos: P });
    d.playerJumped({ playerId: 1, pos: P, auto: false, isLocal: true });
    d.parachuteOpened({ playerId: 1, pos: P, manual: false, isLocal: true });
    d.parachuteOpened({ playerId: 2, pos: P, manual: false, isLocal: false });
    take();
    d.land({ playerId: 1, pos: P, surface: 'carpet', isLocal: true, fallSpeed: 8 } as unknown as GameEvents['land']); // indoor floor
    d.land({ playerId: 2, pos: P, fallSpeed: 8, surface: 'sand', isLocal: false });
    d.land({ playerId: 1, pos: P, fallSpeed: 5, surface: 'sand', isLocal: true }); // ordinary jump landing later
    expect(plays().map((p) => [p.cue, p.pos, p.variant])).toEqual([
      ['land.local', null, 'carpet'],
      ['drop.land', null, 'carpet'],
      ['drop.land', P, 'sand'],
      ['land.remote', P, 'sand'],
      ['land.local', null, 'sand'],
    ]);
  });

  it('local death and match reset end the drop state', () => {
    const { d } = setup();
    d.carrierDeparted({ route: ROUTE });
    d.localPlayerSpawned({ playerId: 1, pos: P });
    d.playerKilled({
      killerId: null, killerName: null, victimId: 1, victimName: 'A', weapon: null, cause: 'zone', victimPos: P,
      placement: 5, isLocalVictim: true, isLocalKiller: false, weaponLevel: null,
    });
    expect(d.drop.localPhase).toBe('none');
    d.matchPhaseChanged({ phase: 'results', prev: 'playing', endsAt: null });
    expect(d.drop.activeRoute).toBeNull();
  });
});

describe('AudioDirector: M2b heartbeat threshold from the per-map balance', () => {
  it('mapChanged.balance player.lowHpThreshold moves the heartbeat threshold', () => {
    const cmds: AudioCommand[] = [];
    const d = new AudioDirector((c) => cmds.push(c), { lowHealthHp: 30 });
    d.mapChanged(mapEvent('indoor', 'sprinklers', { ...BALANCE, player: { ...BALANCE.player, lowHpThreshold: 45 } }));
    cmds.length = 0;
    d.playerDamaged(dmg({ victimId: 1, isLocalVictim: true, hpAfter: 40 }));
    expect(cmds).toContainEqual({ kind: 'lowHealth', active: true });
  });
});
