/**
 * Event-driven VFX (bus subscriber only; never emits). Owner: graphics-engineer.
 * shotFired -> muzzle flash + tracer per impact (impact puff when the tracer arrives); playerDamaged -> hit react,
 * headshot star; playerKilled -> topple then poof; itemPickedUp -> sparkle; land/jump/footstep -> dust or splash;
 * zoneChanged -> tide wall pulse. Everything pooled: no allocation per shot.
 * M2a: explosion -> cartoon boom (flash star, smoke balls, shock ring, sand chunks or water spray, fading sand disc,
 * camera shake by localDistance); grenadeBounced on water and forced stance changes (water stand-up) -> splash;
 * grenadeThrown / grenadeCooked -> throw pose and fuse clock; armor break (playerDamaged vest/helmet.broken) ->
 * shard burst at the chest or head.
 */
import type * as THREE from 'three';
import type { EventBus, GameEvents } from '../../shared/events';
import type { GlassSurface, ImpactSurface, IndoorSurface, M2cArmorTier, M2cWeaponId, Surface, Vec3 } from '../../shared/types';
import { PARTICLE_SHAPE } from '../shaders/particles';
import { palette } from '../procedural';
import { ExplosionDecals, explosionShake } from './Explosions';
import { linearRgb, makeSpec, ParticleSystem, type ParticleSpec } from './Particles';
import { TracerSystem } from './Tracers';

/** What the VFX layer needs from the rest of the renderer (keeps this module free of scene details). */
export interface VfxHost {
  cameraPosition: THREE.Vector3;
  getMuzzle(playerId: number, out: Vec3): boolean;
  onShot(playerId: number): void;
  onDamaged(playerId: number): void;
  /** Returns true if a view will topple and poof by itself. */
  onKilled(playerId: number): boolean;
  surfaceAt(x: number, z: number): Surface | IndoorSurface;
  pulseTide(): void;
  /** Player body height (balance player.height), for head/chest effect anchors. */
  playerHeight: number;
  /** M2a: sim terrain height (explosion over water when < 0). */
  heightAt?(x: number, z: number): number;
  /** M2a: grenade throw follow-through on the thrower's view. */
  onThrow?(playerId: number): void;
  /** M2a: pin pulled; explodesAt is server ms. */
  onCooked?(playerId: number, explodesAt: number): void;
  /** M2a: stop drawing an exploded grenade. */
  onExploded?(grenadeId: number): void;
  /** M2a: camera shake, amount 0..1. */
  shake?(amount: number): void;
}

/**
 * Muzzle flash scale and tracer width (m) per weapon. Keyed by the M2c union (compiles before and after the C-gate).
 * M2c: the rpg launch flash is the shotgun size (art M2c §3) and it has no tracer (the rocket is drawn); melee never
 * fires a shot (0 = no flash, no tracer).
 */
const FLASH_SCALE: Record<M2cWeaponId, number> = {
  fists: 1, pistol: 0.8, smg: 0.9, shotgun: 1.4, rifle: 1, dmr: 1.15, sniper: 1.35, lmg: 1.05,
  dbshotgun: 1.4, revolver: 1.0, rpg: 1.4, knife: 0, machete: 0, paddle: 0,
};
const TRACER_WIDTH: Record<M2cWeaponId, number> = {
  fists: 0.04, pistol: 0.045, smg: 0.045, shotgun: 0.035, rifle: 0.06, dmr: 0.065, sniper: 0.08, lmg: 0.055,
  dbshotgun: 0.035, revolver: 0.06, rpg: 0, knife: 0, machete: 0, paddle: 0,
};

/** Explosion: smoke balls drift out to radius x SMOKE_REACH over SMOKE_LIFE (STYLE.md §15). */
const SMOKE_LIFE = 0.6;
const SMOKE_REACH = 0.5;
const SMOKE_DRAG = 4;
const EXPLOSION_FX_DIST2 = 260 * 260;

/** Impact codes packed in 3 tracer-tag bits. M2b: 'glass' (C-gate member of ImpactSurface). */
const SURFACE_CODE: Record<ImpactSurface | GlassSurface, number> = { none: 0, player: 1, terrain: 2, prop: 3, water: 4, glass: 5 };
/** Ground the dust takes its colour from (island sand / grass, M2b office floors). */
type GroundSurface = Surface | IndoorSurface;
const MAX_FX_DIST2 = 160 * 160;
/** Canopy centre above the feet (parachute model, carrier.ts). */
const CANOPY_HEIGHT = 2.7;
const FOOTSTEP_FX_DIST2 = 35 * 35;

