/**
 * Builds the per-frame HudView (contracts.ts) from the latest snapshot plus client-side state. Pure.
 * HP and armor durability stay floats (the UI shows ceil, combat.md). Timers and progress bars are extrapolated to `now`
 * so they tick smoothly between 20 Hz snapshots.
 */
import { compatibleScopes, effectiveSight, weaponBalance, zoneThemeOf, type Balance, type ZoneTheme } from '../shared/balance';
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
  M2cThrowableId,
  MapData,
  MatchLayoutRef,
  PlayerId,
  PlayerState,
  ScopeId,
  Stance,
  Vec3,
  WeaponSlotState,
  WorldSnapshot,
  ZoneState,
} from '../shared/types';
import { armorIdOf, FISTS_SLOT, GRENADE_SLOT, isM2cThrowableId } from '../shared/types';
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
  // ---- M2c (optional here; absent = no layout, not in smoke) ----
  /** This match's layout (HudMinimapView.layout; HudView.layout takes seed and look). Absent = null. */
  layout?: MatchLayoutRef | null;
  /** The camera is inside an opaque smoke cloud (HudView.inSmoke). Absent = false. */
  inSmoke?: boolean;
  /** Predicted M2c local fields (throwable selection, T switch, melee recovery). Absent = from snapshot.local. */
  predicted?: HudLocalPrediction | null;
}

/**
 * M2c: local HUD fields that must react within a frame (UI M2c §2.1, §4, §16.4), predicted by ClientGame
 * (m2cPrediction.ts). Without it the HUD shows snapshot.local as is.
 */
export interface HudLocalPrediction {
  selectedThrowable: M2cThrowableId;
  /** Mounted scope per gun slot, with a T switch's target already applied. */
  slotScopes: readonly [ScopeId | null, ScopeId | null];
  spareScope: ScopeId | null;
  scopeSwapProgress: number | null;
  meleeRecovery: number | null;
}

