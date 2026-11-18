/**
 * Builds the per-frame HudView (contracts.ts) from the latest snapshot plus client-side state. Pure.
 * HP and armor durability stay floats (the UI shows ceil, combat.md). Timers and progress bars are extrapolated to `now`
 * so they tick smoothly between 20 Hz snapshots.
 */
import { zoneThemeOf, type Balance, type ZoneTheme } from '../shared/balance';
import { isIndoor } from '../shared/maps';
import type {
  AdsBlockReason,
  AdsView,
  HudDropView,
  MinimapRouteView,
  RoomsView,
  HudArmorView,
  HudCookView,
  HudGrenadeDangerView,
  HudLocalView,
  HudSlotView,
  HudView,
  HudZoneView,
} from '../shared/contracts';
import { clamp } from '../shared/math';
import type {
  AnyMapData,
  ArmorPieceState,
  ArmorSlot,
  ConnectionStatus,
  LocalPlayerState,
  MapData,
  PlayerId,
  PlayerState,
  Stance,
  Vec3,
  WorldSnapshot,
  ZoneState,
} from '../shared/types';
import { armorIdOf, FISTS_SLOT, GRENADE_SLOT } from '../shared/types';
import { secondsUntil } from './zoneView';

export interface LocalPose {
  pos: Vec3;
  yaw: number;
  dropping: boolean;
}

export interface HudBuildInput {
  balance: Balance;
  /** M2b: the active map (minimap); AnyMapData until the C-gate makes MapData the union. */
  map: AnyMapData;
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
  /** M2a: local ADS view (same object as FrameView.ads); absent = null. */
  ads?: AdsView | null;
  /** M2a: live grenades near the local player, nearest first; absent = []. */
  grenadeDanger?: HudGrenadeDangerView[];
  /** M2a: predicted stance of the local player; absent = the snapshot's PlayerState stance. */
  localStance?: LocalStanceView | null;
  /**
   * M2a: cook ring override (predicted pin pull before the snapshot confirms it). Absent = derived from
   * snapshot.local.cookExplodesAt.
   */
  cook?: HudCookView | null;
  // ---- M2b (all optional here; ClientGame always passes them) ----
  rooms?: RoomsView;
  drop?: HudDropView | null;
  route?: MinimapRouteView | null;
  zoneTheme?: ZoneTheme;
  /** Which camera the player looks through (HudView.cameraView). */
  cameraView?: NonNullable<HudView['cameraView']>;
  /** FP or V chase while spectating (HudView.spectate.view). */
  spectateView?: 'firstPerson' | 'chase';
  /** REVIEW-M2a addendum: RMB held with a sighted weapon while a reload or heal blocks ADS. */
  adsBlocked?: AdsBlockReason | null;
}

/** HudView.rooms before the hello reply (also the default for callers that pass none). */
const NO_ROOMS: RoomsView = { location: 'none', browser: null, room: null, pending: null };

export interface LocalStanceView {
  stance: Stance;
  stanceFrom: Stance;
  /** 0..1, 1 = settled. */
  progress: number;
}

/** 0..1 progress of a timer with `remainingMs` left at `snapshotTime`, extrapolated to `now`; null if idle. */
export function timerProgress(remainingMs: number, totalMs: number, snapshotTime: number, now: number): number | null {
  if (remainingMs <= 0 || totalMs <= 0) return null;
  const left = Math.max(0, remainingMs - Math.max(0, now - snapshotTime));
  return clamp(1 - left / totalMs, 0, 1);
}

export function buildSlots(local: LocalPlayerState): [HudSlotView, HudSlotView, HudSlotView, HudSlotView] {
  const slot = (i: 0 | 1): HudSlotView => {
    const s = local.slots[i];
    return { slot: i, weapon: s ? s.weapon : null, mag: s ? s.mag : null, count: null };
  };
  return [
    slot(0),
    slot(1),
    { slot: FISTS_SLOT, weapon: 'fists', mag: null, count: null },
    { slot: GRENADE_SLOT, weapon: 'grenade', mag: null, count: local.grenades },
  ];
}

