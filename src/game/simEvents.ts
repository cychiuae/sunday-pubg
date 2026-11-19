/**
 * SimEvent (server) -> GameEvents (client bus), ARCHITECTURE §7 table. Pure apart from the emit.
 * Positions the server does not send (reload, heal, victims) come from the player's current view position.
 * M2a: the local player's stanceChanged comes from prediction (ClientGame), so the server echo for the local id is
 * dropped here. localAdsChanged is client-derived too (ClientGame).
 * M2b: dropJump -> playerJumped, chuteOpen -> parachuteOpened. The local player's ones come from prediction; the
 * server echo is dropped when `skipLocalDrop` says prediction already emitted it (an auto-eject or a jump the client did
 * not predict still reaches the bus from the server).
 * M2c (gate prep): `kind`/`source` default to the frag, kill `weaponLevel` defaults to L1 for guns; the seven M2c sim
 * events translate 1:1 (meleeSwing: remotes only, the local swing comes from prediction).
 */
import type { GameEvents } from '../shared/events';
import type { DropSimEvent, ItemLevel, M2cHeldId, M2cSimEvent, PlayerId, SimEvent, Vec3 } from '../shared/types';
import { isM2cGunId, isMeleeId } from '../shared/types';
import type { Bus } from './derived';

export interface TranslateContext {
  localId: PlayerId | null;
  /** Display name from the latest snapshot, or null if unknown. */
  nameOf(id: PlayerId): string | null;
  /** Current view position (predicted for local, interpolated for remotes). Returns a fresh object. */
  posOf(id: PlayerId): Vec3;
  /**
   * M2a: the local player's predicted eye position, or null with no live local player (explosion.localDistance).
   * Absent = null.
   */
  localEye?: () => Vec3 | null;
  /** M2b: true when prediction already emitted this local drop moment (its server echo is then dropped). Absent = false. */
  skipLocalDrop?: (type: DropSimEvent['type']) => boolean;
  /** M2c: estimated server clock now (meleeSwing.windupMs). Absent = the swing's hitAt is treated as now. */
  serverNow?: () => number;
  /**
   * M2c (smoke.md, UI M2c §6.2): the local camera's line to this victim's chest crosses an opaque smoke cloud now
   * (segmentBlockedBySmoke). Fills localHitConfirmed.obscured. Absent = false.
   */
  obscured?: (victimId: PlayerId) => boolean;
  /** M2c: source of a blast entity id (`explosion.source`, one id space), null if unknown. Absent = unknown. */
  blastSource?: (blastId: number) => 'grenade' | 'rocket' | null;
  /** M2c: source of the last blast that damaged this victim (kill weapon 'rpg' for rocket blasts). Absent = unknown. */
  lastBlastOf?: (victimId: PlayerId) => 'grenade' | 'rocket' | null;
}

/**
 * M2c: the weapon of a damage event when the server did not say (ADR 0007 §8): 'rpg' for rocket impacts and rocket
 * blasts, 'grenade' for frag blasts; undefined when it cannot be derived (guns, melee, zone, fall: the sim sends it).
 */
export function damageWeaponOf(ev: Extract<SimEvent, { type: 'damage' }>, ctx: TranslateContext): M2cHeldId | null | undefined {
  if (ev.weapon !== undefined) return ev.weapon;
  if (ev.cause === 'rocket') return 'rpg';
  if (ev.cause === 'explosion') {
    const src = ev.grenadeId !== undefined ? (ctx.blastSource?.(ev.grenadeId) ?? null) : null;
    return src === 'rocket' ? 'rpg' : 'grenade';
  }
  if (ev.cause === 'zone' || ev.cause === 'fall') return null;
  return undefined;
}

/** M2c: kill weapon: 'rpg' for rocket impact kills and rocket blast kills (rpg.md: both carry weapon rpg). */
export function killWeaponOf(ev: Extract<SimEvent, { type: 'kill' }>, ctx: TranslateContext): M2cHeldId | null {
  if (ev.cause === 'rocket' && ev.weapon === null) return 'rpg';
  if (ev.cause === 'explosion' && (ev.weapon === null || ev.weapon === 'grenade') && ctx.lastBlastOf?.(ev.victimId) === 'rocket') return 'rpg';
  return ev.weapon;
}

