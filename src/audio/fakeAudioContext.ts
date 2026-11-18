/**
 * Minimal structural fake of the Web Audio API for node tests (vitest runs with environment 'node').
 * Records every created node and its connect/disconnect/start/stop calls. Not used at runtime.
 * Owner: audio-designer.
 */

export class FakeParam {
  value: number;
  readonly calls: string[] = [];
  constructor(v = 0) {
    this.value = v;
  }
  private rec(name: string, v?: number): this {
    this.calls.push(name);
    if (v !== undefined && Number.isNaN(v)) throw new Error(`FakeParam.${name}: NaN`);
    return this;
  }
  setValueAtTime(v: number, t: number): this {
    if (t < 0 || !Number.isFinite(t)) throw new Error(`setValueAtTime: bad time ${t}`);
    this.value = v;
    return this.rec('set', v);
  }
  linearRampToValueAtTime(v: number, t: number): this {
    if (!Number.isFinite(t)) throw new Error(`linearRamp: bad time ${t}`);
    return this.rec('linear', v);
  }
  exponentialRampToValueAtTime(v: number, t: number): this {
    // Real browsers throw RangeError for non-positive targets.
    if (!(v > 0)) throw new RangeError(`exponentialRamp to ${v}`);
    if (!Number.isFinite(t)) throw new Error(`expRamp: bad time ${t}`);
    return this.rec('exp', v);
  }
  setTargetAtTime(v: number, _t: number, tc: number): this {
    if (!(tc > 0)) throw new RangeError('timeConstant must be > 0');
    this.value = v;
    return this.rec('target', v);
  }
  cancelScheduledValues(_t: number): this {
    return this.rec('cancel');
  }
}

let nextNodeId = 1;

export class FakeNode {
  readonly id = nextNodeId++;
  readonly outputs: (FakeNode | FakeParam)[] = [];
  connected = 0;
  disconnected = 0;
  started: number | null = null;
  stopped: number | null = null;
  // Params (only some are meaningful per node kind; extra ones are harmless).
  readonly gain = new FakeParam(1);
  readonly frequency = new FakeParam(440);
  readonly detune = new FakeParam(0);
  readonly Q = new FakeParam(1);
  readonly playbackRate = new FakeParam(1);
  readonly delayTime = new FakeParam(0);
  readonly threshold = new FakeParam(-24);
  readonly knee = new FakeParam(30);
  readonly ratio = new FakeParam(12);
  readonly attack = new FakeParam(0.003);
  readonly release = new FakeParam(0.25);
  readonly positionX = new FakeParam(0);
  readonly positionY = new FakeParam(0);
  readonly positionZ = new FakeParam(0);
  type = '';
  buffer: FakeBuffer | null = null;
  loop = false;
  panningModel = 'equalpower';
  distanceModel = 'inverse';
  rolloffFactor = 1;
  normalize = true;
  refDistance = 1;
  maxDistance = 10000;
  onended: (() => void) | null = null;

  constructor(readonly kind: string) {}

  connect<T extends FakeNode | FakeParam>(dest: T): T {
    if (!dest) throw new Error('connect: no destination');
    this.outputs.push(dest);
    this.connected++;
    return dest;
  }
  disconnect(): void {
    this.disconnected++;
    this.outputs.length = 0;
  }
  start(when = 0): void {
    if (this.started !== null) throw new Error('InvalidStateError: start called twice');
    if (!Number.isFinite(when)) throw new Error('start: bad time');
    this.started = when;
  }
  stop(when = 0): void {
    if (this.started === null) throw new Error('InvalidStateError: stop before start');
    this.stopped = when;
  }
  setPosition(): void {}
  setOrientation(): void {}
}

export class FakeBuffer {
  private readonly channels: Float32Array[];
  constructor(
    readonly numberOfChannels: number,
    readonly length: number,
    readonly sampleRate: number,
  ) {
    this.channels = Array.from({ length: numberOfChannels }, () => new Float32Array(length));
  }
  get duration(): number {
    return this.length / this.sampleRate;
  }
  getChannelData(c: number): Float32Array {
    const ch = this.channels[c];
    if (!ch) throw new Error('bad channel');
    return ch;
  }
}

export class FakeAudioContext {
  currentTime = 0;
  readonly sampleRate: number;
  state: 'suspended' | 'running' | 'closed' = 'running';
  readonly destination = new FakeNode('destination');
  readonly nodes: FakeNode[] = [];
  readonly listener = {
    positionX: new FakeParam(),
    positionY: new FakeParam(),
    positionZ: new FakeParam(),
    forwardX: new FakeParam(),
    forwardY: new FakeParam(),
    forwardZ: new FakeParam(-1),
    upX: new FakeParam(),
    upY: new FakeParam(1),
    upZ: new FakeParam(),
    setPosition(): void {},
    setOrientation(): void {},
  };
  resumeCalls = 0;

  constructor(sampleRate = 8000) {
    this.sampleRate = sampleRate;
  }

  private make(kind: string): FakeNode {
    const n = new FakeNode(kind);
    this.nodes.push(n);
    return n;
  }
  createGain(): FakeNode {
    return this.make('gain');
  }
  createBiquadFilter(): FakeNode {
    const n = this.make('biquad');
    n.type = 'lowpass';
    return n;
  }
  createOscillator(): FakeNode {
    const n = this.make('oscillator');
    n.type = 'sine';
    return n;
  }
  createBufferSource(): FakeNode {
    return this.make('bufferSource');
  }
  createPanner(): FakeNode {
    return this.make('panner');
  }
  createDelay(): FakeNode {
    return this.make('delay');
  }
  createConvolver(): FakeNode {
    return this.make('convolver');
  }
  createDynamicsCompressor(): FakeNode {
    return this.make('compressor');
  }
  createBuffer(channels: number, length: number, rate: number): FakeBuffer {
    return new FakeBuffer(channels, length, rate);
  }
  resume(): Promise<void> {
    this.resumeCalls++;
    if (this.state !== 'closed') this.state = 'running';
    return Promise.resolve();
  }
  suspend(): Promise<void> {
    this.state = 'suspended';
    return Promise.resolve();
  }
  close(): Promise<void> {
    this.state = 'closed';
    return Promise.resolve();
  }

  /** Typed as the real thing for code under test. */
  asAudioContext(): AudioContext {
    return this as unknown as AudioContext;
  }
}

/** Deterministic [0,1) source for tests. */
export function seededRand(seed = 1): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
