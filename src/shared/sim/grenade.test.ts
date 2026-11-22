import { describe, expect, it } from 'vitest';
import { BALANCE } from '../balance';
import { SIM_DT } from '../constants';
import { DEG2RAD, RAD2DEG } from '../math';
import type { PropPlacement, Vec3 } from '../types';
import { ISLAND } from '../../game/levels/island';
import { dropLaunch, explosionDamage, predictGrenadeArc, stepGrenade, throwLaunch, throwSpeedFor, type GrenadeBody } from './grenade';
import { createMovementContext } from './movement';
import { flatMap } from './testkit';

const b = BALANCE;
const g = b.items.grenade;
const flat = createMovementContext(flatMap(), b); // flat ground at y = 2
const EYE = (x = 0, z = 0): Vec3 => ({ x, y: 2 + b.player.eyeHeight, z });
const speed = (v: Vec3): number => Math.hypot(v.x, v.y, v.z);

/** Runs a body until the first contact; returns it with the tick count. */
function firstContact(body: GrenadeBody, ctx = flat, maxTicks = 300) {
  let cur = body;
  for (let i = 0; i < maxTicks; i++) {
    const r = stepGrenade(cur, SIM_DT, ctx);
    cur = r.body;
    if (r.contact) return { contact: r.contact, body: cur, ticks: i + 1 };
  }
  return null;
}

describe('grenade throw launch (grenades.md AT1, AT2)', () => {
  it('speed follows pitch: -40 -> 7, 0 -> 15, 35 and 60 -> 22; launch pitch = pitch + 8 (max 89)', () => {
    expect(throwSpeedFor(-40 * DEG2RAD, b)).toBeCloseTo(7, 9);
    expect(throwSpeedFor(0, b)).toBeCloseTo(15, 9);
    expect(throwSpeedFor(35 * DEG2RAD, b)).toBeCloseTo(22, 9);
    expect(throwSpeedFor(60 * DEG2RAD, b)).toBeCloseTo(22, 9);
    const l0 = throwLaunch(EYE(), 0, 0, false, flat);
    expect(speed(l0.vel)).toBeCloseTo(15, 9);
    expect(Math.asin(l0.vel.y / speed(l0.vel)) * RAD2DEG).toBeCloseTo(8, 6);
    const l60 = throwLaunch(EYE(), 0, 60 * DEG2RAD, false, flat);
    expect(Math.asin(l60.vel.y / speed(l60.vel)) * RAD2DEG).toBeCloseTo(68, 6);
    // Origin: eye + aim x throwOriginForward (yaw 0 = -Z).
    expect(l0.pos.z).toBeCloseTo(-g.throwOriginForward, 9);
  });

  it('settled prone at pitch 35 throws at 22 x 0.6 = 13.2 (AT2)', () => {
    expect(speed(throwLaunch(EYE(), 0, 35 * DEG2RAD, true, flat).vel)).toBeCloseTo(13.2, 9);
  });

  it('a pitch-0 quick throw first lands 8.0 +- 0.5 m away (AT1)', () => {
    const l = throwLaunch(EYE(), 0, 0, false, flat);
    const c = firstContact({ ...l, inWater: false })!;
    expect(c.contact.surface).toBe('terrain');
    expect(Math.hypot(c.contact.pos.x, c.contact.pos.z)).toBeGreaterThan(7.5);
    expect(Math.hypot(c.contact.pos.x, c.contact.pos.z)).toBeLessThan(8.5);
  });

  it('the origin is pulled back before a wall in front of the eye', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: -0.8, rotY: 0, scale: 3 };
    const ctx = createMovementContext(flatMap({}, [crate]), b);
    const l = throwLaunch({ x: 0, y: 2.5, z: 0 }, 0, 0, false, ctx);
    // Crate face at z = -0.8 + 1.5 = 0.7 is behind the eye, so the eye is inside its footprint: origin stays at the eye.
    expect(l.pos.z).toBeCloseTo(0, 9);
  });

  it('dropLaunch: eye position, horizontal look direction x dropOnSwitchSpeed (AT10)', () => {
    const d = dropLaunch(EYE(), Math.PI / 2, flat);
    expect(d.pos).toEqual(EYE());
    expect(Math.hypot(d.vel.x, d.vel.z)).toBeCloseTo(g.dropOnSwitchSpeed, 9);
    expect(d.vel.y).toBe(0);
  });
});

