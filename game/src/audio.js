// Cloudhaven Air Rally — procedural audio.
//
// Every sound is synthesised with WebAudio; there are no audio files.
//   engine : sawtooth → lowpass + sub sine, pitch/filter follow throttle & RPM
//   wind   : looped noise → bandpass, gain follows airspeed
//   one-shots: ring chime, fuel sparkle, touchdown thud, crash crunch, UI click
//
// Browsers only allow audio after a user gesture, so call start() from a click
// or key handler. Every public method is a silent no-op if WebAudio is missing,
// not started yet, or throws for any reason — the game never depends on sound.

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

const MASTER_GAIN = 0.8;
const SMOOTH = 0.08;          // s, time constant for continuous parameter changes
const RPM_IDLE = 600;
const RPM_REDLINE = 2700;

export class GameAudio {
  constructor() {
    this.ctx = null;
    this.muted = false;
    this.nodes = null;
    this._noiseBuffer = null;
    this._failed = false;
    const AC = typeof window !== 'undefined' ? (window.AudioContext || window.webkitAudioContext) : null;
    this._AC = AC || null;
  }

  /** True if WebAudio exists in this browser (it may still need start()). */
  get available() {
    return !!this._AC && !this._failed;
  }

  /** Create/resume the AudioContext. Call from a user gesture. Returns true on success. */
  start() {
    if (!this.available) return false;
    try {
      if (!this.ctx || this.ctx.state === 'closed') {
        this.ctx = new this._AC({ latencyHint: 'interactive' });
        this._build();
        this._unlock();
      }
      if (this.ctx.state === 'suspended' && this.ctx.resume) {
        const p = this.ctx.resume();
        if (p && p.catch) p.catch(() => {});
      }
      return true;
    } catch (e) {
      this._failed = true;
      this.ctx = null;
      this.nodes = null;
      return false;
    }
  }

  /** Update the continuous engine and wind sounds; call once per frame. */
  setFlight(throttle, speed, onGround) {
    if (!this._ready()) return;
    try {
      const n = this.nodes;
      const t = this.ctx.currentTime;
      const thr = clamp(num(throttle), 0, 1);
      const spd = Math.max(0, num(speed));

      // RPM from throttle plus some windmilling with airspeed (as on the tachometer).
      const rpm = clamp(RPM_IDLE + 1800 * thr + spd * 3, 0, 2950);
      const rpmN = rpm / RPM_REDLINE; // ≈ 0.22 idle … ≈ 1 full power

      const f0 = 34 + rpmN * 78;     // firing fundamental, Hz
      n.saw.frequency.setTargetAtTime(f0, t, SMOOTH * 2);
      n.sub.frequency.setTargetAtTime(f0 / 2, t, SMOOTH * 2);
      n.lfo.frequency.setTargetAtTime(4 + rpmN * 9, t, SMOOTH * 2);
      n.filter.frequency.setTargetAtTime(220 + rpmN * 1500 + thr * 500, t, SMOOTH);
      n.engineGain.gain.setTargetAtTime(0.06 + thr * 0.1 + rpmN * 0.03, t, SMOOTH);

      // Wind: rises roughly with dynamic pressure (∝ v²); rolling on the
      // ground adds a lower, rumblier tone.
      const v = clamp(spd / 70, 0, 1.3);
      const air = onGround ? 0.55 : 1;
      n.windGain.gain.setTargetAtTime(v * v * 0.24 * air + (onGround && spd > 1 ? 0.03 * v : 0), t, SMOOTH * 2);
      n.windFilter.frequency.setTargetAtTime(onGround ? 250 + spd * 12 : 380 + spd * 26, t, SMOOTH * 2);
    } catch (e) { /* stay silent */ }
  }

  /** Pleasant rising two-note chime for passing a ring. */
  ringChime() {
    if (!this._canPlay()) return;
    try {
      const t = this.ctx.currentTime + 0.005;
      const out = this.nodes.fx;
      for (const [freq, at] of [[659.25, 0], [987.77, 0.11]]) { // E5 → B5
        this._tone('sine', freq, t + at, 0.22, 0.008, 0.7, out);
        this._tone('triangle', freq * 2, t + at, 0.05, 0.005, 0.35, out);
      }
    } catch (e) { /* stay silent */ }
  }

