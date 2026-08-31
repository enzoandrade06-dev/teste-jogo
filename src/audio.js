// Áudio 100% procedural (WebAudio) — sem arquivos externos.
export class Audio {
  constructor() {
    this.ctx = null;
    this.enabled = true;
  }

  /** Precisa ser chamado a partir de um gesto do usuário. */
  start() {
    if (this.ctx) { this.ctx.resume?.(); return; }
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) { this.enabled = false; return; }
    this.ctx = new AC();

    this.master = this.ctx.createGain();
    this.master.gain.value = 0.5;
    this.master.connect(this.ctx.destination);

    // motor: duas ondas dente-de-serra + ruído, moduladas pela rotação
    this.engineGain = this.ctx.createGain();
    this.engineGain.gain.value = 0;
    const filter = this.ctx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.value = 1200;
    this.engineFilter = filter;

    this.osc1 = this.ctx.createOscillator();
    this.osc1.type = 'sawtooth';
    this.osc2 = this.ctx.createOscillator();
    this.osc2.type = 'square';
    const g2 = this.ctx.createGain();
    g2.gain.value = 0.35;

    this.osc1.connect(filter);
    this.osc2.connect(g2).connect(filter);
    filter.connect(this.engineGain).connect(this.master);
    this.osc1.start();
    this.osc2.start();
  }

  setEngine(rpm01, load) {
    if (!this.ctx) return;
    const f = 58 + rpm01 * 240;
    const now = this.ctx.currentTime;
    this.osc1.frequency.setTargetAtTime(f, now, 0.05);
    this.osc2.frequency.setTargetAtTime(f * 0.5, now, 0.05);
    this.engineFilter.frequency.setTargetAtTime(500 + rpm01 * 2600, now, 0.08);
    this.engineGain.gain.setTargetAtTime(0.035 + load * 0.06, now, 0.1);
  }

  stopEngine() {
    if (!this.ctx) return;
    this.engineGain.gain.setTargetAtTime(0, this.ctx.currentTime, 0.15);
  }

  _blip({ freq = 440, to = null, dur = 0.15, type = 'sine', vol = 0.25, delay = 0 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const o = this.ctx.createOscillator();
    const g = this.ctx.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t0);
    if (to) o.frequency.exponentialRampToValueAtTime(to, t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    o.connect(g).connect(this.master);
    o.start(t0);
    o.stop(t0 + dur + 0.02);
  }

  _noise({ dur = 0.3, vol = 0.3, freq = 900, delay = 0 }) {
    if (!this.ctx) return;
    const t0 = this.ctx.currentTime + delay;
    const n = Math.floor(this.ctx.sampleRate * dur);
    const buf = this.ctx.createBuffer(1, n, this.ctx.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < n; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / n);
    const src = this.ctx.createBufferSource();
    src.buffer = buf;
    const f = this.ctx.createBiquadFilter();
    f.type = 'bandpass';
    f.frequency.value = freq;
    const g = this.ctx.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master);
    src.start(t0);
  }

  countBeep(final = false) {
    this._blip({ freq: final ? 880 : 440, dur: final ? 0.5 : 0.18, type: 'square', vol: 0.3 });
  }
  boost() { this._blip({ freq: 260, to: 1400, dur: 0.35, type: 'sawtooth', vol: 0.22 }); }
  miniTurbo(tier) { this._blip({ freq: 400 + tier * 180, to: 1500, dur: 0.28, type: 'square', vol: 0.2 }); }
  itemGet() { this._blip({ freq: 660, to: 990, dur: 0.16, type: 'triangle', vol: 0.2 }); }
  hit() { this._noise({ dur: 0.45, vol: 0.4, freq: 350 }); this._blip({ freq: 300, to: 70, dur: 0.4, type: 'sawtooth', vol: 0.22 }); }
  bump() { this._noise({ dur: 0.12, vol: 0.2, freq: 200 }); }
  wall() { this._noise({ dur: 0.2, vol: 0.28, freq: 500 }); }
  lap() { this._blip({ freq: 660, dur: 0.12, type: 'square', vol: 0.22 }); this._blip({ freq: 990, dur: 0.2, type: 'square', vol: 0.22, delay: 0.12 }); }
  finish() {
    [523, 659, 784, 1047].forEach((f, i) =>
      this._blip({ freq: f, dur: 0.3, type: 'square', vol: 0.25, delay: i * 0.13 }));
  }
  skid(amount) {
    if (!this.ctx || amount < 0.2) return;
    if (this._lastSkid && this.ctx.currentTime - this._lastSkid < 0.09) return;
    this._lastSkid = this.ctx.currentTime;
    this._noise({ dur: 0.12, vol: 0.06 * amount, freq: 2400 });
  }
}