describe('grenade flight physics', () => {
  it('drop from 3 m: bounce with impact ~9.5 m/s, rebound ~35%, rests within 4 contacts (AT12)', () => {
    let body: GrenadeBody = { pos: { x: 0, y: 2 + 3, z: 0 }, vel: { x: 0, y: 0, z: 0 }, inWater: false };
    const contacts: { speed: number; after: number }[] = [];
    for (let i = 0; i < 300 && contacts.length < 10; i++) {
      const r = stepGrenade(body, SIM_DT, flat);
      body = r.body;
      if (r.contact) contacts.push({ speed: r.contact.speed, after: speed(body.vel) });
      if (speed(body.vel) === 0 && r.contact) break;
    }
    expect(contacts[0]!.speed).toBeGreaterThan(9);
    expect(contacts[0]!.speed).toBeLessThan(10.1);
    expect(contacts[0]!.speed).toBeGreaterThanOrEqual(g.bounceEventMinSpeed);
    expect(contacts[0]!.after / contacts[0]!.speed).toBeCloseTo(g.restitution, 2);
    expect(contacts.length).toBeLessThanOrEqual(4);
    expect(speed(body.vel)).toBe(0);
    expect(body.pos.y).toBeCloseTo(2 + g.collisionRadius, 3);
    // Later (small) impacts are below the event threshold.
    expect(contacts.slice(1).every((c) => c.speed < contacts[0]!.speed)).toBe(true);
    // A resting grenade stays put.
    const still = stepGrenade(body, SIM_DT, flat);
    expect(still.body.pos).toEqual(body.pos);
    expect(still.contact).toBeNull();
  });

  it('water entry: one damping and a water contact, then sinks and rests on the seabed (AT13)', () => {
    const sea = createMovementContext(flatMap({ baseHeight: -0.6 }), b);
    let body: GrenadeBody = { pos: { x: 0, y: 1.5, z: 0 }, vel: { x: 0, y: -5, z: 3 }, inWater: false };
    const surfaces: string[] = [];
    for (let i = 0; i < 200; i++) {
      const before = body;
      const r = stepGrenade(body, SIM_DT, sea);
      body = r.body;
      if (r.contact) {
        surfaces.push(r.contact.surface);
        if (r.contact.surface === 'water') {
          expect(body.inWater).toBe(true);
          expect(body.pos.y).toBe(0);
          expect(Math.abs(body.vel.z - before.vel.z * g.waterVelocityDamping)).toBeLessThan(1e-9);
        }
      }
      if (speed(body.vel) === 0) break;
    }
    expect(surfaces.filter((s) => s === 'water')).toEqual(['water']);
    expect(surfaces[0]).toBe('water');
    expect(body.pos.y).toBeCloseTo(-0.6 + g.collisionRadius, 3);
  });

  it('bounces off a crate side with a horizontal normal and off the world edge wall', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: -3, rotY: 0, scale: 1 };
    const ctx = createMovementContext(flatMap({}, [crate]), b);
    const c = firstContact({ pos: { x: 0, y: 2.8, z: 0 }, vel: { x: 0, y: 0, z: -15 }, inWater: false }, ctx)!;
    expect(c.contact.surface).toBe('prop');
    expect(c.contact.pos.z).toBeCloseTo(-2.5, 3);
    expect(c.body.vel.z).toBeGreaterThan(0); // reflected
    const edge = flatMap();
    const ectx = createMovementContext(edge, b);
    const e = firstContact({ pos: { x: edge.worldRadius - 1, y: 5, z: 0 }, vel: { x: 20, y: 0, z: 0 }, inWater: false }, ectx)!;
    expect(e.contact.surface).toBe('edge');
    expect(e.body.vel.x).toBeLessThan(0);
  });

  it('rests on a crate top (+Y normal)', () => {
    const crate: PropPlacement = { kind: 'crate', x: 0, z: 0, rotY: 0, scale: 1 };
    const ctx = createMovementContext(flatMap({}, [crate]), b);
    let body: GrenadeBody = { pos: { x: 0, y: 4, z: 0 }, vel: { x: 0, y: 0, z: 0 }, inWater: false };
    for (let i = 0; i < 200; i++) body = stepGrenade(body, SIM_DT, ctx).body;
    expect(speed(body.vel)).toBe(0);
    expect(body.pos.y).toBeCloseTo(3 + g.collisionRadius, 6);
  });

  it('is deterministic and pure: same launch => identical path (AT14)', () => {
    const ctx = createMovementContext(ISLAND, b);
    const launch = throwLaunch({ x: 10, y: 6, z: 5 }, 0.7, 0.3, false, ctx);
    const frozen = JSON.stringify(launch);
    const a = predictGrenadeArc(launch, g.fuseMs, ctx, 4);
    const c = predictGrenadeArc(launch, g.fuseMs, ctx, 4);
    expect(JSON.stringify(a)).toBe(JSON.stringify(c));
    expect(JSON.stringify(launch)).toBe(frozen);
  });
});