  /** Higher, quicker sparkle for a fuel ring. */
  fuelChime() {
    if (!this._canPlay()) return;
    try {
      const t = this.ctx.currentTime + 0.005;
      const out = this.nodes.fx;
      const notes = [1046.5, 1318.5, 1568.0, 2093.0]; // C6 E6 G6 C7
      notes.forEach((freq, i) => {
        this._tone('triangle', freq, t + i * 0.05, 0.12, 0.004, 0.32, out);
        this._tone('sine', freq * 2.01, t + i * 0.05, 0.035, 0.003, 0.2, out);
      });
      this._playNoiseBurst(t, 0.35, 0.03, 'highpass', 6000, 9000, out);
    } catch (e) { /* stay silent */ }
  }

  /** Low thud plus a short tyre chirp for touchdown. */
  touchdown() {
    if (!this._canPlay()) return;
    try {
      const t = this.ctx.currentTime + 0.005;
      const out = this.nodes.fx;
      this._tone('sine', 110, t, 0.5, 0.004, 0.28, out, 42);
      this._playNoiseBurst(t, 0.12, 0.22, 'lowpass', 500, 180, out);
      this._playNoiseBurst(t + 0.01, 0.07, 0.05, 'bandpass', 2600, 2200, out);
    } catch (e) { /* stay silent */ }
  }

  /** Heavy crunch: noise bursts sweeping down plus a falling low sine. */
  crash() {
    if (!this._canPlay()) return;
    try {
      const t = this.ctx.currentTime + 0.005;
      const out = this.nodes.fx;
      this._playNoiseBurst(t, 1.1, 0.75, 'lowpass', 3200, 160, out);
      this._tone('sine', 95, t, 0.7, 0.005, 0.9, out, 26);
      this._tone('square', 58, t, 0.08, 0.005, 0.35, out, 30);
      for (const [at, peak] of [[0.06, 0.4], [0.17, 0.3], [0.31, 0.22], [0.48, 0.14]]) {
        this._playNoiseBurst(t + at, 0.12, peak, 'bandpass', 1400 - at * 1200, 600, out);
      }
      // Duck the engine so the impact reads clearly; setFlight restores it.
      this.nodes.engineGain.gain.setTargetAtTime(0.0001, t, 0.05);
    } catch (e) { /* stay silent */ }
  }

  /** Soft UI click. */
  click() {
    if (!this._canPlay()) return;
    try {
      const t = this.ctx.currentTime + 0.002;
      const out = this.nodes.fx;
      this._tone('sine', 1800, t, 0.07, 0.001, 0.035, out, 1200);
      this._playNoiseBurst(t, 0.015, 0.02, 'highpass', 3000, 3000, out);
    } catch (e) { /* stay silent */ }
  }

  /** Mute or unmute everything (fades quickly to avoid clicks). */
  setMuted(muted) {
    this.muted = !!muted;
    if (!this._ready()) return;
    try {
      this.nodes.master.gain.setTargetAtTime(this.muted ? 0 : MASTER_GAIN, this.ctx.currentTime, 0.03);
    } catch (e) { /* stay silent */ }
  }

  // ---- Internals ----------------------------------------------------------

  _ready() {
    return !!(this.ctx && this.nodes && this.ctx.state !== 'closed');
  }

  _canPlay() {
    return this._ready() && !this.muted && this.ctx.state === 'running';
  }