/** The HUD prediction that equals the snapshot (no pending change). */
export function snapshotPrediction(local: LocalPlayerState, now: number, snapshotTime: number, balance: Balance): HudLocalPrediction {
  return {
    selectedThrowable: local.selectedThrowable,
    slotScopes: [local.slots[0]?.scope ?? null, local.slots[1]?.scope ?? null],
    spareScope: local.spareScope,
    scopeSwapProgress: timerProgress(local.scopeSwapRemainingMs, balance.scopes.swapMs, snapshotTime, now),
    meleeRecovery: null,
  };
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

/** M2c fields of a non-gun slot (fists, throwables, empty): no level, no scope, no sight. */
const NO_SIGHT_FIELDS = { level: null, scope: null, sight: 'none', builtInSight: 'none', compatibleScopes: [] } as const;

/** M2c fields of a gun slot (levels.md, scopes.md): absent level = L1; `scope` is the (predicted) mounted scope. */
function gunSlotFields(
  s: WeaponSlotState,
  scope: ScopeId | null,
  balance: Balance,
): Required<Pick<HudSlotView, 'level' | 'scope' | 'sight' | 'builtInSight' | 'compatibleScopes'>> {
  return {
    level: s.level ?? 1,
    scope,
    sight: effectiveSight(balance, s.weapon, scope),
    builtInSight: weaponBalance(balance, s.weapon).sight,
    compatibleScopes: compatibleScopes(balance, s.weapon),
  };
}

/** Carried count of one throwable type. */
export const throwableCount = (local: Pick<LocalPlayerState, 'grenades' | 'smokes'>, t: M2cThrowableId): number =>
  t === 'smoke' ? local.smokes : local.grenades;

/**
 * Slot row (combat.md "Inventory and keys"): 0/1 guns with level and (predicted) sight, 2 = fists or the carried melee
 * weapon with its level, 3 = the SELECTED throwable (predicted) and that type's count.
 */
export function buildSlots(
  local: LocalPlayerState,
  balance: Balance,
  predicted: Pick<HudLocalPrediction, 'selectedThrowable' | 'slotScopes'> | null = null,
): [HudSlotView, HudSlotView, HudSlotView, HudSlotView] {
  const slot = (i: 0 | 1): HudSlotView => {
    const s = local.slots[i];
    if (!s) return { slot: i, weapon: null, mag: null, count: null, ...NO_SIGHT_FIELDS };
    const scope = predicted ? predicted.slotScopes[i] : (s.scope ?? null);
    return { slot: i, weapon: s.weapon, mag: s.mag, count: null, ...gunSlotFields(s, scope, balance) };
  };
  const melee = local.melee;
  const selected = predicted?.selectedThrowable ?? local.selectedThrowable;
  return [
    slot(0),
    slot(1),
    melee
      ? { slot: FISTS_SLOT, weapon: melee.weapon, mag: null, count: null, ...NO_SIGHT_FIELDS, level: melee.level }
      : { slot: FISTS_SLOT, weapon: 'fists', mag: null, count: null, ...NO_SIGHT_FIELDS },
    { slot: GRENADE_SLOT, weapon: selected, mag: null, count: throwableCount(local, selected), ...NO_SIGHT_FIELDS },
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
  // Only frags cook (smoke.md: not cookable), so a running fuse is always a frag's.
  return { fuseRemainingMs: Math.max(0, local.cookExplodesAt - now), fuseMs: balance.items.grenade.fuseMs, throwable: 'grenade' };
}

export function buildLocalView(
  local: LocalPlayerState,
  player: PlayerState | undefined,
  input: Pick<HudBuildInput, 'balance' | 'localName' | 'localPose' | 'outsideZone' | 'now' | 'localStance' | 'cook' | 'predicted'>,
  snapshotTime: number,
): HudLocalView {
  const { balance } = input;
  const pred = input.predicted ?? snapshotPrediction(local, input.now, snapshotTime, balance);
  const active = local.activeSlot;
  // The throwable slot shows the PREDICTED selection (a 4 / G cycle shows in the same frame).
  const weapon = active === GRENADE_SLOT && isM2cThrowableId(player?.weapon) ? pred.selectedThrowable : (player?.weapon ?? 'fists');
  const activeGun = active === 0 || active === 1 ? local.slots[active] : null;
  const wb = isM2cThrowableId(weapon) ? null : weaponBalance(balance, weapon);
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
    slots: buildSlots(local, balance, pred),
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
    // M2c (ADR 0007 §8): levels, both throwable stacks, the predicted selection, melee recovery and the scope pouch.
    weaponLevel: activeGun ? (activeGun.level ?? 1) : active === FISTS_SLOT ? (local.melee?.level ?? null) : null,
    throwables: throwableCounts(local.grenades, local.smokes),
    throwableMax: throwableCounts(balance.items.grenade.maxCarry, balance.items.smoke.maxCarry),
    throwableSelected: pred.selectedThrowable,
    meleeRecovery: active === FISTS_SLOT && local.melee ? pred.meleeRecovery : null,
    scopeStash: pred.spareScope ? [pred.spareScope] : [],
    scopeStashMax: balance.scopes.spareSlots,
    scopeSwapProgress: pred.scopeSwapProgress,
    ...(balance.player.lowHpThreshold !== undefined ? { lowHpThreshold: balance.player.lowHpThreshold } : {}),
  };
}

const throwableCounts = (grenade: number, smoke: number): Record<M2cThrowableId, number> => ({ grenade, smoke });

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
    minimap: { map: input.map as MapData, layout: input.layout ?? null, self, route: input.route ?? null },
    spectate: target
      ? {
          targetId: target.id,
          targetName: target.name,
          targetHp: target.hp,
          targetMaxHp: input.balance.player.maxHp,
          view: input.spectateView ?? 'firstPerson',
          // M2c (P2): the target's held item and its level (spectate bar badge).
          weapon: target.weapon,
          weaponLevel: target.weaponLevel ?? null,
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
    inSmoke: input.inSmoke ?? false,
    layout: input.layout ? { seed: input.layout.seed, look: input.layout.look } : null,
  };
}