type Rgb = [number, number, number];

export class Vfx {
  readonly particles: ParticleSystem;
  readonly tracers: TracerSystem;
  private readonly unsubs: (() => void)[] = [];
  private readonly spec: ParticleSpec = makeSpec();
  private readonly muzzle: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly C: Record<string, Rgb>;
  readonly decals = new ExplosionDecals();
  /** FrameView.reducedMotion of the last frame (Renderer sets it): fewer sparks, no drift, no shake. */
  reducedMotion = false;
  private readonly armorRgb: Record<M2cArmorTier, Rgb>;

  constructor(
    bus: EventBus<GameEvents>,
    private readonly host: VfxHost,
    maxParticles: number,
  ) {
    this.particles = new ParticleSystem(maxParticles, palette.ink);
    this.tracers = new TracerSystem(160, (tag, x, y, z) => this.impact(tag & 7, (tag & 8) !== 0, x, y, z));
    this.C = {
      white: linearRgb(palette.hitPuff),
      spark: linearRgb(palette.hitSpark),
      flash: linearRgb(palette.muzzleFlash),
      flashEdge: linearRgb(palette.muzzleFlashEdge),
      sand: linearRgb(palette.sandLight),
      sandDark: linearRgb(palette.sandDark),
      grass: linearRgb(palette.grass),
      wood: linearRgb(palette.wood),
      rock: linearRgb(palette.rockLight),
      foam: linearRgb(palette.foam),
      sea: linearRgb(palette.seaShallow),
      tide: linearRgb(palette.tideWall),
      star: linearRgb(palette.flowerCenter),
      tracer: linearRgb(palette.muzzleFlash),
      epic: linearRgb(palette.tierEpic),
      rare: linearRgb(palette.tierRare),
      smoke: linearRgb(0xfff3d6),
      boomEdge: linearRgb(palette.muzzleFlashEdge),
      fuse: linearRgb(palette.flowerCenter),
      glass: linearRgb(0xbfe6f0),
      plank: linearRgb(0xcb9c66),
      carpet: linearRgb(0x5e6f8a),
      tile: linearRgb(0xe6eef0),
      rain: linearRgb(0xf4fbff),
      cream: linearRgb(0xfff4e2),
      // M2c (art M2c §3, §5)
      coral: linearRgb(0xff5a5f),
      mango: linearRgb(0xffc43d),
      mint: linearRgb(0x7fddb8),
      lilac: linearRgb(0xc9b6f2),
      flameCore: linearRgb(0xfff1a8),
      flameEdge: linearRgb(0xff9d2e),
      rocketPuff: linearRgb(0xfff3d6),
      rocketSpark: linearRgb(0xffd23f),
      pure: linearRgb(0xffffff),
      glint: linearRgb(0xf4fafc),
    };
    this.armorRgb = { 1: linearRgb(palette.armor1), 2: linearRgb(palette.armor2), 3: linearRgb(palette.armor3), 4: linearRgb(palette.armor4) };

    this.unsubs.push(
      bus.on('shotFired', (e) => this.onShot(e)),
      bus.on('playerDamaged', (e) => this.onDamaged(e)),
      bus.on('playerKilled', (e) => {
        if (!this.host.onKilled(e.victimId)) this.poof(e.victimPos.x, e.victimPos.y + 0.5, e.victimPos.z);
      }),
      bus.on('itemPickedUp', (e) => this.sparkle(e.pos.x, e.pos.y + 0.5, e.pos.z)),
      bus.on('land', (e) => this.landDust(e.pos, e.fallSpeed, e.surface, e.isLocal)),
      bus.on('jump', (e) => this.footPuff(e.pos, 3, this.host.surfaceAt(e.pos.x, e.pos.z))),
      bus.on('footstep', (e) => {
        if (e.sprinting || e.surface === 'water') this.footPuff(e.pos, e.surface === 'water' ? 2 : 1, e.surface);
      }),
      bus.on('zoneChanged', () => this.host.pulseTide()),
      bus.on('explosion', (e) => this.explosion(e)),
      bus.on('grenadeBounced', (e) => {
        if (e.surface === 'water') this.splash(e.pos.x, Math.max(e.pos.y, 0.02), e.pos.z, 4, 0.45 + Math.min(0.6, e.speed / 20));
      }),
      bus.on('grenadeThrown', (e) => {
        if (!e.dropped) this.host.onThrow?.(e.ownerId);
      }),
      bus.on('grenadeCooked', (e) => this.host.onCooked?.(e.playerId, e.explodesAt)),
      bus.on('stanceChanged', (e) => {
        if (e.forced) this.splash(e.pos.x, Math.max(e.pos.y, 0.02), e.pos.z, 7, 0.8);
      }),
      // M2b drop: a cream puff at the hatch, and the parachute "pop" (4 cream smoke balls at the canopy, STYLE §20.2).
      bus.on('playerJumped', (e) => this.hatchPuff(e.pos.x, e.pos.y, e.pos.z)),
      bus.on('parachuteOpened', (e) => this.chutePop(e.pos.x, e.pos.y + CANOPY_HEIGHT, e.pos.z)),
      // M2c (art M2c §3, §5): rocket launch flash + back-blast, dud puff, glass shatter.
      bus.on('rocketFired', (e) => this.rocketLaunch(e)),
      bus.on('rocketDud', (e) => this.rocketDud(e.pos.x, e.pos.y, e.pos.z)),
      bus.on('glassBroken', (e) => this.glassShatter(e.pos.x, e.pos.y, e.pos.z)),
    );
  }

