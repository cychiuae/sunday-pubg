/**
 * Sound recipes: one synthesis function per cue. Each builds its layers into `v.out` starting at `v.t` and returns
 * its length in seconds (loops return v.durationS). Sonic identity: docs/audio/AUDIO.md section 1.
 * Owner: audio-designer. No audio files: everything is oscillators and filtered noise.
 */
import { AUDIO_TUNING, type CueId } from './cues';
import { bell, click, envelope, filterNode, gainNode, lfo, loopNoise, midiHz, noise, pluck, tone, type Voice } from './synth';

export type Recipe = (v: Voice) => number;

/** Per-weapon pitch for mechanical sounds (switch, reload, pickup, dry fire). */
const WEAPON_PITCH: Record<string, number> = {
  fists: 1, pistol: 1.2, smg: 1.1, shotgun: 0.8, rifle: 0.92, lmg: 0.74, dmr: 0.97, sniper: 0.86, grenade: 1.3,
};
const wp = (v: Voice): number => WEAPON_PITCH[v.variant] ?? 1;

/** 0 up close, 1 at 150 m: drives the distant "tail" layer of gunshots. */
const farness = (v: Voice): number => Math.min(1, Math.max(0, (v.distance - 30) / 120));

/** Low rumbling tail that makes far gunfire read as far (on top of the engine's air-absorption low-pass). */
function distantTail(v: Voice, gain: number): number {
  const far = farness(v);
  if (far <= 0) return 0;
  return noise(v, { color: 'brown', filter: 'lowpass', freq: 520, q: 0.5, at: 0.03, attack: 0.03, decay: 0.25 + 0.35 * far, gain: gain * far });
}

/** Oscillator the caller wires up itself (for vibrato / custom pitch curves). Started and registered. */
function rawOsc(v: Voice, type: OscillatorType, at: number, until: number): OscillatorNode {
  const osc = v.ctx.createOscillator();
  osc.type = type;
  osc.start(v.t + at);
  osc.stop(v.t + until + 0.02);
  v.addSource(osc);
  v.addNode(osc);
  return osc;
}

/** Envelope gain stage (registered). */
function envGain(v: Voice, dest: AudioNode, at: number, peak: number, attack: number, hold: number, decay: number): [GainNode, number] {
  const g = gainNode(v, 0, dest);
  const end = envelope(g.gain, v.t + at, peak, attack, hold, decay);
  return [g, end - v.t];
}

/** Lifeguard whistle: sine with a fast pea-trill. */
function whistle(v: Voice, at: number, dur: number, gain: number, freq = 2500): number {
  const [g, end] = envGain(v, v.out, at, gain, 0.01, dur, 0.05);
  const osc = rawOsc(v, 'sine', at, end);
  osc.frequency.value = freq * v.pitch;
  osc.connect(g);
  lfo(v, osc.frequency, 27, 150 * v.pitch, v.t + end, 'square');
  return end;
}

/** Conch-shell horn note: detuned saws through a low-pass with vibrato. */
function hornNote(v: Voice, at: number, freq: number, hold: number, gain: number): number {
  const lp = filterNode(v, 'lowpass', 850, 0.9, v.out);
  const [g, end] = envGain(v, lp, at, gain, 0.14, hold, 0.35);
  for (const [ratio, level] of [[1, 1], [1.006, 0.9], [1.5, 0.5]] as const) {
    const osc = rawOsc(v, 'sawtooth', at, end);
    osc.frequency.value = freq * ratio * v.pitch;
    const lvl = gainNode(v, level / 3, g);
    osc.connect(lvl);
    lfo(v, osc.frequency, 5, 2.5, v.t + end);
  }
  return end;
}

/** Sad-trombone-ish brass note (defeat sting). */
function brassNote(v: Voice, at: number, freq: number, hold: number, gain: number, vibrato: number): number {
  const lp = filterNode(v, 'lowpass', 700, 1.5, v.out);
  lp.frequency.setValueAtTime(500, v.t + at);
  lp.frequency.linearRampToValueAtTime(1300, v.t + at + 0.08);
  lp.frequency.linearRampToValueAtTime(700, v.t + at + hold + 0.2);
  const [g, end] = envGain(v, lp, at, gain, 0.04, hold, 0.18);
  const osc = rawOsc(v, 'sawtooth', at, end);
  osc.frequency.value = freq * v.pitch;
  osc.connect(g);
  if (vibrato > 0) lfo(v, osc.frequency, 5.5, vibrato, v.t + end);
  return end;
}

/** Seagull "kyow": triangle with a rise-fall pitch curve through a band-pass. */
function gullCall(v: Voice, at: number): number {
  const bp = filterNode(v, 'bandpass', 2000, 1.4, v.out);
  const [g, end] = envGain(v, bp, at, 0.6, 0.02, 0.08, 0.09);
  const osc = rawOsc(v, 'triangle', at, end);
  const t0 = v.t + at;
  osc.frequency.setValueAtTime(1450 * v.pitch, t0);
  osc.frequency.linearRampToValueAtTime(2300 * v.pitch, t0 + 0.05);
  osc.frequency.exponentialRampToValueAtTime(1550 * v.pitch, t0 + 0.18);
  osc.connect(g);
  noise(v, { filter: 'bandpass', freq: 2600, q: 2, at, attack: 0.02, decay: 0.12, gain: 0.06 });
  return end;
}

function crackle(v: Voice, at: number, count: number, span: number, lo: number, hi: number, gain: number): number {
  let end = 0;
  for (let i = 0; i < count; i++) {
    const t = at + v.rand() * span;
    end = Math.max(end, click(v, t, lo + v.rand() * (hi - lo), gain * (0.6 + 0.4 * v.rand()), 5, 0.01));
  }
  return end;
}

function splash(v: Voice, at: number, gain: number, len: number): number {
  let end = noise(v, { filter: 'bandpass', freq: 2000, freqEnd: 550, glide: len * 0.8, q: 0.8, at, attack: 0.01, decay: len, gain });
  for (let i = 0; i < 3; i++) {
    const f = 900 + v.rand() * 900;
    end = Math.max(end, tone(v, { freq: f, freqEnd: f * 1.6, glide: 0.04, at: at + 0.06 + v.rand() * len * 0.6, decay: 0.04, gain: gain * 0.18 }));
  }
  return end;
}

/**
 * Surface layer shared by footsteps and landings. `g` scales loudness, `len` scales length.
 * M2b indoor floors (FloorMaterial): wood = a hollow knock, carpet = a soft muffled pad (quieter but still a
 * readable thump), tile = a hard heel click with a short ring.
 */
function surfaceStep(v: Voice, g: number, len: number): number {
  switch (v.variant) {
    case 'wood':
      return Math.max(
        tone(v, { type: 'triangle', freq: 190 + v.rand() * 30, freqEnd: 140, glide: 0.04, decay: 0.07 * len, gain: 0.45 * g }),
        noise(v, { filter: 'bandpass', freq: 1700, q: 1.4, attack: 0.002, decay: 0.035 * len, gain: 0.35 * g }),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 320, attack: 0.003, decay: 0.05 * len, gain: 0.35 * g }),
      );
    case 'carpet':
      return Math.max(
        noise(v, { color: 'brown', filter: 'lowpass', freq: 420, attack: 0.008, decay: 0.08 * len, gain: 0.6 * g }),
        noise(v, { color: 'pink', filter: 'bandpass', freq: 750, q: 0.7, attack: 0.01, decay: 0.06 * len, gain: 0.22 * g }),
        tone(v, { freq: 95, decay: 0.04, gain: 0.25 * g }),
      );
    case 'tile':
      return Math.max(
        click(v, 0, 3400 + v.rand() * 600, 0.55 * g, 3, 0.018),
        tone(v, { type: 'triangle', freq: 2300 + v.rand() * 300, at: 0.002, decay: 0.03 * len, gain: 0.07 * g }),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 300, attack: 0.002, decay: 0.04 * len, gain: 0.35 * g }),
      );
    case 'water':
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 1600, freqEnd: 700, glide: 0.12 * len, q: 1.2, attack: 0.01, decay: 0.14 * len, gain: 0.6 * g }),
        tone(v, { freq: 900 + v.rand() * 700, freqEnd: 1700, glide: 0.04, at: 0.03, decay: 0.04, gain: 0.12 * g }),
      );
    case 'grass':
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 3200, q: 0.8, attack: 0.01, decay: 0.07 * len, gain: 0.4 * g }),
        noise(v, { color: 'pink', filter: 'highpass', freq: 1800, attack: 0.004, decay: 0.05 * len, gain: 0.25 * g }),
        tone(v, { freq: 120, decay: 0.03, gain: 0.25 * g }),
      );
    default: // sand
      return Math.max(
        noise(v, { color: 'pink', filter: 'bandpass', freq: 1100, q: 0.9, attack: 0.006, decay: 0.07 * len, gain: 0.65 * g }),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 280, attack: 0.004, decay: 0.05 * len, gain: 0.55 * g }),
      );
  }
}