/** M2a: HUD view of a worn piece (armor.md "What the UI must show"), null for an empty slot. */
export function buildArmorView(slot: ArmorSlot, piece: ArmorPieceState | null, balance: Balance): HudArmorView | null {
  if (!piece) return null;
  const id = armorIdOf(slot, piece.tier);
  return { id, tier: piece.tier, durability: piece.durability, maxDurability: balance.items[id].durability };
}

/** M2a: cook ring from the authoritative cookExplodesAt, or null when not cooking. */
export function buildCookView(local: LocalPlayerState, now: number, balance: Balance): HudCookView | null {
  if (local.cookExplodesAt === null) return null;
  return { fuseRemainingMs: Math.max(0, local.cookExplodesAt - now), fuseMs: balance.items.grenade.fuseMs };
}

export function buildLocalView(
  local: LocalPlayerState,
  player: PlayerState | undefined,
  input: Pick<HudBuildInput, 'balance' | 'localName' | 'localPose' | 'outsideZone' | 'now' | 'localStance' | 'cook'>,
  snapshotTime: number,
): HudLocalView {
  const { balance } = input;
  const weapon = player?.weapon ?? 'fists';
  const active = local.activeSlot;
  const activeGun = active === 0 || active === 1 ? local.slots[active] : null;
  const wb = weapon === 'grenade' ? null : balance.weapons[weapon];
  const ammoType = wb && weapon !== 'fists' ? wb.ammo : null;
  const isGun = ammoType !== null;
  const stance: LocalStanceView = input.localStance ?? {
    stance: player?.stance ?? local.movement.stance,
    stanceFrom: player?.stanceFrom ?? local.movement.stanceFrom,
    progress: player?.stanceProgress ?? 1,
  };
  return {
    id: local.id,
    name: player?.name ?? input.localName,
    alive: player?.alive ?? false,
    hp: player?.hp ?? 0,
    maxHp: balance.player.maxHp,
    vest: buildArmorView('vest', local.vest, balance),
    helmet: buildArmorView('helmet', local.helmet, balance),
    kills: player?.kills ?? 0,
    pos: input.localPose ? { ...input.localPose.pos } : { ...local.movement.pos },
    yaw: input.localPose?.yaw ?? player?.yaw ?? 0,
    slots: buildSlots(local),
    activeSlot: active,
    weapon,
    mag: isGun && activeGun ? activeGun.mag : null,
    magSize: isGun && wb ? wb.magSize : null,
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
    grenades: local.grenades,
    grenadeMax: balance.items.grenade.maxCarry,
    cook: input.cook !== undefined ? input.cook : buildCookView(local, input.now, balance),
    stance: stance.stance,
    stanceFrom: stance.stanceFrom,
    stanceProgress: clamp(stance.progress, 0, 1),
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
    // `as MapData`: a no-op after the C-gate (MapData = AnyMapData); before it the HUD type is still island-only.
    minimap: { map: input.map as MapData, self, route: input.route ?? null },
    spectate: target
      ? {
          targetId: target.id,
          targetName: target.name,
          targetHp: target.hp,
          targetMaxHp: input.balance.player.maxHp,
          view: input.spectateView ?? 'firstPerson',
        }
      : null,
    pointerLocked: input.pointerLocked,
    crosshairSpreadDeg: input.crosshairSpreadDeg,
    ads: local?.alive ? (input.ads ?? null) : null,
    grenadeDanger: local?.alive ? (input.grenadeDanger ?? []) : [],
    adsBlocked: local?.alive ? (input.adsBlocked ?? null) : null,
    cameraFovDeg: input.cameraFovDeg,
    deathScreenSeconds: input.balance.match.deathScreenSeconds,
    rooms: input.rooms ?? NO_ROOMS,
    drop: input.drop ?? null,
    zoneTheme: input.zoneTheme ?? zoneThemeOf(input.balance, input.map.id, isIndoor(input.map) ? 'indoor' : 'island'),
    cameraView: input.cameraView ?? 'orbit',
  };
}