  private far(x: number, y: number, z: number, d2 = MAX_FX_DIST2): boolean {
    const c = this.host.cameraPosition;
    return (x - c.x) ** 2 + (y - c.y) ** 2 + (z - c.z) ** 2 > d2;
  }

  private p(
    x: number, y: number, z: number, vx: number, vy: number, vz: number, life: number, size0: number, size1: number,
    col: Rgb, shape: number, gravity: number, drag: number, alpha = 1,
  ): void {
    const s = this.spec;
    s.x = x; s.y = y; s.z = z;
    s.vx = vx; s.vy = vy; s.vz = vz;
    s.life = life;
    s.size0 = size0;
    s.size1 = size1;
    s.r = col[0]; s.g = col[1]; s.b = col[2];
    s.alpha = alpha;
    s.shape = shape as ParticleSpec['shape'];
    s.gravity = gravity;
    s.drag = drag;
    s.rot = Math.random() * Math.PI * 2;
    s.rotVel = (Math.random() - 0.5) * 6;
    this.particles.emit(s);
  }

  // ------------------------------------------------------------------------------------------------
  private onShot(e: GameEvents['shotFired']): void {
    this.host.onShot(e.shooterId);
    const o = e.origin;
    if (this.far(o.x, o.y, o.z, 220 * 220)) return;
    const m = this.muzzle;
    if (!this.host.getMuzzle(e.shooterId, m)) {
      m.x = o.x;
      m.y = o.y;
      m.z = o.z;
    }
    if (e.weapon === 'fists') {
      for (let i = 0; i < e.impacts.length; i++) {
        const im = e.impacts[i];
        if (im.surface === 'player') this.impact(SURFACE_CODE.player, im.headshot, im.point.x, im.point.y, im.point.z);
      }
      return;
    }
    // Muzzle flash: one star-burst + a few forward sparks.
    const first = e.impacts[0];
    let fx = 0, fy = 0, fz = 0;
    if (first) {
      const dx = first.point.x - m.x, dy = first.point.y - m.y, dz = first.point.z - m.z;
      const l = Math.hypot(dx, dy, dz) || 1;
      fx = dx / l; fy = dy / l; fz = dz / l;
    }
    const big = FLASH_SCALE[e.weapon] ?? 1;
    this.p(m.x + fx * 0.06, m.y + fy * 0.06, m.z + fz * 0.06, 0, 0, 0, 0.06, 0.42 * big, 0.55 * big, this.C.flash, PARTICLE_SHAPE.flash, 0, 0);
    for (let i = 0; i < 3; i++) {
      const sp = 5 + Math.random() * 4;
      this.p(m.x, m.y, m.z, fx * sp + (Math.random() - 0.5) * 2, fy * sp + Math.random(), fz * sp + (Math.random() - 0.5) * 2,
        0.12, 0.07, 0.02, this.C.flashEdge, PARTICLE_SHAPE.spark, 6, 2);
    }
    const width = TRACER_WIDTH[e.weapon] ?? 0.045;
    const t = this.C.tracer;
    for (let i = 0; i < e.impacts.length; i++) {
      const im = e.impacts[i];
      const tag = SURFACE_CODE[im.surface] | (im.headshot ? 8 : 0);
      this.tracers.spawn(m.x, m.y, m.z, im.point.x, im.point.y, im.point.z, width, t[0], t[1], t[2], tag, 0);
    }
  }