function footstep(v: Voice): number {
  const g = 0.6 + 0.4 * v.intensity;
  return surfaceStep(v, g, 1.2 - 0.3 * v.intensity);
}

function landing(v: Voice): number {
  const i = v.intensity;
  const thud = tone(v, { freq: 110, freqEnd: 45, glide: 0.1, decay: 0.08 + 0.12 * i, gain: 0.3 + 0.6 * i });
  const surf = v.variant === 'water' ? splash(v, 0, 0.4 + 0.5 * i, 0.2 + 0.3 * i) : surfaceStep(v, 0.7 + 0.6 * i, 1.2 + 0.6 * i);
  return Math.max(thud, surf);
}

function oof(v: Voice, at: number, gain: number): number {
  return tone(v, { type: 'sawtooth', freq: 190, freqEnd: 120, glide: 0.12, at, attack: 0.01, decay: 0.12, gain, lowpass: 800 });
}

function armorShatter(v: Voice, low: number): number {
  return Math.max(
    crackle(v, 0, 7, 0.12, 1800 * low, 4500 * low, 0.45),
    noise(v, { filter: 'highpass', freq: 2500 * low, attack: 0.002, decay: 0.22, gain: 0.35 }),
    tone(v, { freq: 1100 * low, freqEnd: 350 * low, glide: 0.2, decay: 0.22, gain: 0.3 }),
    tone(v, { type: 'triangle', freq: 1500 * low, decay: 0.06, gain: 0.25 }),
  );
}

const AMMO_CLICK_HZ: Record<string, number> = { ammo_light: 3200, ammo_heavy: 2200, ammo_shell: 1500, ammo_sniper: 1800 };

/** Armor tier 1..3 from a variant ending in the tier digit (`vest2`, `helmet_3`); 1 when absent. */
function tierOf(v: Voice): number {
  const n = Number(v.variant.slice(-1));
  return n >= 1 && n <= 3 ? n : 1;
}
/** Armor clinks rise in pitch with tier (armor.md). */
const tierPitch = (v: Voice): number => 1 + 0.14 * (tierOf(v) - 1);

/** Vest hit: fabric "thup" over a plate clink. */
function vestClink(v: Voice, g: number): number {
  const p = tierPitch(v);
  return Math.max(
    noise(v, { color: 'pink', filter: 'bandpass', freq: 900, q: 1.2, decay: 0.06, gain: 0.45 * g }),
    tone(v, { type: 'triangle', freq: 820 * p, decay: 0.08, gain: 0.3 * g }),
    tone(v, { type: 'triangle', freq: 1240 * p, at: 0.004, decay: 0.06, gain: 0.18 * g }),
    click(v, 0, 2800 * p, 0.3 * g),
  );
}

/** Helmet hit: a hollow coconut-shell "tonk" with a short metallic ring. */
function helmetTonk(v: Voice, g: number): number {
  const p = tierPitch(v);
  return Math.max(
    tone(v, { freq: 430 * p, freqEnd: 390 * p, glide: 0.15, decay: 0.22, gain: 0.45 * g }),
    tone(v, { type: 'triangle', freq: 1130 * p, decay: 0.12, gain: 0.2 * g }),
    bell(v, 0, 2350 * p, 0.12 * g, 0.35, [[1, 1], [1.48, 0.4]]),
    click(v, 0, 3400, 0.35 * g, 3, 0.015),
  );
}

/** Vest break: plate shatter plus a fabric rip, lower than the helmet break. */
function vestBreak(v: Voice, g: number): number {
  return Math.max(
    armorShatter(v, 0.8),
    noise(v, { filter: 'highpass', freq: 1800, freqEnd: 4200, glide: 0.12, at: 0.03, attack: 0.01, decay: 0.12, gain: 0.25 * g }),
    tone(v, { freq: 130, freqEnd: 60, glide: 0.12, decay: 0.14, gain: 0.5 * g }),
  );
}

/** Helmet break: a sharp crack, a falling clang and the pieces tumbling away. */
function helmetBreak(v: Voice, g: number): number {
  return Math.max(
    armorShatter(v, 1.15),
    tone(v, { type: 'triangle', freq: 1700, freqEnd: 900, glide: 0.25, decay: 0.3, gain: 0.25 * g }),
    crackle(v, 0.12, 4, 0.25, 900, 1800, 0.25 * g),
  );
}

/** Seconds the sound takes to reach the listener (capped): far blasts are seen before they are heard. */
const soundDelay = (v: Voice): number => Math.min(AUDIO_TUNING.maxSoundDelayS, v.distance / AUDIO_TUNING.speedOfSound);

/** Prone crawl "step": a slow drag through the surface. */
function crawl(v: Voice): number {
  switch (v.variant) {
    case 'wood':
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 1300, freqEnd: 900, glide: 0.2, q: 1.2, attack: 0.06, decay: 0.2, gain: 0.35 }),
        tone(v, { type: 'triangle', freq: 170, at: 0.12, decay: 0.05, gain: 0.15 }),
      );
    case 'carpet':
      return Math.max(
        noise(v, { color: 'pink', filter: 'bandpass', freq: 600, q: 0.6, attack: 0.08, decay: 0.2, gain: 0.35 }),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 250, attack: 0.06, decay: 0.15, gain: 0.25 }),
      );
    case 'tile':
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 2400, freqEnd: 1800, glide: 0.15, q: 2, attack: 0.05, decay: 0.16, gain: 0.3 }),
        tone(v, { freq: 1900 + v.rand() * 500, freqEnd: 2300, glide: 0.06, at: 0.08, decay: 0.05, gain: 0.04 }), // rubber squeak
      );
    case 'water':
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 900, freqEnd: 600, glide: 0.2, q: 1, attack: 0.06, decay: 0.2, gain: 0.45 }),
        tone(v, { freq: 700 + v.rand() * 400, freqEnd: 1300, glide: 0.05, at: 0.1, decay: 0.04, gain: 0.06 }),
      );
    case 'grass':
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 2600, q: 0.9, attack: 0.07, decay: 0.18, gain: 0.35 }),
        noise(v, { color: 'pink', filter: 'highpass', freq: 3500, attack: 0.05, decay: 0.12, gain: 0.1 }),
      );
    default: // sand
      return Math.max(
        noise(v, { color: 'pink', filter: 'bandpass', freq: 950, freqEnd: 600, glide: 0.25, q: 0.9, attack: 0.08, decay: 0.22, gain: 0.5 }),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 300, attack: 0.05, decay: 0.15, gain: 0.3 }),
      );
  }
}

/** Sniper: the loudest crack, a deep body, a long tail and lowpassed echoes rolling back across the bay. */
function sniperShot(v: Voice, local: boolean): number {
  const g = local ? 1 : 0.95;
  let end = Math.max(
    noise(v, { filter: 'highpass', freq: 2800, decay: 0.045, gain: 0.9 * g }),
    click(v, 0, 5200, 0.45 * g, 2, 0.01),
    tone(v, { type: 'sawtooth', freq: 900, freqEnd: 90, glide: 0.1, decay: 0.14, gain: 0.4 * g, lowpass: 3000 }),
    tone(v, { freq: 95, freqEnd: 34, glide: 0.25, decay: 0.32, gain: 0.95 * g }),
    noise(v, { color: 'brown', filter: 'lowpass', freq: 900, freqEnd: 300, glide: 0.4, decay: 0.45, gain: 0.7 * g }),
    noise(v, { color: 'pink', filter: 'lowpass', freq: 1200, freqEnd: 400, glide: 1, at: 0.06, attack: 0.05, decay: 1.1, gain: 0.2 * g }),
  );
  for (const [at, eg, f] of [[0.38, 0.22, 700], [0.74, 0.12, 520], [1.15, 0.06, 400]] as const) {
    end = Math.max(
      end,
      noise(v, { color: 'brown', filter: 'lowpass', freq: f, at, attack: 0.02, decay: 0.35, gain: eg * g }),
      tone(v, { freq: 80, freqEnd: 40, glide: 0.2, at, decay: 0.25, gain: eg * 0.6 * g }),
    );
  }
  return local ? end : Math.max(end, distantTail(v, 0.6));
}

