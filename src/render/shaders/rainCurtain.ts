/**
 * Office "Sprinkler" zone shaders (STYLE.md §19.5 option B). Owner: graphics-engineer.
 * - curtain: a soft cylinder of falling water on the circle (the tide wall's office cousin): pale blue body, white
 *   streaks scrolling DOWN, brighter near the floor and ceiling seams.
 * - rain: GPU line streaks in a camera-centred box, world-stable, falling at uSpeed, only outside the circle and
 *   stopped by desk tops (cover texture B channel = the walkable top under each texel).
 */
import { COVER_HEIGHT_STEP } from '../indoorFx';

export const rainCurtainVertex = /* glsl */ `
#include <common>
#include <fog_pars_vertex>
varying vec2 vUv;
void main() {
  vUv = uv;
  vec4 mvPosition = modelViewMatrix * vec4( position, 1.0 );
  gl_Position = projectionMatrix * mvPosition;
  #include <fog_vertex>
}
`;

export const rainCurtainFragment = /* glsl */ `
#include <common>
#include <fog_pars_fragment>
uniform float uTime;
uniform float uPulse;
uniform float uRadius;
uniform float uHeight;
uniform vec3 uColor;
uniform vec3 uStreak;
varying vec2 vUv;
float h1( float n ) { return fract( sin( n * 91.345 ) * 47453.5453 ); }
void main() {
  float cols = max( 16.0, floor( 6.2831853 * uRadius / 0.9 ) );
  float c = floor( vUv.x * cols );
  float r = h1( c );
  float y = vUv.y * uHeight;
  // Streak: a short bright dash per column, scrolling down at 9-15 m/s.
  float s = fract( ( y + uTime * ( 9.0 + 6.0 * r ) ) / ( 4.0 + 6.0 * h1( c + 7.0 ) ) + r );
  float lane = abs( fract( vUv.x * cols ) - 0.5 );
  float dash = step( 0.78, s ) * step( 0.45, r ) * ( 1.0 - smoothstep( 0.08, 0.14, lane ) );
  float edge = smoothstep( 0.06, 0.0, vUv.y ) + smoothstep( 0.94, 1.0, vUv.y );
  vec3 col = mix( uColor, uStreak, clamp( dash + edge * 0.6, 0.0, 1.0 ) );
  float a = 0.22 + 0.4 * dash + 0.3 * edge + 0.25 * uPulse;
  gl_FragColor = vec4( col, clamp( a, 0.0, 0.9 ) );
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
  #include <fog_fragment>
}
`;

export const rainVertex = /* glsl */ `
attribute vec4 aSeed;
uniform vec3 uCam;
uniform float uTime;
uniform float uBox;
uniform float uTopY;
uniform float uSpeed;
uniform float uLen;
uniform vec4 uZone;
uniform sampler2D uCoverTex;
uniform vec4 uCoverRect;
uniform float uCoverOn;
varying float vA;
void main() {
  vec2 seed = aSeed.xy * uBox;
  vec2 xz = uCam.xz + ( fract( ( seed - uCam.xz ) / uBox + 0.5 ) - 0.5 ) * uBox;
  float head = uTopY - fract( aSeed.z + uTime * uSpeed / uTopY ) * uTopY;
  float top = 0.0;
  if ( uCoverOn > 0.5 ) {
    vec2 cuv = ( xz - uCoverRect.xy ) * uCoverRect.zw;
    if ( cuv.x >= 0.0 && cuv.y >= 0.0 && cuv.x <= 1.0 && cuv.y <= 1.0 ) top = texture2D( uCoverTex, cuv ).b * ${(255 * COVER_HEIGHT_STEP).toFixed(3)};
  }
  float y = max( head - aSeed.w * uLen, top );
  float d = length( xz - uZone.xy );
  float a = uZone.w * smoothstep( uZone.z, uZone.z + 2.0, d );
  a *= step( top + 0.05, head );
  vec2 rel = abs( xz - uCam.xz ) / uBox;
  a *= 1.0 - smoothstep( 0.36, 0.5, max( rel.x, rel.y ) );
  vA = a;
  gl_Position = projectionMatrix * viewMatrix * vec4( xz.x, y, xz.y, 1.0 );
}
`;

export const rainFragment = /* glsl */ `
#include <common>
uniform vec3 uColor;
uniform float uOpacity;
varying float vA;
void main() {
  if ( vA < 0.01 ) discard;
  gl_FragColor = vec4( uColor, uOpacity * vA );
  #include <colorspace_fragment>
}
`;