  private impact(code: number, headshot: boolean, x: number, y: number, z: number): void {
    if (code === SURFACE_CODE.none || this.far(x, y, z)) return;
    const r = Math.random;
    switch (code) {
      case SURFACE_CODE.player:
        for (let i = 0; i < 5; i++) {
          this.p(x, y, z, (r() - 0.5) * 6, r() * 4 + 1, (r() - 0.5) * 6, 0.25, 0.09, 0.03, this.C.spark, PARTICLE_SHAPE.spark, 14, 1);
        }
        this.p(x, y, z, 0, 0.6, 0, 0.22, 0.22, 0.45, this.C.white, PARTICLE_SHAPE.puff, 0, 2);
        if (headshot) this.p(x, y + 0.15, z, 0, 1.4, 0, 0.5, 0.32, 0.5, this.C.star, PARTICLE_SHAPE.star, 0, 1.5);
        break;
      case SURFACE_CODE.glass:
        // Toon glass chip: pale blue-white shards and a white flash ring (no shattering in M2b).
        for (let i = 0; i < 6; i++) {
          this.p(x, y, z, (r() - 0.5) * 5, r() * 3 + 1, (r() - 0.5) * 5, 0.35, 0.08, 0.03, i % 2 ? this.C.white : this.C.glass, PARTICLE_SHAPE.spark, 14, 0.6);
        }
        this.p(x, y, z, 0, 0, 0, 0.18, 0.15, 0.4, this.C.white, PARTICLE_SHAPE.ring, 0, 1, 0.8);
        break;
      case SURFACE_CODE.terrain: {
        const surf = this.host.surfaceAt(x, z);
        const grass = surf === 'grass';
        const c = this.dustColour(surf);
        for (let i = 0; i < 3; i++) {
          this.p(x, y + 0.05, z, (r() - 0.5) * 1.5, r() * 1.5 + 0.5, (r() - 0.5) * 1.5, 0.45, 0.16, 0.38, c, PARTICLE_SHAPE.puff, 2, 2.5);
        }
        for (let i = 0; i < 3; i++) {
          this.p(x, y + 0.05, z, (r() - 0.5) * 3, r() * 3 + 2, (r() - 0.5) * 3, 0.4, 0.06, 0.04, grass ? this.C.grass : surf === 'sand' ? this.C.sandDark : c, PARTICLE_SHAPE.spark, 14, 0.5);
        }
        break;
      }
      case SURFACE_CODE.prop:
        for (let i = 0; i < 4; i++) {
          this.p(x, y, z, (r() - 0.5) * 4, r() * 3 + 1, (r() - 0.5) * 4, 0.4, 0.08, 0.05, this.C.wood, PARTICLE_SHAPE.spark, 14, 0.5);
        }
        this.p(x, y, z, 0, 0.4, 0, 0.3, 0.18, 0.36, this.C.rock, PARTICLE_SHAPE.puff, 0, 2);
        break;
      case SURFACE_CODE.water:
        this.splash(x, Math.max(y, 0.02), z, 6, 1);
        break;
    }
  }