describe('arc preview', () => {
  it('one point per tick from the launch; ends on fuse, rest or time', () => {
    const l = throwLaunch(EYE(), 0, 0, false, flat);
    const fuse = predictGrenadeArc(l, 500, flat, 5);
    expect(fuse.endReason).toBe('fuse');
    expect(fuse.points.length).toBe(Math.ceil(500 / (SIM_DT * 1000)) + 1);
    expect(fuse.points[0]).toEqual(l.pos);
    const rest = predictGrenadeArc(dropLaunch(EYE(), 0, flat), g.fuseMs, flat, 5);
    expect(rest.endReason).toBe('rest');
    const time = predictGrenadeArc(l, g.fuseMs, flat, 0.2);
    expect(time.endReason).toBe('time');
    expect(time.points.length).toBe(7);
  });

  it('matches the World path tick for tick (same stepGrenade)', () => {
    const l = throwLaunch(EYE(), 0.3, 0.1, false, flat);
    const arc = predictGrenadeArc(l, g.fuseMs, flat, 2);
    let body: GrenadeBody = { pos: { ...l.pos }, vel: { ...l.vel }, inWater: false };
    for (let i = 1; i < arc.points.length; i++) {
      body = stepGrenade(body, SIM_DT, flat).body;
      expect(body.pos).toEqual(arc.points[i]);
    }
  });
});

describe('explosion falloff (grenades.md AT5)', () => {
  it('140 / 119 / 92.75 / 66.5 / 40.25 / 14 / 0 at 1 / 2 / 3 / 4 / 5 / 6 / 6.1 m (balance v9)', () => {
    const max = b.items.grenade.maxDamage;
    expect(max).toBe(140);
    // Fraction of maxDamage: 1 inside innerRadius (1.2), linear to minDamageFactor (0.1) at radius (6), 0 beyond.
    const cases: [number, number][] = [
      [1, 1],
      [1.2, 1],
      [2, 0.85],
      [3, 0.6625],
      [4, 0.475],
      [5, 0.2875],
      [6, 0.1],
      [6.1, 0],
    ];
    for (const [d, f] of cases) expect(explosionDamage(d, b), `${d} m`).toBeCloseTo(max * f, 9);
    expect(explosionDamage(3, b)).toBeCloseTo(92.75, 9);
  });
});