/** DMR: a punchy, snappy crack with a short tail (higher and sharper than the rifle). */
function dmrShot(v: Voice, local: boolean): number {
  return Math.max(
    noise(v, { filter: 'highpass', freq: 3600, decay: 0.03, gain: 0.85 }),
    click(v, 0, 5000, 0.4, 2, 0.008),
    tone(v, { type: 'sawtooth', freq: 760, freqEnd: 140, glide: 0.06, decay: 0.09, gain: 0.4, lowpass: 3000 }),
    tone(v, { freq: 140, freqEnd: 52, glide: 0.1, decay: 0.15, gain: local ? 0.85 : 0.6 }),
    noise(v, { color: 'brown', filter: 'lowpass', freq: 800, decay: 0.16, gain: 0.6 }),
    noise(v, { color: 'pink', filter: 'lowpass', freq: 1000, at: 0.07, attack: 0.03, decay: 0.5, gain: 0.14 }),
    local ? 0 : distantTail(v, 0.5),
  );
}

/** LMG: chunky and a little lower than the rifle, with a receiver "chug" so the stream rolls. */
function lmgShot(v: Voice, local: boolean): number {
  return Math.max(
    noise(v, { filter: 'highpass', freq: 2600, decay: 0.028, gain: 0.6 }),
    tone(v, { type: 'sawtooth', freq: 520, freqEnd: 100, glide: 0.07, decay: 0.1, gain: 0.4, lowpass: 2000 }),
    tone(v, { freq: 100, freqEnd: 42, glide: 0.12, decay: 0.15, gain: local ? 0.85 : 0.6 }),
    noise(v, { color: 'brown', filter: 'lowpass', freq: 600, decay: 0.16, gain: 0.6 }),
    click(v, 0.03, 1100, 0.3, 3, 0.02),
    local ? 0 : distantTail(v, 0.45),
  );
}