  private splash(x: number, y: number, z: number, n: number, strength: number): void {
    const r = Math.random;
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const h = (r() * 1.2 + 0.4) * strength;
      this.p(x, y, z, Math.cos(a) * h, (r() * 2.5 + 2) * strength, Math.sin(a) * h, 0.55, 0.12, 0.06, this.C.foam, PARTICLE_SHAPE.puff, 12, 0.3);
    }
    this.p(x, y + 0.05, z, 0, 0.3, 0, 0.35, 0.25, 0.6, this.C.sea, PARTICLE_SHAPE.puff, 0, 2, 0.8);
  }

  private onDamaged(e: GameEvents['playerDamaged']): void {
    this.host.onDamaged(e.victimId);
    const v = e.victimPos;
    if (this.far(v.x, v.y, v.z)) return;
    if (e.cause === 'zone') {
      const r = Math.random;
      for (let i = 0; i < 4; i++) {
        this.p(v.x + (r() - 0.5) * 0.6, v.y + this.host.playerHeight * (0.4 + r() * 0.5), v.z + (r() - 0.5) * 0.6,
          (r() - 0.5) * 1.2, r() * 1.5 + 0.5, (r() - 0.5) * 1.2, 0.5, 0.12, 0.06, this.C.tide, PARTICLE_SHAPE.puff, 9, 0.3);
      }
    } else if (e.headshot) {
      // Star above the head even if the impact puff is far from the camera ray.
      this.p(v.x, v.y + this.host.playerHeight + 0.15, v.z, 0, 1.2, 0, 0.55, 0.3, 0.45, this.C.star, PARTICLE_SHAPE.star, 0, 1.5);
    }
    // Armor break: a burst of tier-coloured shards (vest at the chest, helmet at the head).
    if (e.vest?.broken) this.shards(v.x, v.y + this.host.playerHeight * 0.5, v.z, this.armorRgb[e.vest.tier] ?? this.C.white);
    if (e.helmet?.broken) this.shards(v.x, v.y + this.host.playerHeight * 0.85, v.z, this.armorRgb[e.helmet.tier] ?? this.C.white);
  }

  private shards(x: number, y: number, z: number, c: Rgb): void {
    const r = Math.random;
    for (let i = 0; i < 10; i++) {
      const a = (i / 10) * Math.PI * 2 + r() * 0.4;
      const sp = 2.2 + r() * 2;
      this.p(x, y, z, Math.cos(a) * sp, 1.5 + r() * 2.5, Math.sin(a) * sp, 0.55, 0.11, 0.06, i % 3 === 0 ? this.C.white : c, PARTICLE_SHAPE.spark, 14, 0.6);
    }
    this.p(x, y, z, 0, 0.5, 0, 0.25, 0.3, 0.6, this.C.white, PARTICLE_SHAPE.ring, 0, 1);
  }

  /** In-hand or in-flight fuse spark: 2-3 tiny yellow / white stars that pop (STYLE.md §15). */
  fuseSpark(x: number, y: number, z: number): void {
    if (this.far(x, y, z, FOOTSTEP_FX_DIST2 * 4)) return;
    const r = Math.random;
    const n = 2 + (r() < 0.5 ? 1 : 0);
    for (let i = 0; i < n; i++) {
      this.p(x, y, z, (r() - 0.5) * 1.6, 0.8 + r() * 1.2, (r() - 0.5) * 1.6, 0.18, 0.07, 0.02, i === 0 ? this.C.white : this.C.fuse, PARTICLE_SHAPE.star, 4, 1);
    }
  }

  /** Grenade flight trail: small cream puffs with ink rims, fading over 300 ms. */
  trailPuff(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    this.p(x, y, z, 0, 0.15, 0, 0.3, 0.1, 0.05, this.C.smoke, PARTICLE_SHAPE.puff, 0, 1, 0.8);
  }

  /** Cartoon boom (STYLE.md §15), sized to the blast radius; water spray when the ground under it is below sea level. */
  private explosion(e: GameEvents['explosion']): void {
    this.host.onExploded?.(e.id);
    const rocket = e.source === 'rocket';
    // M2c: rocket blasts shake 1.5x the grenade (art M2c §5.1); none with reduced motion (the renderer skips it).
    const amount = Math.min(1, explosionShake(e.localDistance, e.radius) * (rocket ? 1.5 : 1));
    if (amount > 0) this.host.shake?.(amount);
    if (rocket) this.rocketExtras(e);
    const { x, y, z } = e.pos;
    if (this.far(x, y, z, EXPLOSION_FX_DIST2)) return;
    const R = Math.max(1, e.radius);
    const ground = this.host.heightAt ? this.host.heightAt(x, z) : y - 0.1;
    const water = ground < 0;
    const gy = Math.max(ground, 0);
    const r = Math.random;
    // 0.15 s flash star (core + hot edge), then the smoke balls.
    this.p(x, y + 0.3, z, 0, 0, 0, 0.15, R * 0.45, R * 0.7, this.C.flash, PARTICLE_SHAPE.star, 0, 0, 1);
    this.p(x, y + 0.3, z, 0, 0, 0, 0.15, R * 0.6, R * 0.8, this.C.boomEdge, PARTICLE_SHAPE.flash, 0, 0, 0.9);
    const n = 7;
    const v0 = (R * SMOKE_REACH * SMOKE_DRAG) / (1 - Math.exp(-SMOKE_DRAG * SMOKE_LIFE));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.5;
      const up = 0.25 + r() * 0.5;
      const sp = v0 * (0.75 + r() * 0.35);
      this.p(x, y + 0.4, z, Math.cos(a) * sp * (1 - up * 0.5), sp * up * 0.6, Math.sin(a) * sp * (1 - up * 0.5),
        SMOKE_LIFE, R * 0.16, R * 0.32, i % 2 ? this.C.boomEdge : this.C.smoke, PARTICLE_SHAPE.puff, -0.5, SMOKE_DRAG);
    }
    this.p(x, y + 0.6, z, 0, 0.8, 0, SMOKE_LIFE * 1.2, R * 0.25, R * 0.4, this.C.smoke, PARTICLE_SHAPE.puff, -0.5, 2);
    if (water) {
      this.splash(x, 0.05, z, 14, 2.2);
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2;
        this.p(x, 0.1, z, Math.cos(a) * 3, 6 + r() * 3, Math.sin(a) * 3, 0.8, 0.35, 0.2, this.C.foam, PARTICLE_SHAPE.puff, 14, 0.3);
      }
    } else if (!e.airburst) {
      for (let i = 0; i < 6; i++) {
        const a = (i / 6) * Math.PI * 2 + r() * 0.6;
        const sp = 4 + r() * 4;
        this.p(x, gy + 0.2, z, Math.cos(a) * sp, 4 + r() * 4, Math.sin(a) * sp, 0.7, 0.2, 0.12, this.C.sandDark, PARTICLE_SHAPE.spark, 16, 0.4);
      }
    }
    // M2c airburst (max range, nothing hit): no ground shock ring and no dust disc.
    if (!e.airburst) this.decals.spawn(x, gy, z, R, !water);
  }

  /** M2c rocket blast extras: the fireworks burst (10 star sparks; 5 with reduced motion) and the direct-hit star. */
  private rocketExtras(e: GameEvents['explosion']): void {
    const { x, y, z } = e.pos;
    if (this.far(x, y, z, EXPLOSION_FX_DIST2)) return;
    const R = Math.max(1, e.radius);
    const n = this.reducedMotion ? 5 : 10;
    const cols = [this.C.coral, this.C.mango, this.C.mint, this.C.lilac];
    // Sparks reach ~0.6 R over 0.5 s with drag 2.5: v0 = 0.6 R * 2.5 / (1 - e^-1.25).
    const v0 = (0.6 * R * 2.5) / (1 - Math.exp(-1.25));
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      const up = 0.3 + 0.4 * ((i * 7) % 5) / 5;
      this.p(x, y + 0.5, z, Math.cos(a) * v0 * (1 - up * 0.4), v0 * up, Math.sin(a) * v0 * (1 - up * 0.4), 0.5, 0.35, 0.12,
        cols[i % 4], PARTICLE_SHAPE.star, 2, 2.5);
    }
    if (e.direct) this.p(x, y + 0.2, z, 0, 0, 0, 0.25, 1.2, 1.0, this.C.pure, PARTICLE_SHAPE.star, 0, 0);
  }

  /** M2c launch (art M2c §3): front flash at the shooter's muzzle (shotgun size) + 6 cream balls blown backwards. */
  private rocketLaunch(e: GameEvents['rocketFired']): void {
    this.host.onShot(e.ownerId);
    const m = this.muzzle;
    if (!this.host.getMuzzle(e.ownerId, m)) {
      m.x = e.pos.x; m.y = e.pos.y; m.z = e.pos.z;
    }
    if (this.far(m.x, m.y, m.z)) return;
    const l = Math.hypot(e.vel.x, e.vel.y, e.vel.z) || 1;
    const fx = e.vel.x / l, fy = e.vel.y / l, fz = e.vel.z / l;
    this.p(m.x + fx * 0.1, m.y + fy * 0.1, m.z + fz * 0.1, 0, 0, 0, 0.07, 0.6, 0.75, this.C.flash, PARTICLE_SHAPE.flash, 0, 0);
    // Back-blast at the tube's rear (about 1 m behind the muzzle): a 0.8 m cone of cream smoke, fading over 0.5 s.
    const bx = m.x - fx * 1.0, by = m.y - fy * 1.0, bz = m.z - fz * 1.0;
    const r = Math.random;
    for (let i = 0; i < 6; i++) {
      const sx = (r() - 0.5) * 1.2, sy = (r() - 0.5) * 1.2, sz = (r() - 0.5) * 1.2;
      this.p(bx, by, bz, -fx * 3 + sx, -fy * 3 + sy + 0.3, -fz * 3 + sz, 0.5, 0.25, 0.55, this.C.cream, PARTICLE_SHAPE.puff, -0.3, 3, 0.9);
    }
  }

  private rocketDud(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    const r = Math.random;
    this.p(x, y + 0.1, z, 0, 0.5, 0, 0.45, 0.25, 0.5, this.C.rocketPuff, PARTICLE_SHAPE.puff, 0, 2, 0.9);
    for (let i = 0; i < 4; i++) this.p(x, y + 0.1, z, (r() - 0.5) * 4, r() * 3 + 1, (r() - 0.5) * 4, 0.3, 0.07, 0.03, this.C.spark, PARTICLE_SHAPE.spark, 14, 1);
  }

  /** M2c rocket in flight (RocketLayer): flame at the nozzle each frame (crossed quads approximated by a flash). */
  rocketFlame(x: number, y: number, z: number, flicker: number): void {
    if (this.far(x, y, z)) return;
    this.p(x, y, z, 0, 0, 0, 0.04, 0.22 * flicker, 0.16 * flicker, this.C.flameCore, PARTICLE_SHAPE.flash, 0, 0);
    this.p(x, y, z, 0, 0, 0, 0.05, 0.3 * flicker, 0.2 * flicker, this.C.flameEdge, PARTICLE_SHAPE.flash, 0, 0, 0.8);
  }

  /** M2c rocket trail puff (every 0.35 m): r 0.08 -> 0.30 m over 0.7 s, drifting up 0.3 m (none with reduced motion). */
  rocketPuff(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    this.p(x, y, z, 0, this.reducedMotion ? 0 : 0.43, 0, 0.7, 0.16, 0.6, this.C.rocketPuff, PARTICLE_SHAPE.puff, 0, 0, 0.9);
  }

  /** M2c trail spark star (every 0.7 m; none with reduced motion). */
  rocketSpark(x: number, y: number, z: number): void {
    if (this.reducedMotion || this.far(x, y, z)) return;
    const r = Math.random;
    this.p(x, y, z, (r() - 0.5) * 2, (r() - 0.5) * 2, (r() - 0.5) * 2, 0.3, 0.18, 0.05, this.C.rocketSpark, PARTICLE_SHAPE.star, 0, 2);
  }

  /**
   * M2c glass shatter (art M2c §5.2): 16-20 pane-tint shards with white glints falling with gravity, the chip ring at
   * 2x and 6 sparkle stars (reduced motion: 10 shards, no sparkle). Office world scale (shards 0.3-0.8 m).
   */
  glassShatter(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    const r = Math.random;
    const n = this.reducedMotion ? 10 : 16 + Math.floor(r() * 5);
    for (let i = 0; i < n; i++) {
      const a = r() * Math.PI * 2;
      const sp = 2 + r() * 5;
      this.p(x + (r() - 0.5) * 2, y + (r() - 0.5) * 3, z + (r() - 0.5) * 2, Math.cos(a) * sp, r() * 4, Math.sin(a) * sp,
        1.2, 0.3 + r() * 0.5, 0.2, i % 4 === 0 ? this.C.glint : this.C.glass, PARTICLE_SHAPE.spark, 25, 0.4);
    }
    this.p(x, y, z, 0, 0, 0, 0.25, 0.3, 0.8, this.C.white, PARTICLE_SHAPE.ring, 0, 1, 0.8);
    if (!this.reducedMotion) {
      for (let i = 0; i < 6; i++) this.p(x + (r() - 0.5) * 3, y + (r() - 0.5) * 3, z + (r() - 0.5) * 3, 0, 0.5, 0, 0.5, 0.35, 0.1, this.C.pure, PARTICLE_SHAPE.star, 0, 1);
    }
  }

  /** Death poof (also called by PlayerViews when a toppled body vanishes). */
  poof(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    const r = Math.random;
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2;
      const sp = 1.2 + r() * 1.2;
      this.p(x, y + (r() - 0.3) * 0.5, z, Math.cos(a) * sp, r() * 1.4, Math.sin(a) * sp, 0.7, 0.35, 0.7, this.C.white, PARTICLE_SHAPE.puff, -0.5, 2.2);
    }
    for (let i = 0; i < 4; i++) {
      this.p(x, y + 0.3, z, (r() - 0.5) * 2, 2 + r() * 1.5, (r() - 0.5) * 2, 0.8, 0.2, 0.1, this.C.star, PARTICLE_SHAPE.star, 3, 1);
    }
  }

  private sparkle(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    const r = Math.random;
    for (let i = 0; i < 7; i++) {
      const a = (i / 7) * Math.PI * 2;
      this.p(x + Math.cos(a) * 0.35, y, z + Math.sin(a) * 0.35, Math.cos(a) * 0.4, 1.6 + r(), Math.sin(a) * 0.4,
        0.6, 0.16, 0.05, i % 2 ? this.C.star : this.C.white, PARTICLE_SHAPE.star, 1, 1);
    }
  }

  /** Dust colour for a ground surface (island sand / grass; M2b wood, carpet, tile). */
  private dustColour(surface: GroundSurface): Rgb {
    switch (surface) {
      case 'grass': return this.C.grass;
      case 'wood': return this.C.plank;
      case 'carpet': return this.C.carpet;
      case 'tile': return this.C.tile;
      default: return this.C.sand;
    }
  }

  /** M2b: cream puff where a player left the carrier. */
  hatchPuff(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    const r = Math.random;
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      this.p(x, y, z, Math.cos(a) * 1.4, (r() - 0.5) * 0.6, Math.sin(a) * 1.4, 0.5, 0.3, 0.7, this.C.cream, PARTICLE_SHAPE.puff, -0.3, 2.5, 0.9);
    }
  }

  /** M2b: parachute pop, 4 cream cartoon smoke balls at the canopy (STYLE.md §20.2). */
  chutePop(x: number, y: number, z: number): void {
    if (this.far(x, y, z)) return;
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + 0.4;
      this.p(x + Math.cos(a) * 1.2, y, z + Math.sin(a) * 1.2, Math.cos(a) * 1.8, 0.6, Math.sin(a) * 1.8, 0.45, 0.45, 0.85, this.C.cream, PARTICLE_SHAPE.puff, 0, 3, 0.95);
    }
  }

  /** M2b sprinkler rain: a small white splash ring and two droplets on a floor or desk top. */
  rainSplash(x: number, y: number, z: number): void {
    if (this.far(x, y, z, FOOTSTEP_FX_DIST2 * 2)) return;
    const r = Math.random;
    this.p(x, y, z, 0, 0, 0, 0.3, 0.15, 0.6, this.C.rain, PARTICLE_SHAPE.ring, 0, 1, 0.7);
    for (let i = 0; i < 2; i++) this.p(x, y, z, (r() - 0.5) * 1.2, 1.2 + r(), (r() - 0.5) * 1.2, 0.3, 0.06, 0.03, this.C.rain, PARTICLE_SHAPE.puff, 12, 0.3, 0.8);
  }

  private landDust(pos: Vec3, fallSpeed: number, surface: GroundSurface, isLocal: boolean): void {
    if (this.far(pos.x, pos.y, pos.z)) return;
    if (surface === 'water') {
      this.splash(pos.x, Math.max(pos.y, 0.02), pos.z, 6 + Math.min(10, Math.round(fallSpeed)), Math.min(1.6, 0.6 + fallSpeed / 12));
      return;
    }
    const n = Math.min(16, 5 + Math.round(fallSpeed * 0.8)) + (isLocal ? 2 : 0);
    const c = this.dustColour(surface);
    const r = Math.random;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.3;
      const sp = 1.5 + Math.min(4, fallSpeed * 0.25) + r();
      this.p(pos.x + Math.cos(a) * 0.3, pos.y + 0.08, pos.z + Math.sin(a) * 0.3, Math.cos(a) * sp, 0.3 + r() * 0.5, Math.sin(a) * sp,
        0.55, 0.2, 0.42, c, PARTICLE_SHAPE.puff, 0.5, 3.5);
    }
  }

  private footPuff(pos: Vec3, n: number, surface: GroundSurface): void {
    if (this.far(pos.x, pos.y, pos.z, FOOTSTEP_FX_DIST2)) return;
    if (surface === 'water') {
      this.splash(pos.x, Math.max(pos.y, 0.02), pos.z, n + 1, 0.5);
      return;
    }
    const c = this.dustColour(surface);
    const r = Math.random;
    for (let i = 0; i < n; i++) {
      this.p(pos.x + (r() - 0.5) * 0.3, pos.y + 0.05, pos.z + (r() - 0.5) * 0.3, (r() - 0.5) * 0.6, 0.3 + r() * 0.3, (r() - 0.5) * 0.6,
        0.4, 0.12, 0.28, c, PARTICLE_SHAPE.puff, 0, 3, 0.9);
    }
  }

  update(dt: number): void {
    const c = this.host.cameraPosition;
    this.tracers.update(dt, c.x, c.y, c.z);
    this.particles.update(dt);
    this.decals.update(dt);
  }

  clear(): void {
    this.particles.clear();
    this.tracers.clear();
    this.decals.clear();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.particles.dispose();
    this.tracers.dispose();
    this.decals.dispose();
  }
}
