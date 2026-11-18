/**
 * SimEvent (server) -> GameEvents (client bus), ARCHITECTURE §7 table. Pure apart from the emit.
 * Positions the server does not send (reload, heal, victims) come from the player's current view position.
 * M2a: the local player's stanceChanged comes from prediction (ClientGame), so the server echo for the local id is
 * dropped here. localAdsChanged is client-derived too (ClientGame).
 * M2b: dropJump -> playerJumped, chuteOpen -> parachuteOpened. The local player's ones come from prediction; the
 * server echo is dropped when `skipLocalDrop` says prediction already emitted it (an auto-eject or a jump the client did
 * not predict still reaches the bus from the server).
 */
import type { GameEvents } from '../shared/events';
import type { DropSimEvent, PlayerId, SimEvent, Vec3 } from '../shared/types';
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

/** Emits the bus event(s) for one SimEvent (M2b: DropSimEvent joins SimEvent at the C-gate). */
export function translateSimEvent(ev: SimEvent | DropSimEvent, ctx: TranslateContext, bus: Bus): void {
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
        });
      }
      return;
    }
    case 'kill':
      bus.emit('playerKilled', {
        killerId: ev.killerId,
        killerName: ev.killerId === null ? null : ctx.nameOf(ev.killerId),
        victimId: ev.victimId,
        victimName: ctx.nameOf(ev.victimId) ?? '',
        weapon: ev.weapon,
        cause: ev.cause,
        victimPos: ctx.posOf(ev.victimId),
        placement: ev.placement,
        ...(ev.headshot !== undefined ? { headshot: ev.headshot } : {}),
        isLocalVictim: isLocal(ev.victimId),
        isLocalKiller: isLocal(ev.killerId),
      });
      return;
    case 'pickup':
      bus.emit('itemPickedUp', {
        playerId: ev.playerId,
        item: ev.item,
        qty: ev.qty,
        pos: ev.pos,
        isLocal: isLocal(ev.playerId),
        ...(ev.durability !== undefined ? { durability: ev.durability } : {}),
      });
      return;
    case 'reloadStart':
      bus.emit('reloadStarted', {
        playerId: ev.playerId,
        weapon: ev.weapon,
        durationMs: ev.durationMs,
        pos: ctx.posOf(ev.playerId),
        isLocal: isLocal(ev.playerId),
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
      });
      return;
    case 'grenadeBounce':
      bus.emit('grenadeBounced', { id: ev.id, pos: { ...ev.pos }, surface: ev.surface, speed: ev.speed });
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
    default: {
      const unknown: never = ev;
      console.warn('[ClientGame] unknown sim event', unknown);
    }
  }
}