export const RECIPES: Record<CueId, Recipe> = {
  // --- Weapons ---------------------------------------------------------------------------
  // Fists: a cartoon whoosh (the thwack comes from the hit confirm / remote hit).
  'shot.fists.local': (v) =>
    Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 500, freqEnd: 1700, glide: 0.12, q: 1.4, attack: 0.03, decay: 0.12, gain: 0.8 }),
      noise(v, { filter: 'highpass', freq: 3000, at: 0.05, attack: 0.01, decay: 0.05, gain: 0.12 }),
    ),
  'shot.fists.remote': (v) =>
    noise(v, { color: 'pink', filter: 'bandpass', freq: 600, freqEnd: 1600, glide: 0.12, q: 1.4, attack: 0.03, decay: 0.11, gain: 0.8 }),

  // Conch Pistol: a cork "pop" with a woody body. Mid-pitched, single.
  'shot.pistol.local': (v) =>
    Math.max(
      tone(v, { freq: 1100, freqEnd: 160, glide: 0.06, decay: 0.09, gain: 0.7 }),
      tone(v, { type: 'triangle', freq: 260, freqEnd: 90, glide: 0.08, decay: 0.12, gain: 0.5 }),
      noise(v, { filter: 'highpass', freq: 2500, decay: 0.035, gain: 0.5 }),
      tone(v, { freq: 90, freqEnd: 45, glide: 0.1, decay: 0.12, gain: 0.5 }),
    ),
  'shot.pistol.remote': (v) =>
    Math.max(
      tone(v, { freq: 1100, freqEnd: 160, glide: 0.06, decay: 0.09, gain: 0.7 }),
      tone(v, { type: 'triangle', freq: 260, freqEnd: 90, glide: 0.08, decay: 0.12, gain: 0.5 }),
      noise(v, { filter: 'highpass', freq: 2500, decay: 0.035, gain: 0.45 }),
      distantTail(v, 0.35),
    ),

  // Spritzer SMG: a bright, short "tsk" squirt. Highest and thinnest so a stream of them never masks other guns.
  'shot.smg.local': (v) =>
    Math.max(
      noise(v, { filter: 'bandpass', freq: 4200, freqEnd: 1800, glide: 0.05, q: 2.5, decay: 0.06, gain: 0.7 }),
      tone(v, { type: 'square', freq: 1500, freqEnd: 650, glide: 0.04, decay: 0.045, gain: 0.18, lowpass: 3500 }),
      tone(v, { freq: 320, freqEnd: 140, glide: 0.04, decay: 0.05, gain: 0.4 }),
      click(v, 0, 6000, 0.2),
    ),
  'shot.smg.remote': (v) =>
    Math.max(
      noise(v, { filter: 'bandpass', freq: 4200, freqEnd: 1800, glide: 0.05, q: 2.5, decay: 0.06, gain: 0.7 }),
      tone(v, { type: 'square', freq: 1500, freqEnd: 650, glide: 0.04, decay: 0.045, gain: 0.18, lowpass: 3500 }),
      tone(v, { freq: 320, freqEnd: 140, glide: 0.04, decay: 0.05, gain: 0.3 }),
      distantTail(v, 0.25),
    ),

  // Scatter Clam: a deep "thwump" + clam-shell clack, then an audible pump at ~0.45 s (tells enemies the gap).
  'shot.shotgun.local': (v) => shotgun(v, 1),
  'shot.shotgun.remote': (v) => shotgun(v, 0.8),

  // Coral Rifle: a sharp crack over a solid thump with a short tail. Heaviest single-shot sound.
  'shot.rifle.local': (v) =>
    Math.max(
      noise(v, { filter: 'highpass', freq: 3200, decay: 0.03, gain: 0.7 }),
      tone(v, { type: 'sawtooth', freq: 640, freqEnd: 120, glide: 0.07, decay: 0.1, gain: 0.35, lowpass: 2600 }),
      tone(v, { freq: 120, freqEnd: 50, glide: 0.12, decay: 0.16, gain: 0.75 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 700, decay: 0.18, gain: 0.55 }),
      noise(v, { color: 'pink', filter: 'lowpass', freq: 900, at: 0.08, attack: 0.03, decay: 0.4, gain: 0.12 }),
    ),
  'shot.rifle.remote': (v) =>
    Math.max(
      noise(v, { filter: 'highpass', freq: 3200, decay: 0.03, gain: 0.7 }),
      tone(v, { type: 'sawtooth', freq: 640, freqEnd: 120, glide: 0.07, decay: 0.1, gain: 0.35, lowpass: 2600 }),
      tone(v, { freq: 120, freqEnd: 55, glide: 0.12, decay: 0.14, gain: 0.5 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 700, decay: 0.18, gain: 0.45 }),
      noise(v, { color: 'pink', filter: 'lowpass', freq: 900, at: 0.08, attack: 0.03, decay: 0.45, gain: 0.15 }),
      distantTail(v, 0.45),
    ),

  'shot.lmg.local': (v) => lmgShot(v, true),
  'shot.lmg.remote': (v) => lmgShot(v, false),
  'shot.dmr.local': (v) => dmrShot(v, true),
  'shot.dmr.remote': (v) => dmrShot(v, false),
  'shot.sniper.local': (v) => sniperShot(v, true),
  'shot.sniper.remote': (v) => sniperShot(v, false),

  // Bolt cycle across durationS (= weapons.sniper.fireIntervalMs): lift and pull back, brass tinkle, push and lock.
  // The lock click lands at durationS, so the gap between shots can be counted by ear.
  'weapon.bolt': (v) => {
    const dur = v.durationS > 0.4 ? v.durationS : 1.4;
    const open = Math.max(0.15, dur * 0.3);
    const close = dur - 0.16;
    return Math.max(
      click(v, open, 1700, 0.5, 5, 0.015),
      noise(v, { filter: 'bandpass', freq: 1300, freqEnd: 2600, glide: 0.09, q: 2.5, at: open + 0.04, attack: 0.01, decay: 0.08, gain: 0.35 }),
      click(v, open + 0.13, 2400, 0.45),
      bell(v, open + 0.2, 3100, 0.07, 0.12, [[1, 1], [2.3, 0.4]]),
      bell(v, open + 0.32, 3350, 0.04, 0.08, [[1, 1], [2.3, 0.4]]),
      noise(v, { filter: 'bandpass', freq: 2600, freqEnd: 1300, glide: 0.08, q: 2.5, at: close, attack: 0.01, decay: 0.07, gain: 0.3 }),
      click(v, close + 0.1, 1500, 0.55, 4, 0.02),
      click(v, dur - 0.02, 2100, 0.5),
    );
  },

  'weapon.dryFire': (v) => {
    const p = wp(v);
    return Math.max(click(v, 0, 2600 * p, 0.6, 6, 0.01), click(v, 0.035, 1700 * p, 0.4, 6, 0.012), tone(v, { type: 'square', freq: 900 * p, decay: 0.015, gain: 0.05 }));
  },

  'weapon.switch': (v) => {
    if (v.variant === 'grenade') {
      // Grenade off the belt: a pouch rustle and the spoon rattling.
      return Math.max(
        noise(v, { color: 'pink', filter: 'bandpass', freq: 1500, q: 1.2, attack: 0.02, decay: 0.08, gain: 0.35 }),
        bell(v, 0.05, 2900, 0.08, 0.1, [[1, 1], [2.6, 0.3]]),
        click(v, 0.08, 3300, 0.3),
      );
    }
    if (v.variant === 'fists') {
      return Math.max(
        noise(v, { color: 'pink', filter: 'bandpass', freq: 800, freqEnd: 2000, glide: 0.1, attack: 0.02, decay: 0.1, gain: 0.5 }),
        click(v, 0.09, 1200, 0.4, 3),
        click(v, 0.12, 900, 0.35, 3),
      );
    }
    const p = wp(v);
    return Math.max(
      click(v, 0, 1800 * p, 0.5),
      noise(v, { filter: 'bandpass', freq: 1500 * p, freqEnd: 2500 * p, glide: 0.05, q: 2, at: 0.03, decay: 0.06, gain: 0.25 }),
      click(v, 0.1, 2600 * p, 0.5),
      tone(v, { type: 'triangle', freq: 500 * p, at: 0.1, decay: 0.04, gain: 0.15 }),
    );
  },

  // Reload start: mag release + slide out. Shotgun: one "shk" per shell across the reload (stopped on cancel).
  'reload.start': (v) => {
    const p = wp(v);
    if (v.variant === 'shotgun') {
      const total = Math.max(0.6, v.durationS);
      const shells = Math.max(2, Math.round(total / 0.55));
      const step = (total - 0.35) / shells;
      click(v, 0, 1400, 0.45);
      for (let i = 0; i < shells; i++) {
        const at = 0.25 + i * step;
        noise(v, { filter: 'bandpass', freq: 1100, q: 3, at, attack: 0.004, decay: 0.05, gain: 0.35 });
        click(v, at + 0.035, 1600, 0.4);
      }
      return total;
    }
    if (v.variant === 'lmg') {
      // Cover up, belt out, new box in, belt laid across the feed tray (spread over the long reload).
      const total = Math.max(1.2, v.durationS);
      return Math.max(
        total,
        click(v, 0, 900, 0.55, 3, 0.02),
        tone(v, { type: 'triangle', freq: 240, decay: 0.08, gain: 0.25 }),
        crackle(v, 0.25, 8, 0.35, 1800, 3000, 0.3),
        noise(v, { filter: 'bandpass', freq: 700, q: 1.5, at: 0.7, attack: 0.02, decay: 0.12, gain: 0.3 }),
        tone(v, { freq: 180, freqEnd: 120, glide: 0.05, at: total * 0.5, decay: 0.08, gain: 0.35 }),
        click(v, total * 0.5, 1100, 0.5),
        crackle(v, total * 0.65, 8, 0.3, 2200, 3400, 0.28),
      );
    }
    if (v.variant === 'sniper') {
      // Bolt open, then five rounds thumbed in one by one.
      const total = Math.max(0.8, v.durationS);
      const step = (total - 0.6) / 5;
      let end = Math.max(click(v, 0, 1700, 0.5, 5, 0.015), click(v, 0.1, 2400, 0.45));
      for (let i = 0; i < 5; i++) {
        const at = 0.35 + i * step;
        end = Math.max(
          end,
          noise(v, { filter: 'bandpass', freq: 1900, q: 3, at, attack: 0.004, decay: 0.04, gain: 0.3 }),
          click(v, at + 0.03, 2600, 0.4),
        );
      }
      return Math.max(total, end);
    }
    return Math.max(
      click(v, 0, 2200 * p, 0.5),
      noise(v, { filter: 'bandpass', freq: 1400 * p, freqEnd: 900 * p, glide: 0.1, q: 2, at: 0.03, attack: 0.01, decay: 0.12, gain: 0.35 }),
      tone(v, { type: 'triangle', freq: 300 * p, at: 0.05, decay: 0.06, gain: 0.15 }),
    );
  },

  // Reload finish: mag in + charge. Shotgun: a pump.
  'reload.finish': (v) => {
    const p = wp(v);
    if (v.variant === 'shotgun') return pump(v, 0, 1);
    if (v.variant === 'lmg') {
      // Feed cover slammed shut, then the charging handle.
      return Math.max(
        tone(v, { freq: 150, freqEnd: 80, glide: 0.06, decay: 0.1, gain: 0.5 }),
        click(v, 0, 1200, 0.6, 3, 0.02),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 900, decay: 0.08, gain: 0.35 }),
        click(v, 0.22, 1800, 0.45),
        click(v, 0.3, 1300, 0.45),
      );
    }
    if (v.variant === 'sniper') {
      return Math.max(
        noise(v, { filter: 'bandpass', freq: 2600, freqEnd: 1300, glide: 0.08, q: 2.5, attack: 0.01, decay: 0.07, gain: 0.3 }),
        click(v, 0.1, 1500, 0.55, 4, 0.02),
        click(v, 0.16, 2100, 0.5),
      );
    }
    return Math.max(
      click(v, 0, 1500 * p, 0.5),
      tone(v, { type: 'triangle', freq: 220 * p, decay: 0.05, gain: 0.3 }),
      noise(v, { filter: 'bandpass', freq: 2000 * p, freqEnd: 3000 * p, glide: 0.04, q: 2, at: 0.09, decay: 0.04, gain: 0.25 }),
      click(v, 0.12, 2400 * p, 0.45),
      click(v, 0.16, 1800 * p, 0.4),
    );
  },

  // --- Aim down sights (local) -------------------------------------------------------------
  // In: cloth rustle up to the shoulder and a stock tap. Red dot adds a tiny emitter tick; scopes add a lens
  // "zoom" sweep (longer for 8x) and a ring click.
  'ads.in': (v) => {
    let end = Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1100, freqEnd: 2200, glide: 0.12, q: 0.9, attack: 0.03, decay: 0.1, gain: 0.5 }),
      click(v, 0.09, 2600, 0.25, 5, 0.01),
      tone(v, { freq: 180, at: 0.08, decay: 0.04, gain: 0.15 }),
    );
    if (v.variant === 'red_dot') end = Math.max(end, tone(v, { freq: 5200, at: 0.1, decay: 0.012, gain: 0.04 }));
    if (v.variant === 'scope_4x' || v.variant === 'scope_8x') {
      const long = v.variant === 'scope_8x';
      const sweep = long ? 0.3 : 0.2;
      end = Math.max(
        end,
        noise(v, { filter: 'bandpass', freq: 900, freqEnd: long ? 3200 : 2400, glide: sweep, q: 6, at: 0.05, attack: 0.08, decay: long ? 0.22 : 0.15, gain: 0.18 }),
        tone(v, { freq: 1400, freqEnd: long ? 2600 : 2100, glide: sweep, at: 0.05, attack: 0.06, decay: 0.15, gain: 0.04 }),
        click(v, 0.05 + sweep + 0.03, 4200, 0.18, 6, 0.008),
      );
    }
    return end;
  },
  'ads.out': (v) => {
    let end = Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 2000, freqEnd: 1000, glide: 0.1, q: 0.9, attack: 0.02, decay: 0.08, gain: 0.4 }),
      click(v, 0.06, 2000, 0.15, 5, 0.01),
    );
    if (v.variant === 'scope_4x' || v.variant === 'scope_8x') {
      end = Math.max(end, noise(v, { filter: 'bandpass', freq: 2400, freqEnd: 1100, glide: 0.12, q: 6, attack: 0.03, decay: 0.08, gain: 0.1 }));
    }
    return end;
  },

  // --- Impacts and hits ------------------------------------------------------------------
  'impact.ground': (v) =>
    Math.max(
      noise(v, { color: 'brown', filter: 'lowpass', freq: 1100, decay: 0.07, gain: 0.7 }),
      noise(v, { filter: 'bandpass', freq: 3000, q: 1, at: 0.005, decay: 0.03, gain: 0.2 }),
    ),
  'impact.prop': (v) =>
    Math.max(tone(v, { type: 'triangle', freq: 420, freqEnd: 330, glide: 0.05, decay: 0.07, gain: 0.45 }), click(v, 0, 1300, 0.5, 3, 0.03)),
  'impact.water': (v) =>
    Math.max(
      tone(v, { freq: 700, freqEnd: 1500, glide: 0.05, at: 0.005, decay: 0.06, gain: 0.3 }),
      noise(v, { filter: 'highpass', freq: 2500, decay: 0.09, gain: 0.3 }),
    ),

  // M2b: thick toy-glass pane: a dull low thunk, a short glassy ring of inharmonic partials and a few tiny ticks.
  'impact.glass': (v) =>
    Math.max(
      tone(v, { type: 'triangle', freq: 260, freqEnd: 190, glide: 0.04, decay: 0.06, gain: 0.45 }),
      bell(v, 0.002, 2900 + v.rand() * 400, 0.16, 0.22, [[1, 1], [1.53, 0.5], [2.41, 0.3], [3.7, 0.15]]),
      click(v, 0, 4200, 0.35, 3, 0.012),
      crackle(v, 0.02, 3, 0.06, 5000, 7500, 0.08),
    ),

  // Variants (soundMap.remoteHitVariant): body, head, vest1..3, helmet1..3, vestBreak, helmetBreak.
  'hit.remote': (v) => {
    const body = Math.max(
      noise(v, { filter: 'bandpass', freq: 900, q: 1.5, decay: 0.07, gain: 0.7 }),
      tone(v, { freq: 170, freqEnd: 90, glide: 0.06, decay: 0.08, gain: 0.5 }),
    );
    const k = v.variant;
    if (k === 'head') return Math.max(body, click(v, 0, 1900, 0.4, 8, 0.03), tone(v, { type: 'triangle', freq: 820, decay: 0.05, gain: 0.2 }));
    if (k === 'vestBreak') return Math.max(body, vestBreak(v, 0.8));
    if (k === 'helmetBreak') return Math.max(body, helmetBreak(v, 0.8));
    if (k.startsWith('helmet')) return Math.max(body, helmetTonk(v, 0.9));
    if (k.startsWith('vest')) return Math.max(body, vestClink(v, 0.8));
    return body;
  },

  // Hit confirms: short, dry and 2D so they cut through everything.
  'hitConfirm.body': (v) =>
    Math.max(
      tone(v, { type: 'triangle', freq: 1250, decay: 0.045, gain: 0.5 }),
      tone(v, { freq: 230, freqEnd: 160, glide: 0.05, decay: 0.06, gain: 0.45 }),
      click(v, 0, 4000, 0.25),
    ),
  'hitConfirm.head': (v) =>
    Math.max(
      bell(v, 0, 1975.5, 0.5, 0.32, [[1, 1], [2.76, 0.3], [5.4, 0.12]]),
      click(v, 0, 5000, 0.2),
    ),
  'hitConfirm.vest': (v) =>
    Math.max(
      tone(v, { type: 'square', freq: 620 * tierPitch(v), decay: 0.05, gain: 0.15, lowpass: 1800 }),
      vestClink(v, 0.9),
    ),
  'hitConfirm.helmet': (v) => helmetTonk(v, 1),
  'hitConfirm.vestBreak': (v) => vestBreak(v, 1),
  'hitConfirm.helmetBreak': (v) => helmetBreak(v, 1),
  'hitConfirm.kill': (v) =>
    Math.max(
      tone(v, { freq: 280, freqEnd: 1200, glide: 0.045, decay: 0.06, gain: 0.5 }),
      bell(v, 0.055, 1318.5, 0.35, 0.55),
      bell(v, 0.055, 1975.5, 0.25, 0.6),
      noise(v, { filter: 'highpass', freq: 6000, at: 0.05, attack: 0.01, decay: 0.2, gain: 0.08 }),
    ),

  // Damage taken: low body thumps you feel more than hear.
  'damage.hp': (v) =>
    Math.max(
      tone(v, { freq: 120, freqEnd: 48, glide: 0.15, decay: 0.2, gain: 0.9 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 500, decay: 0.14, gain: 0.6 }),
      oof(v, 0.01, 0.12),
      v.variant === 'head' ? click(v, 0, 3000, 0.3, 3, 0.02) : 0,
    ),
  // Variant vest1..3 / helmet1..3: the clink rises with tier. Helmet hits add a short "bell rung" whine.
  'damage.vest': (v) =>
    Math.max(
      tone(v, { freq: 140, freqEnd: 70, glide: 0.1, decay: 0.13, gain: 0.7 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 600, decay: 0.08, gain: 0.4 }),
      vestClink(v, 0.7),
    ),
  'damage.helmet': (v) =>
    Math.max(
      tone(v, { freq: 160, freqEnd: 80, glide: 0.08, decay: 0.1, gain: 0.5 }),
      helmetTonk(v, 0.9),
      tone(v, { freq: 2900, at: 0.04, attack: 0.03, decay: 0.35, gain: 0.04 }),
    ),
  'damage.vestBreak': (v) => Math.max(vestBreak(v, 1), tone(v, { freq: 120, freqEnd: 48, glide: 0.15, decay: 0.18, gain: 0.8 })),
  'damage.helmetBreak': (v) => Math.max(helmetBreak(v, 1), tone(v, { freq: 150, freqEnd: 60, glide: 0.12, decay: 0.15, gain: 0.6 })),
  'damage.fall': (v) =>
    Math.max(
      tone(v, { freq: 95, freqEnd: 40, glide: 0.2, decay: 0.25, gain: 0.6 + 0.4 * v.intensity }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 400, decay: 0.2, gain: 0.7 }),
      oof(v, 0.03, 0.14),
    ),

  // Someone else washed out: a cartoon bonk and a splash.
  // Variant 'head' (playerKilled.headshot): a hollow coconut "tok" on top, so a headshot kill reads by ear.
  'death.remote': (v) =>
    Math.max(
      tone(v, { type: 'square', freq: 520, freqEnd: 140, glide: 0.12, decay: 0.14, gain: 0.25, lowpass: 1500 }),
      tone(v, { freq: 260, freqEnd: 90, glide: 0.12, decay: 0.15, gain: 0.5 }),
      splash(v, 0.1, 0.5, 0.3),
      v.variant === 'head' ? Math.max(click(v, 0, 1900, 0.5, 8, 0.03), tone(v, { type: 'triangle', freq: 820, decay: 0.05, gain: 0.25 })) : 0,
    ),

  heartbeat: (v) =>
    Math.max(tone(v, { freq: 62, freqEnd: 45, glide: 0.08, decay: 0.11, gain: 0.9 }), tone(v, { freq: 58, freqEnd: 42, glide: 0.08, at: 0.2, decay: 0.12, gain: 0.65 })),

  // --- Movement ---------------------------------------------------------------------------
  'foot.local': footstep,
  'foot.remote': footstep,
  'foot.crouch.remote': footstep,
  'foot.crawl.local': crawl,
  'foot.crawl.remote': crawl,

  // Variant '<from>_<to>', durationS = transition length, intensity 1 = forced (water) stand-up.
  'stance.change': (v) => {
    const dur = Math.max(0.1, v.durationS || 0.3);
    const toProne = v.variant.endsWith('_prone');
    const down = toProne || v.variant === 'stand_crouch';
    const rl = Math.min(0.35, dur * 0.8);
    let end = Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: down ? 1400 : 1100, freqEnd: down ? 800 : 1900, glide: rl, q: 0.8, attack: rl * 0.3, decay: rl * 0.7, gain: 0.5 }),
      crackle(v, 0.02, 3, rl, 2200, 3600, 0.12),
    );
    if (toProne) {
      // Body meets the ground when the drop finishes, then elbows pat the sand.
      end = Math.max(
        end,
        tone(v, { freq: 110, freqEnd: 48, glide: 0.1, at: dur - 0.02, decay: 0.14, gain: 0.55 }),
        noise(v, { color: 'brown', filter: 'lowpass', freq: 400, at: dur - 0.02, decay: 0.12, gain: 0.5 }),
        noise(v, { color: 'pink', filter: 'bandpass', freq: 1200, at: dur + 0.05, decay: 0.08, gain: 0.25 }),
      );
    } else {
      end = Math.max(end, tone(v, { freq: 140, freqEnd: 70, glide: 0.05, at: Math.max(0, dur - 0.03), decay: 0.06, gain: 0.25 }));
    }
    if (v.intensity > 0) end = Math.max(end, splash(v, 0, 0.35, 0.25));
    return end;
  },
  'jump.local': (v) =>
    Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 500, freqEnd: 1300, glide: 0.12, attack: 0.02, decay: 0.1, gain: 0.5 }),
      tone(v, { type: 'triangle', freq: 340, freqEnd: 460, glide: 0.05, decay: 0.05, gain: 0.08 }),
    ),
  'jump.remote': (v) =>
    Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 500, freqEnd: 1300, glide: 0.12, attack: 0.02, decay: 0.1, gain: 0.5 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 400, decay: 0.05, gain: 0.4 }),
    ),
  'land.local': landing,
  'land.remote': landing,
  // M2b drop. Jump (intensity 1 = local): the door rush swelling past you, a cloth whoosh and a hand slap on the frame.
  'drop.jump': (v) => {
    const big = v.intensity >= 1;
    return Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 400, freqEnd: 1600, glide: 0.35, q: 0.8, attack: 0.05, hold: 0.1, decay: 0.45, gain: big ? 0.7 : 0.5 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 300, freqEnd: 900, glide: 0.3, attack: 0.04, decay: big ? 0.6 : 0.3, gain: 0.5 }),
      click(v, 0, 1400, 0.3, 2, 0.02),
    );
  },
  // Canopy pop: a fabric "fwump" (low noise burst), a line snap, and the harness tug.
  'drop.chutePop': (v) =>
    Math.max(
      noise(v, { color: 'brown', filter: 'lowpass', freq: 600, freqEnd: 200, glide: 0.15, attack: 0.008, decay: 0.28, gain: 0.9 }),
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1200, q: 0.8, attack: 0.004, decay: 0.12, gain: 0.5 }),
      tone(v, { freq: 120, freqEnd: 60, glide: 0.1, decay: 0.15, gain: 0.5 }),
      click(v, 0.05, 2500, 0.35, 4, 0.015),
      noise(v, { color: 'pink', filter: 'bandpass', freq: 800, at: 0.12, attack: 0.03, decay: 0.25, gain: 0.25 }), // canopy fill
    ),
  // Drop ends: canopy folding down (soft rustle) after a light settle; the surface step is the land cue.
  'drop.land': (v) =>
    Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1100, freqEnd: 600, glide: 0.4, q: 0.7, at: 0.05, attack: 0.06, decay: 0.45, gain: 0.45 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 350, at: 0.25, attack: 0.04, decay: 0.2, gain: 0.3 }),
    ),

  // --- Items ------------------------------------------------------------------------------
  'pickup.weapon': (v) => {
    const p = wp(v);
    return Math.max(
      click(v, 0, 2000 * p, 0.6),
      tone(v, { type: 'triangle', freq: 600 * p, decay: 0.05, gain: 0.25 }),
      click(v, 0.07, 2600 * p, 0.5),
      tone(v, { type: 'triangle', freq: 800 * p, at: 0.07, decay: 0.05, gain: 0.2 }),
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1500, at: 0.02, decay: 0.06, gain: 0.15 }),
    );
  },
  'pickup.ammo': (v) => {
    const f = AMMO_CLICK_HZ[v.variant] ?? 2200;
    return Math.max(crackle(v, 0, 5, 0.12, f * 0.85, f * 1.15, 0.5), tone(v, { type: 'triangle', freq: f / 3, decay: 0.03, gain: 0.1 }));
  },
  'pickup.heal': (v) => {
    const pre =
      v.variant === 'medkit'
        ? Math.max(click(v, 0, 1800, 0.5), click(v, 0.06, 2600, 0.45))
        : noise(v, { color: 'pink', filter: 'bandpass', freq: 2500, q: 1.5, attack: 0.02, decay: 0.15, gain: 0.4 });
    const base = v.variant === 'medkit' ? 784 : 1046.5;
    return Math.max(pre, tone(v, { freq: base, at: 0.05, decay: 0.2, gain: 0.12 }), tone(v, { freq: base * 1.5, at: 0.1, decay: 0.25, gain: 0.1 }));
  },
  // Velcro rip and two pats; heavier tiers sit a little lower.
  'pickup.vest': (v) => {
    const p = 1.1 - 0.08 * tierOf(v);
    return Math.max(
      noise(v, { filter: 'bandpass', freq: 3000 * p, q: 1, attack: 0.02, hold: 0.12, decay: 0.05, gain: 0.2 }),
      crackle(v, 0, 16, 0.2, 2500 * p, 5000 * p, 0.22),
      tone(v, { freq: 150 * p, freqEnd: 90 * p, glide: 0.06, at: 0.26, decay: 0.08, gain: 0.4 }),
      tone(v, { freq: 140 * p, freqEnd: 85 * p, glide: 0.06, at: 0.36, decay: 0.07, gain: 0.3 }),
    );
  },
  // Chin-strap buckle click and a knuckle tap on the shell.
  'pickup.helmet': (v) => {
    const p = tierPitch(v);
    return Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1600, q: 1.5, attack: 0.02, decay: 0.08, gain: 0.25 }),
      click(v, 0.1, 2400, 0.5),
      click(v, 0.14, 1800, 0.45),
      tone(v, { freq: 500 * p, freqEnd: 460 * p, glide: 0.1, at: 0.24, decay: 0.12, gain: 0.3 }),
    );
  },
  'pickup.grenade': (v) =>
    Math.max(
      bell(v, 0, 2800, 0.15, 0.12, [[1, 1], [2.7, 0.35]]),
      click(v, 0.06, 3300, 0.35),
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1400, q: 1.2, at: 0.02, decay: 0.06, gain: 0.2 }),
    ),

  'heal.start': (v) => {
    if (v.variant === 'medkit') {
      // Zip open + latch.
      let end = 0;
      for (let i = 0; i < 10; i++) end = Math.max(end, click(v, i * 0.03, 2000 + i * 120, 0.3, 3, 0.01));
      return Math.max(end, click(v, 0.33, 1500, 0.5));
    }
    // Bandage tear.
    let end = noise(v, { color: 'pink', filter: 'highpass', freq: 2000, attack: 0.01, decay: 0.2, gain: 0.15 });
    for (let i = 0; i < 8; i++) end = Math.max(end, noise(v, { filter: 'bandpass', freq: 3000, q: 2, at: i * 0.025, decay: 0.02, gain: 0.3 }));
    return end;
  },
  // Rhythmic wrapping rustle until healFinished/healCancelled (or the safety length).
  'heal.loop': (v) => {
    const until = v.t + Math.max(0.3, v.durationS);
    const medkit = v.variant === 'medkit';
    const am = gainNode(v, 0.6, v.out);
    loopNoise(v, { buffer: v.noise.pinkLoop, filter: 'bandpass', freq: medkit ? 1200 : 1800, q: 1.2, gain: 0.6, fadeIn: 0.15, until, dest: am });
    lfo(v, am.gain, medkit ? 1.4 : 2.2, 0.4, until);
    return until - v.t;
  },
  'heal.finish': (v) =>
    Math.max(
      bell(v, 0, 1046.5, 0.4, 0.3),
      bell(v, 0.09, 1568, 0.35, 0.45),
      noise(v, { filter: 'highpass', freq: 7000, at: 0.09, attack: 0.01, decay: 0.25, gain: 0.06 }),
    ),
  'heal.cancel': (v) =>
    Math.max(tone(v, { type: 'triangle', freq: 784, decay: 0.08, gain: 0.3 }), tone(v, { type: 'triangle', freq: 587, at: 0.08, decay: 0.14, gain: 0.3 })),

  // --- Grenades -------------------------------------------------------------------------------
  // Pin scrape and pop, then the spoon flying off with a bright "ping".
  'grenade.pin': (v) =>
    Math.max(
      noise(v, { filter: 'bandpass', freq: 3000, freqEnd: 4200, glide: 0.06, q: 5, attack: 0.01, decay: 0.05, gain: 0.3 }),
      click(v, 0.06, 3600, 0.5, 6, 0.01),
      bell(v, 0.14, 3950, 0.16, 0.35, [[1, 1], [2.4, 0.3], [4.1, 0.1]]),
      click(v, 0.14, 2200, 0.35),
    ),
  // Quiet fuse tick across durationS that speeds up as the fuse runs out.
  'grenade.tick': (v) => {
    const total = Math.max(0.5, v.durationS);
    let end = 0;
    for (let t = 0.25; t < total - 0.02; ) {
      const left = 1 - t / total;
      end = Math.max(
        end,
        click(v, t, 3000 + (1 - left) * 1200, 0.4, 8, 0.008),
        tone(v, { type: 'triangle', freq: 1800 + (1 - left) * 600, at: t, decay: 0.012, gain: 0.08 }),
      );
      t += 0.12 + 0.38 * left;
    }
    return Math.max(total, end);
  },
  // M2b: one positional fuse tick of a nearby live grenade; intensity = urgency (brighter near the end).
  'grenade.fuseTick': (v) =>
    Math.max(
      click(v, 0, 3000 + 1400 * v.intensity, 0.5, 8, 0.008),
      tone(v, { type: 'triangle', freq: 1800 + 700 * v.intensity, decay: 0.014, gain: 0.12 }),
    ),
  'grenade.throw': (v) =>
    Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 400, freqEnd: 1800, glide: 0.18, q: 1.2, attack: 0.06, decay: 0.14, gain: 0.6 }),
      noise(v, { filter: 'highpass', freq: 2500, at: 0.08, decay: 0.08, gain: 0.1 }),
    ),
  // Variant = GrenadeContactSurface; intensity = contact speed.
  'grenade.bounce': (v) => {
    const g = 0.35 + 0.65 * v.intensity;
    switch (v.variant) {
      case 'water':
        return Math.max(
          tone(v, { freq: 500, freqEnd: 1300, glide: 0.06, decay: 0.07, gain: 0.35 * g }),
          noise(v, { filter: 'highpass', freq: 1800, decay: 0.1, gain: 0.3 * g }),
          tone(v, { freq: 900, freqEnd: 1600, glide: 0.04, at: 0.05, decay: 0.04, gain: 0.1 * g }),
        );
      case 'glass':
        // M2b: a bright glassy clink and ring, higher than the prop clink.
        return Math.max(
          click(v, 0, 4800, 0.45 * g, 5, 0.008),
          bell(v, 0, 3300 + 600 * v.intensity, 0.2 * g, 0.2, [[1, 1], [1.53, 0.45], [2.41, 0.25]]),
          tone(v, { type: 'triangle', freq: 900, decay: 0.03, gain: 0.12 * g }),
        );
      case 'prop':
      case 'edge':
        return Math.max(
          click(v, 0, 2600, 0.5 * g, 6, 0.01),
          bell(v, 0, 1700 + 500 * v.intensity, 0.18 * g, 0.12, [[1, 1], [2.7, 0.4]]),
          tone(v, { type: 'triangle', freq: 700, decay: 0.05, gain: 0.2 * g }),
        );
      default: // terrain: a sand thud with a small casing tink
        return Math.max(
          noise(v, { color: 'brown', filter: 'lowpass', freq: 500, decay: 0.08, gain: 0.6 * g }),
          noise(v, { color: 'pink', filter: 'bandpass', freq: 1300, decay: 0.05, gain: 0.3 * g }),
          tone(v, { freq: 160, freqEnd: 90, glide: 0.05, decay: 0.06, gain: 0.3 * g }),
          click(v, 0, 2900, 0.15 * g),
        );
    }
  },
  // Variant 'ground' | 'water'. Delayed by distance / speed of sound; the engine adds distance gain and air low-pass.
  // Far away: less crack, more rolling echo. Water: a muffled boom under a geyser of spray.
  explosion: (v) => {
    const at = soundDelay(v);
    const far = farness(v);
    const water = v.variant === 'water';
    let end = Math.max(
      tone(v, { freq: 75, freqEnd: 28, glide: 0.5, at, attack: 0.004, decay: 0.9, gain: water ? 0.6 : 1 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: water ? 600 : 1400, freqEnd: 180, glide: 0.6, at, attack: 0.003, decay: 1, gain: 0.9 }),
      noise(v, { filter: 'highpass', freq: 2200, at, decay: far > 0.5 ? 0.02 : 0.08, gain: (1 - 0.8 * far) * (water ? 0.3 : 0.7) }),
      tone(v, { type: 'sawtooth', freq: 220, freqEnd: 40, glide: 0.25, at, decay: 0.3, gain: 0.25, lowpass: 900 }),
      noise(v, { color: 'brown', filter: 'lowpass', freq: 450, at: at + 0.35, attack: 0.08, decay: 0.9, gain: 0.15 + 0.35 * far }),
    );
    if (water) {
      end = Math.max(
        end,
        splash(v, at + 0.05, 0.8, 0.9),
        noise(v, { filter: 'bandpass', freq: 2400, freqEnd: 700, glide: 1.2, q: 0.6, at: at + 0.3, attack: 0.1, decay: 1.2, gain: 0.35 }),
      );
    } else if (far < 0.6) {
      end = Math.max(end, crackle(v, at + 0.15, 6, 0.6, 1200, 3200, 0.2)); // sand and pebbles raining down
    }
    return end;
  },
  // Ear ring inside the blast radius: two close sines (beating), longer and louder the closer the blast.
  'explosion.ring': (v) => {
    const i = Math.max(0.2, Math.min(1, v.intensity));
    const len = 0.8 + 1.6 * i;
    const [g, end] = envGain(v, v.out, 0.05, 0.5 + 0.5 * i, 0.04, len * 0.2, len * 0.8);
    const a = rawOsc(v, 'sine', 0.05, end);
    a.frequency.value = 3600 * v.pitch;
    a.connect(g);
    const b = rawOsc(v, 'sine', 0.05, end);
    b.frequency.value = 3613 * v.pitch;
    b.connect(gainNode(v, 0.5, g));
    return end;
  },

  // --- Tide -------------------------------------------------------------------------------
  // Conch horn then two lifeguard whistle blasts (three in later phases).
  // Variant = zone theme: the conch on the island; indoors a two-tone PA chime instead. Same whistles after.
  'zone.warning': (v) => {
    let end =
      v.variant === 'sprinklers' || v.variant === 'lightsOut'
        ? Math.max(bell(v, 0, midiHz(76), 0.45, 0.9, [[1, 1], [2, 0.25], [3, 0.1]]), bell(v, 0.4, midiHz(72), 0.45, 1.1, [[1, 1], [2, 0.25], [3, 0.1]]))
        : hornNote(v, 0, 196, 0.55, 0.7);
    end = Math.max(end, whistle(v, 1.15, 0.22, 0.35));
    end = Math.max(end, whistle(v, 1.5, 0.4, 0.35));
    if (v.intensity >= 1) end = Math.max(end, whistle(v, 2.05, 0.4, 0.35, 2700));
    return end;
  },
  'zone.tideRising': (v) =>
    Math.max(
      noise(v, { color: 'brown', filter: 'lowpass', freq: 250, freqEnd: 1600, glide: 2.2, q: 0.6, attack: 1.2, hold: 0.8, decay: 1.8, gain: 0.8 }),
      noise(v, { color: 'pink', filter: 'highpass', freq: 2500, at: 0.6, attack: 1.2, decay: 1.5, gain: 0.15 }),
    ),
  'zone.tideLoop': (v) => {
    const until = v.t + Math.max(1, v.durationS);
    const { filter } = loopNoise(v, { buffer: v.noise.brownLoop, filter: 'lowpass', freq: 420, q: 0.5, gain: 0.45, fadeIn: 2, until });
    lfo(v, filter.frequency, 0.17, 150, until);
    return until - v.t;
  },
  'zone.hurtTick': (v) =>
    Math.max(
      tone(v, { freq: 540, freqEnd: 260, glide: 0.1, decay: 0.13, gain: 0.5 }),
      noise(v, { filter: 'bandpass', freq: 2200, freqEnd: 700, glide: 0.15, q: 1.2, decay: 0.16, gain: 0.45 }),
      click(v, 0, 3500, 0.15),
    ),
  'zone.enterSurf': (v) => Math.max(splash(v, 0, 0.7, 0.4), noise(v, { color: 'brown', filter: 'lowpass', freq: 600, decay: 0.3, gain: 0.5 })),
  'zone.exitSurf': (v) =>
    Math.max(
      noise(v, { filter: 'highpass', freq: 3000, decay: 0.12, gain: 0.2 }),
      tone(v, { freq: 700, freqEnd: 1400, glide: 0.1, decay: 0.1, gain: 0.25 }),
      bell(v, 0.06, 1568, 0.15, 0.25),
    ),

  // --- Sprinklers and lights out (M2b office themes) ---------------------------------------
  // Pipes knock and the pressure comes up: a clunk, a gurgle, then a hiss swelling to rain.
  'zone.sprinklerStart': (v) =>
    Math.max(
      tone(v, { type: 'triangle', freq: 110, freqEnd: 80, glide: 0.08, decay: 0.18, gain: 0.5 }),
      click(v, 0, 900, 0.4, 2, 0.04),
      tone(v, { type: 'triangle', freq: 95, at: 0.35, decay: 0.15, gain: 0.35 }),
      noise(v, { color: 'brown', filter: 'bandpass', freq: 380, freqEnd: 700, glide: 0.5, q: 2, at: 0.4, attack: 0.1, decay: 0.4, gain: 0.25 }),
      noise(v, { color: 'pink', filter: 'highpass', freq: 1500, freqEnd: 4000, glide: 2, at: 0.6, attack: 1.2, hold: 0.5, decay: 1.3, gain: 0.45 }),
    ),
  // Distant rain hiss while the zone shrinks (the tide loop's sibling).
  'zone.sprinklerLoop': (v) => {
    const until = v.t + Math.max(1, v.durationS);
    const { filter } = loopNoise(v, { buffer: v.noise.pinkLoop, filter: 'bandpass', freq: 2800, q: 0.5, gain: 0.35, fadeIn: 2, until });
    lfo(v, filter.frequency, 0.13, 500, until);
    loopNoise(v, { buffer: v.noise.brownLoop, filter: 'lowpass', freq: 500, q: 0.5, gain: 0.2, fadeIn: 2.5, until, rate: 1.3 });
    return until - v.t;
  },
  // Stepping into the rain: a spray burst on your head and shoulders, plus a few fat drops.
  'zone.enterSpray': (v) => {
    let end = noise(v, { filter: 'highpass', freq: 2000, freqEnd: 3500, glide: 0.2, attack: 0.02, decay: 0.45, gain: 0.55 });
    end = Math.max(end, noise(v, { color: 'brown', filter: 'lowpass', freq: 700, attack: 0.01, decay: 0.25, gain: 0.35 }));
    for (let i = 0; i < 4; i++) {
      const f = 1100 + v.rand() * 900;
      end = Math.max(end, tone(v, { freq: f, freqEnd: f * 1.5, glide: 0.03, at: 0.03 + v.rand() * 0.3, decay: 0.035, gain: 0.12 }));
    }
    return end;
  },
  // Out of the rain: the hiss falls away and a couple of drips.
  'zone.exitSpray': (v) =>
    Math.max(
      noise(v, { filter: 'highpass', freq: 3000, freqEnd: 1800, glide: 0.25, decay: 0.25, gain: 0.25 }),
      tone(v, { freq: 1300, freqEnd: 2000, glide: 0.03, at: 0.12, decay: 0.04, gain: 0.15 }),
      tone(v, { freq: 1000, freqEnd: 1500, glide: 0.03, at: 0.32, decay: 0.04, gain: 0.1 }),
    ),
  // Lights out: 'down' = a relay clunk and the tubes winding down; 'enter' = a soft clunk into the dark; 'exit' = a
  // flicker of tube ticks as the light comes back.
  'zone.lights': (v) => {
    if (v.variant === 'exit') return Math.max(crackle(v, 0, 5, 0.25, 2500, 4500, 0.25), tone(v, { type: 'sawtooth', freq: 120, at: 0.2, decay: 0.15, gain: 0.08, lowpass: 2500 }));
    const big = v.variant === 'down';
    return Math.max(
      tone(v, { type: 'triangle', freq: 140, freqEnd: 90, glide: 0.05, decay: 0.12, gain: 0.5 }),
      click(v, 0, 1200, 0.4, 2, 0.03),
      tone(v, { type: 'sawtooth', freq: 120, freqEnd: 40, glide: big ? 1.2 : 0.3, attack: 0.01, decay: big ? 1.3 : 0.35, gain: 0.12, lowpass: 1800 }),
    );
  },

  // --- UI ---------------------------------------------------------------------------------
  'ui.click': (v) =>
    Math.max(tone(v, { type: 'triangle', freq: 1100, freqEnd: 1500, glide: 0.03, decay: 0.045, gain: 0.5 }), tone(v, { freq: 2200, decay: 0.02, gain: 0.15 })),
  'ui.hover': (v) => tone(v, { freq: 1800, decay: 0.025, gain: 0.5 }),
  'ui.slider': (v) => tone(v, { freq: 1300, decay: 0.02, gain: 0.5 }),
  'ui.countdown': (v) =>
    v.intensity >= 1
      ? bell(v, 0, 1174.7, 0.6, 0.35, [[1, 1], [4, 0.25], [10, 0.05]])
      : bell(v, 0, 880, 0.5, 0.25, [[1, 1], [4, 0.25], [10, 0.05]]),
  'ui.matchStart': (v) => {
    let end = whistle(v, 0, 0.35, 0.35, 2400);
    [72, 76, 79, 84].forEach((m, i) => {
      end = Math.max(end, pluck(v, 0.05 + i * 0.02, midiHz(m), 0.25, 0.6));
    });
    return Math.max(end, bell(v, 0.1, 2093, 0.2, 0.5));
  },
  // Steel-drum arpeggio up to a held chord.
  'ui.victory': (v) => {
    const steel = [[1, 1], [2, 0.4], [2.76, 0.18], [5.1, 0.05]] as const;
    let end = 0;
    [67, 72, 76, 79].forEach((m, i) => {
      end = Math.max(end, bell(v, i * 0.11, midiHz(m), 0.4, 0.5, steel));
    });
    for (const m of [72, 76, 79, 84]) end = Math.max(end, bell(v, 0.5, midiHz(m), 0.3, 1.4, steel));
    return Math.max(end, noise(v, { filter: 'highpass', freq: 7000, at: 0.5, attack: 0.02, decay: 0.8, gain: 0.05 }));
  },
  // Sad trombone "wah wah wah waaah", gentle and cartoonish ("washed out", not "dead").
  'ui.defeat': (v) => {
    let end = 0;
    [58, 57, 56].forEach((m, i) => {
      end = Math.max(end, brassNote(v, i * 0.4, midiHz(m), 0.25, 0.4, 0));
    });
    return Math.max(end, brassNote(v, 1.2, midiHz(55), 0.9, 0.4, 4));
  },
  // Two warm ukulele strums: "the tide's gone out".
  'ui.results': (v) => {
    let end = 0;
    [65, 69, 72].forEach((m, i) => {
      end = Math.max(end, pluck(v, i * 0.03, midiHz(m), 0.2, 0.6));
    });
    [60, 64, 67, 72].forEach((m, i) => {
      end = Math.max(end, pluck(v, 0.3 + i * 0.03, midiHz(m), 0.2, 0.9));
    });
    return end;
  },
  'ui.prompt': (v) => tone(v, { freq: v.variant === 'weapon' ? 1300 : 1600, decay: 0.03, gain: 0.4 }),
  'ui.spectate': (v) =>
    Math.max(
      noise(v, { color: 'pink', filter: 'bandpass', freq: 600, freqEnd: 1800, glide: 0.2, attack: 0.05, decay: 0.15, gain: 0.4 }),
      tone(v, { freq: 900, at: 0.12, decay: 0.1, gain: 0.15 }),
    ),
  // Soft "nope": two muted, falling wooden bloops (marimba-ish triangles through a low-pass). Variants are
  // ActionFailReason: 'noAmmo' is a little lower and drier so an empty reserve reads differently from a full bag.
  'ui.nope': (v) => {
    const low = v.variant === 'noAmmo' ? 0.84 : 1;
    const f1 = 494 * low;
    const f2 = 392 * low;
    return Math.max(
      tone(v, { type: 'triangle', freq: f1, freqEnd: f1 * 0.94, glide: 0.06, decay: 0.07, gain: 0.32, lowpass: 1800 }),
      tone(v, { type: 'triangle', freq: f2, freqEnd: f2 * 0.92, glide: 0.08, at: 0.09, decay: 0.11, gain: 0.3, lowpass: 1500 }),
      noise(v, { color: 'pink', filter: 'bandpass', freq: 1200 * low, q: 3, decay: 0.02, gain: 0.08 }),
    );
  },
  'ui.error': (v) =>
    Math.max(
      tone(v, { type: 'square', freq: 220, decay: 0.1, gain: 0.15, lowpass: 1200 }),
      tone(v, { type: 'square', freq: 196, at: 0.14, decay: 0.12, gain: 0.15, lowpass: 1200 }),
    ),

  // --- Ambience ---------------------------------------------------------------------------
  // Distant typing: a burst of 3-9 key clicks with human timing, the odd heavier space bar.
  'amb.keys': (v) => {
    const n = 3 + Math.floor(v.rand() * 7);
    let t = 0;
    let end = 0;
    for (let i = 0; i < n; i++) {
      const space = v.rand() < 0.15;
      end = Math.max(end, click(v, t, space ? 1500 : 2600 + v.rand() * 1200, space ? 0.5 : 0.35, 3, space ? 0.02 : 0.01));
      t += 0.07 + v.rand() * 0.12;
    }
    return end;
  },
  'amb.gull': (v) => {
    let end = Math.max(gullCall(v, 0), gullCall(v, 0.24));
    if (v.rand() < 0.5) end = Math.max(end, gullCall(v, 0.5));
    return end;
  },
};

function pump(v: Voice, at: number, g: number): number {
  return Math.max(
    noise(v, { filter: 'bandpass', freq: 1000, freqEnd: 2400, glide: 0.07, q: 2, at, attack: 0.005, decay: 0.07, gain: 0.35 * g }),
    click(v, at + 0.08, 2000, 0.45 * g),
    click(v, at + 0.14, 1500, 0.4 * g),
  );
}

function shotgun(v: Voice, g: number): number {
  return Math.max(
    tone(v, { freq: 150, freqEnd: 42, glide: 0.18, decay: 0.28, gain: 0.9 * g }),
    noise(v, { color: 'brown', filter: 'lowpass', freq: 1400, freqEnd: 250, glide: 0.25, decay: 0.3, gain: 0.8 }),
    noise(v, { filter: 'bandpass', freq: 1600, q: 0.8, decay: 0.07, gain: 0.6 }),
    click(v, 0.005, 2400, 0.35),
    click(v, 0.02, 1900, 0.3),
    pump(v, 0.42, g),
    distantTail(v, 0.5),
  );
}