const isLeveled = (item: unknown): boolean => isM2cGunId(item) || isMeleeId(item);

/** M2c: level of a weapon when the event does not say: L1 for guns and melee (absent level = L1), else null. */
export function defaultWeaponLevel(weapon: M2cHeldId | null | undefined): ItemLevel | null {
  return weapon !== null && weapon !== undefined && (isM2cGunId(weapon) || isMeleeId(weapon)) ? 1 : null;
}

export function buildMatchEnded(
  ev: Extract<SimEvent, { type: 'matchEnded' }>,
  ctx: TranslateContext,
): GameEvents['matchEnded'] {
  const standings = [...ev.standings].sort((a, b) => a.placement - b.placement);
  const mine = ctx.localId === null ? undefined : standings.find((s) => s.id === ctx.localId);
  const winner = ev.winnerId === null ? undefined : standings.find((s) => s.id === ev.winnerId);
  return {
    winnerId: ev.winnerId,
    winnerName: winner?.name ?? (ev.winnerId === null ? null : ctx.nameOf(ev.winnerId)),
    localPlacement: mine ? mine.placement : null,
    localKills: mine ? mine.kills : 0,
    totalPlayers: standings.length,
    isLocalWinner: ctx.localId !== null && ev.winnerId === ctx.localId,
    standings,
  };
}

