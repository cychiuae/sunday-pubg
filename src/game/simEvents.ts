/**
 * SimEvent (server) -> GameEvents (client bus), ARCHITECTURE §7 table. Pure apart from the emit.
 * Positions the server does not send (reload, heal, victims) come from the player's current view position.
 */
import type { GameEvents } from '../shared/events';
import type { PlayerId, SimEvent, Vec3 } from '../shared/types';
import type { Bus } from './derived';

export interface TranslateContext {
  localId: PlayerId | null;
  /** Display name from the latest snapshot, or null if unknown. */
  nameOf(id: PlayerId): string | null;
  /** Current view position (predicted for local, interpolated for remotes). Returns a fresh object. */
  posOf(id: PlayerId): Vec3;
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

/** Emits the bus event(s) for one SimEvent. */
export function translateSimEvent(ev: SimEvent, ctx: TranslateContext, bus: Bus): void {
  const isLocal = (id: PlayerId | null): boolean => id !== null && id === ctx.localId;
  switch (ev.type) {
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
        armorAfter: ev.armorAfter,
        ...(ev.armorBefore !== undefined ? { armorBefore: ev.armorBefore } : {}),
        isLocalVictim: isLocal(ev.victimId),
        isLocalAttacker,
      });
      if (isLocalAttacker && !isLocal(ev.victimId)) {
        bus.emit('localHitConfirmed', {
          victimId: ev.victimId,
          amount: ev.amount,
          headshot: ev.headshot,
          killed: ev.hpAfter <= 0,
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
    case 'actionFailed':
      // M1: only the local player's refusals reach the bus (toast + refusal cue). A refused fire press is already
      // covered by the client-side dryFire, so it is not forwarded.
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
