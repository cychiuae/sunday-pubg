/**
 * Stylised toon water. Owner: graphics-engineer.
 * - Depth = water surface y - terrain height (baked half-float height texture, see heightField.ts).
 * - Hard-edged colour bands shallow -> mid -> deep -> abyss, fake sky reflection by fresnel.
 * - Shoreline foam (animated swash), a second foam line rolling toward the beach, a faint broken foam line at the
 *   world boundary (near the camera only), and sun-glint sparkles. Gentle vertex waves fading out toward the horizon.
 * Defines: WATER_DETAIL (sparkle + second foam line + waves).
 */
export const waterVertex = /* glsl */ `
uniform float uTime;
uniform float uWaveAmp;
varying vec3 vWorld;
#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  #ifdef WATER_DETAIL
    float r = length(wp.xz);
    float att = 1.0 - smoothstep(190.0, 320.0, r);
    float w = sin(wp.x * 0.21 + uTime * 1.3) * 0.5
            + sin(wp.z * 0.17 - uTime * 1.05) * 0.35
            + sin((wp.x + wp.z) * 0.37 + uTime * 2.1) * 0.15;
    wp.y += w * uWaveAmp * att;
  #endif
  vWorld = wp.xyz;
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const waterFragment = /* glsl */ `
uniform float uTime;
uniform vec3 uShallow;
uniform vec3 uMid;
uniform vec3 uDeep;
uniform vec3 uAbyss;
uniform vec3 uFoam;
uniform vec3 uSky;
uniform vec3 uSunDir;
uniform float uGlintCut;
uniform vec3 uGlintColor;
uniform sampler2D uHeightTex;
uniform vec4 uHeightRect; // minX, minZ, size, 1/size
uniform float uWorldRadius;
varying vec3 vWorld;

#include <common>
#include <fog_pars_fragment>

float hash12(vec2 p) {
  vec3 p3 = fract(vec3(p.xyx) * 0.1031);
  p3 += dot(p3, p3.yzx + 33.33);
  return fract((p3.x + p3.y) * p3.z);
}
float vnoise(vec2 p) {
  vec2 i = floor(p);
  vec2 f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash12(i), hash12(i + vec2(1.0, 0.0)), u.x),
             mix(hash12(i + vec2(0.0, 1.0)), hash12(i + vec2(1.0, 1.0)), u.x), u.y);
}
// Outside the baked square the texture clamps to its edge, which is the flat reef-floor depth (already in the
// abyss band). A hard jump to a far-away depth there made fwidth(depth) spike and drew a one-pixel foam line along
// the square's edge: the "white dashes near the horizon".
float terrainHeight(vec2 xz) {
  vec2 uv = clamp((xz - uHeightRect.xy) * uHeightRect.w, 0.0, 1.0);
  return texture2D(uHeightTex, uv).r;
}
float band(float edge, float x, float aa) { return smoothstep(edge - aa, edge + aa, x); }

void main() {
  float depth = vWorld.y - terrainHeight(vWorld.xz);
  // Clamped so a steep depth change seen at a grazing angle cannot widen the foam band into a stripe.
  float aa = clamp(fwidth(depth), 0.002, 0.35);

  // Toon depth bands.
  vec3 col = uShallow;
  col = mix(col, uMid, band(0.55, depth, aa));
  col = mix(col, uDeep, band(1.9, depth, aa));
  col = mix(col, uAbyss, band(5.5, depth, aa * 2.0));

  // Fake reflection: grazing angles pick up the sky horizon colour.
  vec3 V = normalize(cameraPosition - vWorld);
  float fres = pow(1.0 - clamp(V.y, 0.0, 1.0), 5.0);
  col = mix(col, uSky, fres * 0.6);

  float foam = 0.0;
  float n = vnoise(vWorld.xz * 0.35 + vec2(uTime * 0.05, 0.0));
  // Shoreline swash band.
  float swash = 0.16 + 0.1 * sin(uTime * 1.4 + n * 6.2831);
  foam = max(foam, 1.0 - band(swash, depth, aa));
  #ifdef WATER_DETAIL
    // Second foam line rolling in toward the beach, broken up by noise.
    float roll = fract(depth * 1.1 + uTime * 0.28);
    float rollMask = (1.0 - band(1.3, depth, aa)) * step(0.45, vnoise(vWorld.xz * 0.6 - uTime * 0.1));
    foam = max(foam, rollMask * (band(0.0, roll, 0.02) - band(0.08, roll, 0.02)));
  #endif
  // World boundary: a soft, broken line of drifting surface foam. Only drawn near the camera (it fades out by
  // 55 m), so from the island it never reads as white dashes floating at the horizon. Width is anti-aliased in
  // screen space and the line wobbles with the noise so it looks like foam riding the waves, not a painted rope.
  float r = length(vWorld.xz) + (n - 0.5) * 0.5;
  float raa = max(fwidth(r), 0.01);
  float edge = 1.0 - smoothstep(0.35 - raa, 0.35 + raa, abs(r - uWorldRadius));
  float fleck = smoothstep(0.42, 0.58, vnoise(vWorld.xz * 0.8 + vec2(uTime * 0.12, -uTime * 0.09)));
  float nearCam = 1.0 - smoothstep(30.0, 55.0, length(cameraPosition.xz - vWorld.xz));
  foam = max(foam, edge * fleck * nearCam * 0.6);

  #ifdef WATER_DETAIL
    // Sun glint sparkles: flat per-pixel normal from the displaced surface.
    vec3 N = normalize(cross(dFdx(vWorld), dFdy(vWorld)));
    if (N.y < 0.0) N = -N;
    vec3 R = reflect(-uSunDir, N);
    float spec = max(dot(R, V), 0.0);
    // A round glint inside each lucky 0.4 m cell (square cells read as floor tiles up close).
    vec2 sc = vWorld.xz * 2.5;
    float cell = hash12(floor(sc) + floor(uTime * 3.0));
    float glint = 1.0 - smoothstep(0.12, 0.22, length(fract(sc) - 0.5));
    float sparkle = step(uGlintCut, cell) * glint * step(0.6, spec) * (1.0 - band(60.0, length(cameraPosition - vWorld), 20.0));
    col = mix(col, uGlintColor, sparkle);
  #endif

  col = mix(col, uFoam, foam);
  float alpha = mix(0.5, 1.0, smoothstep(0.0, 2.4, depth));
  alpha = max(alpha, foam);
  #ifdef WATER_DETAIL
    alpha = max(alpha, sparkle);
  #endif

  gl_FragColor = vec4(col, alpha);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
