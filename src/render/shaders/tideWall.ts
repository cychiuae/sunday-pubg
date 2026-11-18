/**
 * The tide wall: translucent animated water curtain on an open unit cylinder scaled to the zone radius.
 * Scrolling diagonal toon stripes, a churning foam skirt where it meets terrain or sea, fade toward the top, and a
 * brighter rim when seen edge-on. Rendered double-sided so it reads from inside and outside. Owner: graphics-engineer.
 */
export const tideWallVertex = /* glsl */ `
uniform float uRadius;
uniform float uTime;
varying vec3 vWorld;
varying float vArc;
varying float vV;
varying vec3 vNormalW;
#include <fog_pars_vertex>

void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  // Gentle ripple so the wall is not a perfect tube.
  float ang = atan(position.z, position.x);
  float wob = sin(ang * 23.0 + uTime * 1.7) * 0.25 + sin(ang * 7.0 - uTime * 0.9) * 0.35;
  wp.xz += normalize(position.xz + 1e-5) * wob * uv.y;
  vWorld = wp.xyz;
  vArc = ang * uRadius;
  vV = uv.y;
  vNormalW = normalize(vec3(position.x, 0.0, position.z));
  vec4 mvPosition = viewMatrix * wp;
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const tideWallFragment = /* glsl */ `
uniform float uTime;
uniform float uPulse;
uniform vec3 uColor;
uniform vec3 uFoam;
uniform sampler2D uHeightTex;
uniform vec4 uHeightRect;
varying vec3 vWorld;
varying float vArc;
varying float vV;
varying vec3 vNormalW;
#include <common>
#include <fog_pars_fragment>

float groundHeight(vec2 xz) {
  vec2 uv = (xz - uHeightRect.xy) * uHeightRect.w;
  if (uv.x < 0.0 || uv.y < 0.0 || uv.x > 1.0 || uv.y > 1.0) return 0.0;
  return max(texture2D(uHeightTex, uv).r, 0.0);
}

void main() {
  float above = vWorld.y - groundHeight(vWorld.xz);
  if (above < -0.05) discard;

  // Diagonal stripes scrolling upward.
  float s = fract(vArc * 0.12 + vWorld.y * 0.18 - uTime * 0.35);
  float stripe = smoothstep(0.0, 0.04, s) - smoothstep(0.42, 0.46, s);
  float s2 = fract(vArc * 0.05 - vWorld.y * 0.08 + uTime * 0.12);
  float stripe2 = smoothstep(0.0, 0.03, s2) - smoothstep(0.12, 0.15, s2);

  float fade = 1.0 - smoothstep(0.15, 1.0, vV);
  vec3 col = uColor;
  float alpha = 0.22 + 0.18 * stripe + 0.12 * stripe2;

  // Edge-on rim (fresnel against the wall normal).
  vec3 V = normalize(cameraPosition - vWorld);
  float rim = pow(1.0 - abs(dot(V, vNormalW)), 3.0);
  alpha += rim * 0.35;
  col = mix(col, uFoam, rim * 0.5 + stripe * 0.15);

  // Foam skirt at the contact line.
  float skirt = 0.9 + 0.35 * sin(vArc * 0.9 + uTime * 3.0) + 0.25 * sin(vArc * 2.3 - uTime * 2.1);
  float foam = 1.0 - smoothstep(skirt - 0.06, skirt + 0.06, above);
  col = mix(col, uFoam, foam);
  alpha = mix(alpha, 0.95, foam);

  alpha = alpha * fade * (1.0 + uPulse * 0.8);
  col = mix(col, uFoam, uPulse * 0.4);
  gl_FragColor = vec4(col, clamp(alpha, 0.0, 1.0));
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;
