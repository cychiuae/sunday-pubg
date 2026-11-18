/**
 * Persistent ambience beds: slow ocean swells, foam hiss that trails each swell, light wind, and a surf-roar layer
 * that fades in while the local player stands in the tide. All modulation runs on audio-rate LFOs, so there is no
 * per-frame work. Gull calls are one-shot voices scheduled by the AudioEngine. Owner: audio-designer.
 */
import type { NoiseBank } from './noise';

export class Ambience {
  private readonly nodes: AudioNode[] = [];
  private readonly sources: AudioScheduledSourceNode[] = [];
  private readonly bed: GainNode;
  private readonly surf: GainNode;
  private readonly waveBoost: GainNode;

  constructor(
    private readonly ctx: BaseAudioContext,
    noise: NoiseBank,
    dest: AudioNode,
  ) {
    const now = ctx.currentTime;
    this.bed = this.gain(0, dest);
    this.bed.gain.setValueAtTime(0, now);
    this.bed.gain.linearRampToValueAtTime(1, now + 2.5);

    // Swell LFO: two slow sines at incommensurate rates so the sea never loops audibly.
    const swell = this.gain(1, null);
    this.lfoInto(swell, 0.11, 1);
    this.lfoInto(swell, 0.071, 0.6);

    // Waves: brown noise, low-passed; the swell opens the filter and raises the level together.
    this.waveBoost = this.gain(1, this.bed);
    const waveGain = this.gain(0.5, this.waveBoost);
    const waveLp = this.filter('lowpass', 420, 0.5, waveGain);
    this.loop(noise.brownLoop, 1, waveLp);
    swell.connect(this.gain(150, waveLp.frequency));
    swell.connect(this.gain(0.2, waveGain.gain));

    // Foam: bright hiss that peaks ~1.4 s after each swell crest (the wave breaking on sand).
    const foamGain = this.gain(0.035, this.waveBoost);
    const foamHp = this.filter('highpass', 1900, 0.5, foamGain);
    this.loop(noise.pinkLoop, 1, foamHp);
    const delay = ctx.createDelay(3);
    delay.delayTime.value = 1.4;
    this.nodes.push(delay);
    swell.connect(delay);
    delay.connect(this.gain(0.025, foamGain.gain));

    // Wind: band-passed pink noise drifting slowly in pitch and level.
    const windGain = this.gain(0.05, this.bed);
    const windBp = this.filter('bandpass', 550, 0.6, windGain);
    this.loop(noise.pinkLoop, 0.83, windBp);
    this.lfoInto(windBp.frequency, 0.05, 200);
    this.lfoInto(windGain.gain, 0.033, 0.03);

    // Surf roar: silent until the player is in the tide.
    this.surf = this.gain(0, this.bed);
    const surfLp = this.filter('lowpass', 1300, 0.5, this.surf);
    this.loop(noise.brownLoop, 1.3, surfLp);
    this.lfoInto(surfLp.frequency, 0.4, 300);
  }

  /** In the tide: louder, closer waves plus surf roar. */
  setSurf(active: boolean): void {
    const now = this.ctx.currentTime;
    this.surf.gain.setTargetAtTime(active ? 0.35 : 0, now, 0.4);
    this.waveBoost.gain.setTargetAtTime(active ? 1.6 : 1, now, 0.5);
  }

  dispose(): void {
    const now = this.ctx.currentTime;
    for (const s of this.sources) {
      try {
        s.stop(now);
      } catch {
        // already stopped
      }
    }
    for (const n of this.nodes) n.disconnect();
    this.nodes.length = 0;
    this.sources.length = 0;
  }

  private gain(value: number, dest: AudioNode | AudioParam | null): GainNode {
    const g = this.ctx.createGain();
    g.gain.value = value;
    if (dest && isParam(dest)) g.connect(dest);
    else if (dest) g.connect(dest);
    this.nodes.push(g);
    return g;
  }

  private filter(type: BiquadFilterType, freq: number, q: number, dest: AudioNode): BiquadFilterNode {
    const f = this.ctx.createBiquadFilter();
    f.type = type;
    f.frequency.value = freq;
    f.Q.value = q;
    f.connect(dest);
    this.nodes.push(f);
    return f;
  }

  private loop(buffer: AudioBuffer, rate: number, dest: AudioNode): void {
    const src = this.ctx.createBufferSource();
    src.buffer = buffer;
    src.loop = true;
    src.playbackRate.value = rate;
    src.connect(dest);
    src.start(this.ctx.currentTime, Math.random() * buffer.duration * 0.9);
    this.sources.push(src);
    this.nodes.push(src);
  }

  /** Sine LFO (amplitude `depth`) summed into a node input or an AudioParam. */
  private lfoInto(dest: AudioNode | AudioParam, rateHz: number, depth: number): void {
    const osc = this.ctx.createOscillator();
    osc.frequency.value = rateHz;
    const g = this.gain(depth, dest);
    osc.connect(g);
    osc.start(this.ctx.currentTime);
    this.sources.push(osc);
    this.nodes.push(osc);
  }
}

/** AudioParams are recognised structurally (`instanceof AudioParam` is unavailable in node tests). */
const isParam = (x: AudioNode | AudioParam): x is AudioParam => !('connect' in x);
