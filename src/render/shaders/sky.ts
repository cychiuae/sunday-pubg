/**
 * Sky dome: vertical gradient (horizon -> zenith), hard-edged toon sun disc with a halo ring. Unlit, no fog,
 * not tone mapped so the horizon matches the fog colour exactly. Owner: graphics-engineer.
 */
export const skyVertex = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = normalize(position);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // pin to the far plane
}
`;

export const skyFragment = /* glsl */ `
uniform vec3 uTop;
uniform vec3 uHorizon;
uniform vec3 uSun;
uniform vec3 uSunDir;
varying vec3 vDir;

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, 0.0, 1.0);
  vec3 col = mix(uHorizon, uTop, pow(smoothstep(0.0, 0.55, h), 0.75));
  float s = dot(d, normalize(uSunDir));
  float aa = fwidth(s) * 1.5;
  float halo = smoothstep(0.9965 - aa, 0.9965 + aa, s);
  float disc = smoothstep(0.99935 - aa, 0.99935 + aa, s);
  col = mix(col, mix(col, uSun, 0.35), halo);
  col = mix(col, uSun, disc);
  gl_FragColor = vec4(col, 1.0);
  #include <tonemapping_fragment>
  #include <colorspace_fragment>
}
`;
