/**
 * Pooled point-sprite particles (one draw call for every puff, spark, star and flash). Owner: graphics-engineer.
 * Shapes (aShape): 0 puff, 1 star, 2 spark (diamond), 3 muzzle flash (4-ray burst with hot core), 4 ring.
 * Size is in world metres; the vertex shader converts to pixels with uScale = viewportHeightPx / (2 tan(fov/2)).
 */
export const PARTICLE_SHAPE = { puff: 0, star: 1, spark: 2, flash: 3, ring: 4 } as const;
export type ParticleShape = (typeof PARTICLE_SHAPE)[keyof typeof PARTICLE_SHAPE];

export const particleVertex = /* glsl */ `
attribute vec4 aColor;
attribute float aSize;
attribute float aShape;
attribute float aRot;
uniform float uScale;
uniform float uMaxPx;
varying vec4 vColor;
varying float vShape;
varying float vRot;
#include <fog_pars_vertex>

void main() {
  vec4 mvPosition = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mvPosition;
  gl_PointSize = min(aSize * uScale / max(-mvPosition.z, 0.05), uMaxPx);
  vColor = aColor;
  vShape = aShape;
  vRot = aRot;
  #include <fog_vertex>
}
`;

export const particleFragment = /* glsl */ `
uniform vec3 uInk;
varying vec4 vColor;
varying float vShape;
varying float vRot;
#include <common>
#include <fog_pars_fragment>

float starSdf(vec2 p, float r, float rf) {
  // 5-point star (iq), p in [-0.5, 0.5]
  const vec2 k1 = vec2(0.809016994375, -0.587785252292);
  const vec2 k2 = vec2(-k1.x, k1.y);
  p.x = abs(p.x);
  p -= 2.0 * max(dot(k1, p), 0.0) * k1;
  p -= 2.0 * max(dot(k2, p), 0.0) * k2;
  p.x = abs(p.x);
  p.y -= r;
  vec2 ba = rf * vec2(-k1.y, k1.x) - vec2(0.0, 1.0);
  float h = clamp(dot(p, ba) / dot(ba, ba), 0.0, r);
  return length(p - ba * h) * sign(p.y * ba.x - p.x * ba.y);
}

void main() {
  vec2 p = gl_PointCoord - 0.5;
  p.y = -p.y;
  float c = cos(vRot), s = sin(vRot);
  p = mat2(c, s, -s, c) * p;
  vec3 col = vColor.rgb;
  float a = vColor.a;
  int shape = int(vShape + 0.5);

  if (shape == 0) {
    float d = length(p);
    if (d > 0.5) discard;
    // Toon puff: lit cap + shaded crescent + thin ink rim.
    float shade = step(0.36, length(p - vec2(-0.1, 0.12)));
    col *= mix(1.0, 0.78, shade);
    col = mix(col, uInk, step(0.455, d) * 0.55);
  } else if (shape == 1) {
    float d = starSdf(p, 0.48, 0.45);
    if (d > 0.0) discard;
    col = mix(col, uInk, step(-0.04, d) * 0.8);
  } else if (shape == 2) {
    float d = abs(p.x) * 2.2 + abs(p.y);
    if (d > 0.5) discard;
    col = mix(col, vec3(1.0), step(d, 0.22));
  } else if (shape == 3) {
    float d = length(p);
    float rays = max(1.0 - abs(p.x) * 9.0 - abs(p.y) * 1.9, 1.0 - abs(p.y) * 9.0 - abs(p.x) * 1.9);
    float core = 1.0 - smoothstep(0.16, 0.2, d);
    float body = 1.0 - smoothstep(0.3, 0.33, d);
    float m = max(max(core, body), rays);
    if (m <= 0.0) discard;
    col = mix(col, vec3(1.0, 0.98, 0.85), core);
  } else {
    float d = length(p);
    if (d > 0.5 || d < 0.36) discard;
  }
  if (a < 0.01) discard;
  gl_FragColor = vec4(col, a);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