/** Emits the bus event(s) for one SimEvent (M2b: DropSimEvent, M2c: M2cSimEvent join SimEvent at the C-gate). */
export function translateSimEvent(ev: SimEvent | DropSimEvent | M2cSimEvent, ctx: TranslateContext, bus: Bus): void {
  const isLocal = (id: PlayerId | null): boolean => id !== null && id === ctx.localId;
  switch (ev.type) {
    case 'dropJump':
      if (isLocal(ev.playerId) && ctx.skipLocalDrop?.('dropJump')) return;
      bus.emit('playerJumped', { playerId: ev.playerId, pos: { ...ev.pos }, auto: ev.auto, isLocal: isLocal(ev.playerId) });
      return;
    case 'chuteOpen':
      if (isLocal(ev.playerId) && ctx.skipLocalDrop?.('chuteOpen')) return;
      bus.emit('parachuteOpened', { playerId: ev.playerId, pos: { ...ev.pos }, manual: ev.manual, isLocal: isLocal(ev.playerId) });
      return;
    case 'spawn':
      if (isLocal(ev.playerId)) bus.emit('localPlayerSpawned', { playerId: ev.playerId, pos: { ...ev.pos } });
      return;
    case 'shot':
      bus.emit('shotFired', {
        shooterId: ev.shooterId,
        weapon: ev.weapon,
        origin: ev.origin,
        impacts: ev.impacts,
        isLocal: isLocal(ev.shooterId),
      });
      return;
    case 'damage': {
      const isLocalAttacker = isLocal(ev.attackerId);
      const weapon = damageWeaponOf(ev, ctx);
      const level = ev.weaponLevel !== undefined ? ev.weaponLevel : weapon !== undefined ? defaultWeaponLevel(weapon) : undefined;
      const weaponFields = {
        ...(weapon !== undefined ? { weapon } : {}),
        ...(level !== undefined ? { weaponLevel: level } : {}),
      };
      bus.emit('playerDamaged', {
        victimId: ev.victimId,
        attackerId: ev.attackerId,
        amount: ev.amount,
        headshot: ev.headshot,
        cause: ev.cause,
        sourcePos: ev.sourcePos,
        victimPos: ctx.posOf(ev.victimId),
        hpAfter: ev.hpAfter,
        vest: ev.vest,
        helmet: ev.helmet,
        isLocalVictim: isLocal(ev.victimId),
        isLocalAttacker,
        ...weaponFields,
      });
      if (isLocalAttacker && !isLocal(ev.victimId)) {
        bus.emit('localHitConfirmed', {
          victimId: ev.victimId,
          amount: ev.amount,
          headshot: ev.headshot,
          killed: ev.hpAfter <= 0,
          vest: ev.vest,
          helmet: ev.helmet,
          cause: ev.cause,
          ...weaponFields,
          obscured: ctx.obscured?.(ev.victimId) ?? false,
        });
      }
      return;
    }
    case 'kill': {
      const weapon = killWeaponOf(ev, ctx);
      bus.emit('playerKilled', {
        killerId: ev.killerId,
        killerName: ev.killerId === null ? null : ctx.nameOf(ev.killerId),
        victimId: ev.victimId,
        victimName: ctx.nameOf(ev.victimId) ?? '',
        weapon,
        cause: ev.cause,
        victimPos: ctx.posOf(ev.victimId),
        placement: ev.placement,
        ...(ev.headshot !== undefined ? { headshot: ev.headshot } : {}),
        isLocalVictim: isLocal(ev.victimId),
        isLocalKiller: isLocal(ev.killerId),
        weaponLevel: ev.weaponLevel !== undefined ? ev.weaponLevel : defaultWeaponLevel(weapon),
        ...(ev.direct !== undefined ? { direct: ev.direct } : {}),
      });
      return;
    }
    case 'pickup': {
      // M2c: weapons carry a level (absent = L1, levels.md); other items have none.
      const level = ev.level !== undefined ? ev.level : (defaultWeaponLevel(isLeveled(ev.item) ? (ev.item as M2cHeldId) : null) ?? undefined);
      bus.emit('itemPickedUp', {
        playerId: ev.playerId,
        item: ev.item,
        qty: ev.qty,
        pos: ev.pos,
        isLocal: isLocal(ev.playerId),
        ...(ev.durability !== undefined ? { durability: ev.durability } : {}),
        ...(level !== undefined ? { level } : {}),
        ...(ev.scope !== undefined ? { scope: ev.scope } : {}),
      });
      return;
    }
    case 'reloadStart':
      bus.emit('reloadStarted', {
        playerId: ev.playerId,
        weapon: ev.weapon,
        durationMs: ev.durationMs,
        pos: ctx.posOf(ev.playerId),
        isLocal: isLocal(ev.playerId),
        ...(ev.rounds !== undefined ? { rounds: ev.rounds } : {}),
      });
      return;
    case 'reloadEnd':
      bus.emit('reloadFinished', {
        playerId: ev.playerId,
        weapon: ev.weapon,
        completed: ev.completed,
        pos: ctx.posOf(ev.playerId),
        isLocal: isLocal(ev.playerId),
      });
      return;
    case 'healStart':
      bus.emit('healStarted', {
        playerId: ev.playerId,
        item: ev.item,
        durationMs: ev.durationMs,
        pos: ctx.posOf(ev.playerId),
        isLocal: isLocal(ev.playerId),
      });
      return;
    case 'healEnd':
      if (ev.completed) {
        bus.emit('healFinished', {
          playerId: ev.playerId,
          item: ev.item,
          hpAfter: ev.hpAfter,
          pos: ctx.posOf(ev.playerId),
          isLocal: isLocal(ev.playerId),
        });
      } else {
        bus.emit('healCancelled', {
          playerId: ev.playerId,
          item: ev.item,
          pos: ctx.posOf(ev.playerId),
          isLocal: isLocal(ev.playerId),
        });
      }
      return;
    case 'weaponSwitch':
      bus.emit('weaponSwitched', {
        playerId: ev.playerId,
        weapon: ev.weapon,
        slot: ev.slot,
        isLocal: isLocal(ev.playerId),
        pos: ctx.posOf(ev.playerId),
        level: ev.level !== undefined ? ev.level : defaultWeaponLevel(ev.weapon),
      });
      return;
    case 'stanceChange':
      // The local player's transitions are emitted from prediction on the step they start.
      if (isLocal(ev.playerId)) return;
      bus.emit('stanceChanged', {
        playerId: ev.playerId,
        from: ev.from,
        to: ev.to,
        forced: ev.forced,
        durationMs: ev.durationMs,
        pos: ctx.posOf(ev.playerId),
        isLocal: false,
      });
      return;
    case 'grenadeCook':
      bus.emit('grenadeCooked', {
        playerId: ev.playerId,
        pos: { ...ev.pos },
        explodesAt: ev.explodesAt,
        isLocal: isLocal(ev.playerId),
        kind: ev.kind ?? 'grenade',
      });
      return;
    case 'grenadeThrown':
      bus.emit('grenadeThrown', {
        id: ev.id,
        ownerId: ev.ownerId,
        pos: { ...ev.pos },
        vel: { ...ev.vel },
        explodesAt: ev.explodesAt,
        dropped: ev.dropped,
        isLocal: isLocal(ev.ownerId),
        kind: ev.kind ?? 'grenade',
      });
      return;
    case 'grenadeBounce':
      bus.emit('grenadeBounced', { id: ev.id, pos: { ...ev.pos }, surface: ev.surface, speed: ev.speed, kind: ev.kind ?? 'grenade' });
      return;
    case 'explosion': {
      const eye = ctx.localEye?.() ?? null;
      bus.emit('explosion', {
        id: ev.id,
        ownerId: ev.ownerId,
        pos: { ...ev.pos },
        radius: ev.radius,
        inHand: ev.inHand,
        isLocalOwner: isLocal(ev.ownerId),
        localDistance: eye ? Math.hypot(ev.pos.x - eye.x, ev.pos.y - eye.y, ev.pos.z - eye.z) : null,
        source: ev.source,
        ...(ev.direct !== undefined ? { direct: ev.direct } : {}),
        ...(ev.airburst !== undefined ? { airburst: ev.airburst } : {}),
      });
      return;
    }
    case 'actionFailed':
      // Only the local player's refusals reach the bus (toast + refusal cue). A refused fire press is already
      // covered by the client-side dryFire, so it is not forwarded. M2a: 'swap' (noGrenades) and 'stance'
      // (tooDeep, noHeadroom) are forwarded like the M1 actions.
      if (isLocal(ev.playerId) && ev.action !== 'fire') {
        bus.emit('actionFailed', { playerId: ev.playerId, action: ev.action, reason: ev.reason, isLocal: true });
      }
      return;
    case 'matchEnded':
      bus.emit('matchEnded', buildMatchEnded(ev, ctx));
      return;
    // ---- M2c (ADR 0007 §8) ----
    case 'meleeSwing': {
      // The local swing is emitted from prediction on the click; the server echo is dropped.
      if (isLocal(ev.playerId)) return;
      const now = ctx.serverNow?.() ?? ev.hitAt;
      bus.emit('meleeSwing', {
        playerId: ev.playerId,
        weapon: ev.weapon,
        level: ev.level,
        pos: { ...ev.pos },
        windupMs: Math.max(0, ev.hitAt - now),
        cycleMs: ev.cycleMs,
        isLocal: false,
      });
      return;
    }
    case 'meleeHit':
      bus.emit('meleeHit', {
        attackerId: ev.attackerId,
        weapon: ev.weapon,
        level: ev.level,
        pos: { ...ev.pos },
        surface: ev.surface,
        victimId: ev.victimId,
        headshot: ev.headshot,
        knockback: ev.knockback,
        isLocalAttacker: isLocal(ev.attackerId),
        isLocalVictim: isLocal(ev.victimId),
      });
      return;
    case 'rocketFired':
      bus.emit('rocketFired', {
        id: ev.id,
        ownerId: ev.ownerId,
        level: ev.level,
        pos: { ...ev.pos },
        vel: { ...ev.vel },
        firedAt: ev.firedAt,
        isLocal: isLocal(ev.ownerId),
      });
      return;
    case 'rocketDud':
      bus.emit('rocketDud', {
        id: ev.id,
        ownerId: ev.ownerId,
        pos: { ...ev.pos },
        surface: ev.surface,
        victimId: ev.victimId,
        isLocalOwner: isLocal(ev.ownerId),
      });
      return;
    case 'smokeDeployed':
      bus.emit('smokeDeployed', {
        id: ev.id,
        ownerId: ev.ownerId,
        pos: { ...ev.pos },
        deployedAt: ev.deployedAt,
        fadeAt: ev.fadeAt,
        isLocalOwner: isLocal(ev.ownerId),
      });
      return;
    case 'glassBroken':
      bus.emit('glassBroken', { paneId: ev.paneId, pos: { ...ev.pos }, byId: ev.byId, cause: ev.cause, isLocal: isLocal(ev.byId) });
      return;
    case 'scopeChanged':
      bus.emit('scopeChanged', {
        playerId: ev.playerId,
        slot: ev.slot,
        gun: ev.gun,
        from: ev.from,
        to: ev.to,
        auto: ev.auto,
        pos: { ...ev.pos },
        isLocal: isLocal(ev.playerId),
      });
      return;
    default: {
      const unknown: never = ev;
      console.warn('[ClientGame] unknown sim event', unknown);
    }
  }
}
