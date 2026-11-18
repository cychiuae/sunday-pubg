/**
 * Event-driven VFX (bus subscriber only; never emits). Owner: graphics-engineer.
 * shotFired -> muzzle flash + tracer per impact (impact puff when the tracer arrives); playerDamaged -> hit react,
 * headshot star; playerKilled -> topple then poof; itemPickedUp -> sparkle; land/jump/footstep -> dust or splash;
 * zoneChanged -> tide wall pulse. Everything pooled: no allocation per shot.
 */
import type * as THREE from 'three';
import type { EventBus, GameEvents } from '../../shared/events';
import type { ImpactSurface, Surface, Vec3 } from '../../shared/types';
import { PARTICLE_SHAPE } from '../shaders/particles';
import { palette } from '../procedural';
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
  surfaceAt(x: number, z: number): Surface;
  pulseTide(): void;
  /** Player body height (balance player.height), for head/chest effect anchors. */
  playerHeight: number;
}

const SURFACE_CODE: Record<ImpactSurface, number> = { none: 0, player: 1, terrain: 2, prop: 3, water: 4 };
const MAX_FX_DIST2 = 160 * 160;
const FOOTSTEP_FX_DIST2 = 35 * 35;

type Rgb = [number, number, number];

export class Vfx {
  readonly particles: ParticleSystem;
  readonly tracers: TracerSystem;
  private readonly unsubs: (() => void)[] = [];
  private readonly spec: ParticleSpec = makeSpec();
  private readonly muzzle: Vec3 = { x: 0, y: 0, z: 0 };
  private readonly C: Record<string, Rgb>;

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
    };

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
    const big = e.weapon === 'shotgun' ? 1.4 : e.weapon === 'pistol' ? 0.8 : 1;
    this.p(m.x + fx * 0.06, m.y + fy * 0.06, m.z + fz * 0.06, 0, 0, 0, 0.06, 0.42 * big, 0.55 * big, this.C.flash, PARTICLE_SHAPE.flash, 0, 0);
    for (let i = 0; i < 3; i++) {
      const sp = 5 + Math.random() * 4;
      this.p(m.x, m.y, m.z, fx * sp + (Math.random() - 0.5) * 2, fy * sp + Math.random(), fz * sp + (Math.random() - 0.5) * 2,
        0.12, 0.07, 0.02, this.C.flashEdge, PARTICLE_SHAPE.spark, 6, 2);
    }
    const width = e.weapon === 'shotgun' ? 0.035 : e.weapon === 'rifle' ? 0.06 : 0.045;
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
      case SURFACE_CODE.terrain: {
        const grass = this.host.surfaceAt(x, z) === 'grass';
        const c = grass ? this.C.grass : this.C.sand;
        for (let i = 0; i < 3; i++) {
          this.p(x, y + 0.05, z, (r() - 0.5) * 1.5, r() * 1.5 + 0.5, (r() - 0.5) * 1.5, 0.45, 0.16, 0.38, c, PARTICLE_SHAPE.puff, 2, 2.5);
        }
        for (let i = 0; i < 3; i++) {
          this.p(x, y + 0.05, z, (r() - 0.5) * 3, r() * 3 + 2, (r() - 0.5) * 3, 0.4, 0.06, 0.04, grass ? this.C.grass : this.C.sandDark, PARTICLE_SHAPE.spark, 14, 0.5);
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

  private landDust(pos: Vec3, fallSpeed: number, surface: Surface, isLocal: boolean): void {
    if (this.far(pos.x, pos.y, pos.z)) return;
    if (surface === 'water') {
      this.splash(pos.x, Math.max(pos.y, 0.02), pos.z, 6 + Math.min(10, Math.round(fallSpeed)), Math.min(1.6, 0.6 + fallSpeed / 12));
      return;
    }
    const n = Math.min(16, 5 + Math.round(fallSpeed * 0.8)) + (isLocal ? 2 : 0);
    const c = surface === 'grass' ? this.C.grass : this.C.sand;
    const r = Math.random;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2 + r() * 0.3;
      const sp = 1.5 + Math.min(4, fallSpeed * 0.25) + r();
      this.p(pos.x + Math.cos(a) * 0.3, pos.y + 0.08, pos.z + Math.sin(a) * 0.3, Math.cos(a) * sp, 0.3 + r() * 0.5, Math.sin(a) * sp,
        0.55, 0.2, 0.42, c, PARTICLE_SHAPE.puff, 0.5, 3.5);
    }
  }

  private footPuff(pos: Vec3, n: number, surface: Surface): void {
    if (this.far(pos.x, pos.y, pos.z, FOOTSTEP_FX_DIST2)) return;
    if (surface === 'water') {
      this.splash(pos.x, Math.max(pos.y, 0.02), pos.z, n + 1, 0.5);
      return;
    }
    const c = surface === 'grass' ? this.C.grass : this.C.sand;
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
  }

  clear(): void {
    this.particles.clear();
    this.tracers.clear();
  }

  dispose(): void {
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.particles.dispose();
    this.tracers.dispose();
  }
}
