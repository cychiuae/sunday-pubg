/**
 * Builds the per-frame HudView (contracts.ts) from the latest snapshot plus client-side state. Pure.
 * HP/armor stay floats (the UI shows ceil, combat.md). Timers and progress bars are extrapolated to `now`
 * so they tick smoothly between 20 Hz snapshots.
 */
import type { Balance } from '../shared/balance';
import type { HudLocalView, HudSlotView, HudView, HudZoneView } from '../shared/contracts';
import { clamp } from '../shared/math';
import type {
  ConnectionStatus,
  LocalPlayerState,
  MapData,
  PlayerId,
  PlayerState,
  Vec3,
  WorldSnapshot,
  ZoneState,
} from '../shared/types';
import { FISTS_SLOT } from '../shared/types';
import { secondsUntil } from './zoneView';

export interface LocalPose {
  pos: Vec3;
  yaw: number;
  dropping: boolean;
}

export interface HudBuildInput {
  balance: Balance;
  map: MapData;
  connection: ConnectionStatus;
  joined: boolean;
  snapshot: WorldSnapshot | null;
  /** Estimated server clock now (ms). */
  now: number;
  localId: PlayerId | null;
  /** Name the player joined with (fallback before the snapshot has it). */
  localName: string;
  /** Rendered local pose (predicted while alive, interpolated when dead); null if not a participant. */
  localPose: LocalPose | null;
  /** Display zone (already extrapolated to `now`). */
  zone: ZoneState | null;
  outsideZone: boolean;
  /** Current spectate target (interpolated view state), or null when not spectating. */
  spectateTarget: PlayerState | null;
  pointerLocked: boolean;
  crosshairSpreadDeg: number;
  /** Vertical FOV of this frame's camera (FrameView.camera.fovDeg). */
  cameraFovDeg: number;
}

/** 0..1 progress of a timer with `remainingMs` left at `snapshotTime`, extrapolated to `now`; null if idle. */
export function timerProgress(remainingMs: number, totalMs: number, snapshotTime: number, now: number): number | null {
  if (remainingMs <= 0 || totalMs <= 0) return null;
  const left = Math.max(0, remainingMs - Math.max(0, now - snapshotTime));
  return clamp(1 - left / totalMs, 0, 1);
}

export function buildSlots(local: LocalPlayerState): [HudSlotView, HudSlotView, HudSlotView] {
  const slot = (i: 0 | 1): HudSlotView => {
    const s = local.slots[i];
    return { slot: i, weapon: s ? s.weapon : null, mag: s ? s.mag : null };
  };
  return [slot(0), slot(1), { slot: FISTS_SLOT, weapon: 'fists', mag: null }];
}

export function buildLocalView(
  local: LocalPlayerState,
  player: PlayerState | undefined,
  input: Pick<HudBuildInput, 'balance' | 'localName' | 'localPose' | 'outsideZone' | 'now'>,
  snapshotTime: number,
): HudLocalView {
  const { balance } = input;
  const weapon = player?.weapon ?? 'fists';
  const active = local.activeSlot;
  const activeGun = active === 2 ? null : local.slots[active];
  const wb = balance.weapons[weapon];
  const isGun = weapon !== 'fists' && wb.ammo !== null;
  const ammoType = isGun ? wb.ammo : null;
  return {
    id: local.id,
    name: player?.name ?? input.localName,
    alive: player?.alive ?? false,
    hp: player?.hp ?? 0,
    maxHp: balance.player.maxHp,
    armor: player?.armor ?? 0,
    maxArmor: balance.player.maxArmor,
    kills: player?.kills ?? 0,
    pos: input.localPose ? { ...input.localPose.pos } : { ...local.movement.pos },
    yaw: input.localPose?.yaw ?? player?.yaw ?? 0,
    slots: buildSlots(local),
    activeSlot: active,
    weapon,
    mag: isGun && activeGun ? activeGun.mag : null,
    magSize: isGun ? wb.magSize : null,
    reserve: ammoType !== null ? local.ammo[ammoType] : null,
    heals: { ...local.heals },
    healMax: { bandage: balance.items.bandage.maxStack, medkit: balance.items.medkit.maxStack },
    reserveMax: ammoType !== null ? balance.items[ammoType].maxCarry : null,
    ammoType,
    reloadProgress: timerProgress(local.reloadRemainingMs, local.reloadTotalMs, snapshotTime, input.now),
    healProgress: timerProgress(local.healRemainingMs, local.healTotalMs, snapshotTime, input.now),
    healItem: local.healRemainingMs > 0 ? local.healItem : null,
    dropping: input.localPose?.dropping ?? local.movement.dropping,
    outsideZone: input.outsideZone,
    ...(balance.player.lowHpThreshold !== undefined ? { lowHpThreshold: balance.player.lowHpThreshold } : {}),
  };
}

export function buildZoneView(zone: ZoneState, now: number): HudZoneView {
  return {
    phaseIndex: zone.phaseIndex,
    phaseCount: zone.phaseCount,
    shrinking: zone.shrinking,
    isFinal: zone.phaseIndex >= zone.phaseCount,
    secondsLeft: secondsUntil(zone.phaseEndsAt, now),
    center: { ...zone.center },
    radius: zone.radius,
    targetCenter: { ...zone.targetCenter },
    targetRadius: zone.targetRadius,
    dps: zone.dps,
  };
}

export function buildHudView(input: HudBuildInput): HudView {
  const snap = input.snapshot;
  const match = snap?.match ?? null;
  const phase = match?.phase ?? 'lobby';
  const endsAt = match?.phaseEndsAt ?? null;

  let local: HudLocalView | null = null;
  if (snap?.local) {
    const player = snap.players.find((p) => p.id === snap.local?.id);
    local = buildLocalView(snap.local, player, input, snap.serverTime);
  }

  const target = input.spectateTarget;
  let self: HudView['minimap']['self'] = null;
  if (target) self = { x: target.pos.x, z: target.pos.z, yaw: target.yaw };
  else if (input.localPose) self = { x: input.localPose.pos.x, z: input.localPose.pos.z, yaw: input.localPose.yaw };

  return {
    connection: input.connection,
    joined: input.joined,
    phase,
    countdownSecondsLeft: phase === 'countdown' && endsAt !== null ? secondsUntil(endsAt, input.now) : null,
    resultsSecondsLeft: phase === 'results' && endsAt !== null ? secondsUntil(endsAt, input.now) : null,
    lobbyCount: match?.lobbyCount ?? 0,
    targetPlayers: match?.targetPlayers ?? input.balance.match.targetPlayers,
    aliveCount: match?.aliveCount ?? 0,
    totalPlayers: match?.totalPlayers ?? 0,
    local,
    zone: input.zone ? buildZoneView(input.zone, input.now) : null,
    minimap: { map: input.map, self },
    spectate: target
      ? { targetId: target.id, targetName: target.name, targetHp: target.hp, targetMaxHp: input.balance.player.maxHp }
      : null,
    pointerLocked: input.pointerLocked,
    crosshairSpreadDeg: input.crosshairSpreadDeg,
    cameraFovDeg: input.cameraFovDeg,
    deathScreenSeconds: input.balance.match.deathScreenSeconds,
  };
}