  _build() {
    const ac = this.ctx;

    const master = ac.createGain();
    master.gain.value = this.muted ? 0 : MASTER_GAIN;
    const comp = ac.createDynamicsCompressor();
    comp.threshold.value = -14;
    comp.knee.value = 12;
    comp.ratio.value = 4;
    comp.attack.value = 0.004;
    comp.release.value = 0.2;
    master.connect(comp);
    comp.connect(ac.destination);

    // Engine: sawtooth through a resonant lowpass plus a sub sine an octave down.
    const engineGain = ac.createGain();
    engineGain.gain.value = 0;
    engineGain.connect(master);

    const filter = ac.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 400;
    filter.Q.value = 1.4;
    filter.connect(engineGain);

    const saw = ac.createOscillator();
    saw.type = 'sawtooth';
    saw.frequency.value = 50;
    const sawGain = ac.createGain();
    sawGain.gain.value = 0.55;
    saw.connect(sawGain);
    sawGain.connect(filter);

    const sub = ac.createOscillator();
    sub.type = 'sine';
    sub.frequency.value = 25;
    const subGain = ac.createGain();
    subGain.gain.value = 0.9;
    sub.connect(subGain);
    subGain.connect(engineGain);

    // Slight cylinder-beat wobble on the saw pitch.
    const lfo = ac.createOscillator();
    lfo.type = 'sine';
    lfo.frequency.value = 6;
    const lfoGain = ac.createGain();
    lfoGain.gain.value = 9; // cents
    lfo.connect(lfoGain);
    lfoGain.connect(saw.detune);

    // Wind: looped noise through a bandpass.
    // Generated once here and reused by the wind loop and every noise burst.
    this._noiseBuffer = this._makeNoiseBuffer(2);
    const wind = ac.createBufferSource();
    wind.buffer = this._noiseBuffer;
    wind.loop = true;
    const windFilter = ac.createBiquadFilter();
    windFilter.type = 'bandpass';
    windFilter.frequency.value = 500;
    windFilter.Q.value = 0.6;
    const windGain = ac.createGain();
    windGain.gain.value = 0;
    wind.connect(windFilter);
    windFilter.connect(windGain);
    windGain.connect(master);

    // One-shot effects bus.
    const fx = ac.createGain();
    fx.gain.value = 0.9;
    fx.connect(master);

    saw.start();
    sub.start();
    lfo.start();
    wind.start();

    this.nodes = { master, comp, engineGain, filter, saw, sub, lfo, wind, windFilter, windGain, fx };
  }

  /** Play a silent buffer: unlocks audio on iOS/Safari inside the gesture. */
  _unlock() {
    try {
      const b = this.ctx.createBuffer(1, 1, this.ctx.sampleRate);
      const s = this.ctx.createBufferSource();
      s.buffer = b;
      s.connect(this.ctx.destination);
      s.start(0);
    } catch (e) { /* ignore */ }
  }

  /** Mildly pink-tilted noise (one-pole lowpass on white noise). */
  _makeNoiseBuffer(seconds) {
    const ac = this.ctx;
    const len = Math.max(1, Math.floor(ac.sampleRate * seconds));
    const buf = ac.createBuffer(1, len, ac.sampleRate);
    const data = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      const white = Math.random() * 2 - 1;
      last = last * 0.6 + white * 0.4;
      data[i] = last * 1.6;
    }
    return buf;
  }

  /** Enveloped oscillator; optional exponential pitch glide to freqEnd. */
  _tone(type, freq, t, peak, attack, decay, dest, freqEnd) {
    const ac = this.ctx;
    const osc = ac.createOscillator();
    const g = ac.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t);
    if (freqEnd) osc.frequency.exponentialRampToValueAtTime(Math.max(1, freqEnd), t + attack + decay);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + attack);
    g.gain.exponentialRampToValueAtTime(0.0001, t + attack + decay);
    osc.connect(g);
    g.connect(dest);
    osc.onended = () => {
      try { osc.disconnect(); g.disconnect(); } catch (e) { /* ignore */ }
    };
    osc.start(t);
    osc.stop(t + attack + decay + 0.05);
  }

  /** Enveloped noise burst through a filter sweeping f0 → f1. */
  _playNoiseBurst(t, dur, peak, filterType, f0, f1, dest) {
    const ac = this.ctx;
    if (!this._noiseBuffer) return;
    const src = ac.createBufferSource();
    src.buffer = this._noiseBuffer;
    const filt = ac.createBiquadFilter();
    filt.type = filterType;
    filt.frequency.setValueAtTime(Math.max(20, f0), t);
    filt.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t + dur);
    filt.Q.value = filterType === 'bandpass' ? 1.2 : 0.7;
    const g = ac.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(Math.max(0.0002, peak), t + Math.min(0.006, dur * 0.2));
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    src.connect(filt);
    filt.connect(g);
    g.connect(dest);
    src.onended = () => {
      try { src.disconnect(); filt.disconnect(); g.disconnect(); } catch (e) { /* ignore */ }
    };
    // Random offset so repeated bursts don't sound identical.
    const offset = Math.random() * Math.max(0, this._noiseBuffer.duration - dur - 0.05);
    src.start(t, offset);
    src.stop(t + dur + 0.05);
  }
}
