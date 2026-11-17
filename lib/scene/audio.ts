// A few seconds of noise that can be played round and round: white, or pink (as much low as high, far softer on the ear).
function noiseLoop(ctx: AudioContext, seconds: number, pink: boolean) {
  const rate = ctx.sampleRate;
  const n = Math.floor(rate * seconds), lap = Math.floor(rate * 0.25);
  const raw = new Float32Array(n + lap);
  const b = [0, 0, 0, 0, 0, 0, 0];
  for (let i = 0; i < raw.length; i++) {
    const w = Math.random() * 2 - 1;
    if (!pink) {
      raw[i] = w;
      continue;
    }
    b[0] = 0.99886 * b[0] + w * 0.0555179;
    b[1] = 0.99332 * b[1] + w * 0.0750759;
    b[2] = 0.969 * b[2] + w * 0.153852;
    b[3] = 0.8665 * b[3] + w * 0.3104856;
    b[4] = 0.55 * b[4] + w * 0.5329522;
    b[5] = -0.7616 * b[5] - w * 0.016898;
    raw[i] = (b[0] + b[1] + b[2] + b[3] + b[4] + b[5] + b[6] + w * 0.5362) * 0.11;
    b[6] = w * 0.115926;
  }
  const buffer = ctx.createBuffer(1, n, rate);
  const data = buffer.getChannelData(0);
  // the end is folded into the start, so the join cannot be heard
  for (let i = 0; i < n; i++) data[i] = i < lap ? raw[i] * (i / lap) + raw[n + i] * (1 - i / lap) : raw[i];
  return buffer;
}

// What a clap would leave behind in a room of wet rock: a few seconds of noise dying away, the high sound first.
function roomEcho(ctx: AudioContext, seconds: number) {
  const rate = ctx.sampleRate, n = Math.floor(rate * seconds);
  const buffer = ctx.createBuffer(2, n, rate);
  for (let ch = 0; ch < 2; ch++) {
    const data = buffer.getChannelData(ch);
    let low = 0;
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      // the rock gives the sound back duller the longer it has been going round
      low += (Math.random() * 2 - 1 - low) * (0.08 + 0.6 * Math.exp(-t * 2.2));
      data[i] = low * Math.exp(-t * 2.1) * (t < 0.012 ? t / 0.012 : 1);
    }
  }
  return buffer;
}

// Everything heard is made here from noise and sine tones: the stillness of the cave, the drips, the hum of the crystals.
export class Ambience {
  private ctx?: AudioContext;
  private master?: GainNode;
  private echo?: ConvolverNode;
  // the air moving in the passage, the low stillness of the chamber, the crystals' hum
  private draught?: { filter: BiquadFilterNode; gain: GainNode };
  private room?: GainNode;
  private hum?: GainNode;
  private muted = false;

  start() {
    if (this.ctx) return;
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    const ctx = (this.ctx = new Ctx());
    const master = (this.master = ctx.createGain());
    master.gain.value = 0;
    master.gain.linearRampToValueAtTime(0.9, ctx.currentTime + 2.5);
    master.connect(ctx.destination);
    const echo = (this.echo = ctx.createConvolver());
    echo.buffer = roomEcho(ctx, 3.6);
    const wet = ctx.createGain();
    wet.gain.value = 0.7;
    echo.connect(wet).connect(master);

    const voice = (buffer: AudioBuffer, type: BiquadFilterType, freq: number, q: number) => {
      const src = ctx.createBufferSource();
      src.buffer = buffer;
      src.loop = true;
      const filter = ctx.createBiquadFilter();
      filter.type = type;
      filter.frequency.value = freq;
      filter.Q.value = q;
      const gain = ctx.createGain();
      gain.gain.value = 0;
      src.connect(filter).connect(gain).connect(master);
      src.start(0, Math.random() * 2);
      return { filter, gain };
    };
    this.draught = voice(noiseLoop(ctx, 5.3, true), "bandpass", 420, 0.5);
    this.room = voice(noiseLoop(ctx, 4.1, true), "lowpass", 110, 0.3).gain;

    // a chord with no third in it, each note doubled a little out of tune so that it slowly beats
    const hum = (this.hum = ctx.createGain());
    hum.gain.value = 0;
    hum.connect(master);
    hum.connect(echo);
    for (const [freq, level] of [[73.4, 0.5], [73.9, 0.4], [110.1, 0.3], [146.5, 0.2], [220.6, 0.1], [293.2, 0.06]]) {
      const osc = ctx.createOscillator();
      osc.frequency.value = freq;
      const g = ctx.createGain();
      g.gain.value = level;
      osc.connect(g).connect(hum);
      osc.start();
    }
  }

  toggle() {
    this.muted = !this.muted;
    if (this.ctx && this.master) this.master.gain.setTargetAtTime(this.muted ? 0 : 0.9, this.ctx.currentTime, 0.15);
    return this.muted;
  }

  // a drop has fallen into a pool: side is how far to the visitor's right it fell (m), away how far off (m)
  drip(side: number, away: number) {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.echo) return;
    const t = ctx.currentTime;
    const level = 0.5 / (1 + away * 0.35);
    const pan = ctx.createStereoPanner();
    pan.pan.value = Math.max(-0.8, Math.min(0.8, side / 5));
    const dry = ctx.createGain();
    dry.gain.value = 0.55;
    pan.connect(dry).connect(this.master);
    pan.connect(this.echo);
    // the plink of the hollow the drop makes, rising as it closes; then a lower plop
    const note = (from: number, to: number, seconds: number, gain: number, delay: number) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.frequency.setValueAtTime(from, t + delay);
      osc.frequency.exponentialRampToValueAtTime(to, t + delay + seconds);
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setValueAtTime(gain * level, t + delay);
      g.gain.exponentialRampToValueAtTime(0.0001, t + delay + seconds);
      osc.connect(g).connect(pan);
      osc.start(t);
      osc.stop(t + delay + seconds + 0.05);
    };
    const f = 950 + Math.random() * 900;
    note(f, f * 1.9, 0.07, 0.22, 0);
    note(f * 0.42, f * 0.3, 0.12, 0.3, 0.018);
  }

  // the crystals ring as a shell of light leaves them
  chime() {
    const ctx = this.ctx;
    if (!ctx || !this.master || !this.echo) return;
    const t = ctx.currentTime;
    for (const [freq, level] of [[293.7, 0.1], [440.5, 0.07], [587.3, 0.05], [881, 0.022], [1174.7, 0.012]]) {
      const osc = ctx.createOscillator();
      osc.frequency.setValueAtTime(freq, t);
      osc.frequency.exponentialRampToValueAtTime(freq * 0.985, t + 3);
      const g = ctx.createGain();
      g.gain.setValueAtTime(0, t);
      g.gain.linearRampToValueAtTime(level, t + 0.015);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 3.2);
      osc.connect(g);
      g.connect(this.master);
      g.connect(this.echo);
      osc.start(t);
      osc.stop(t + 3.3);
    }
  }

  // p: progress along the way in (0–1); distance: how far the crystals are (m)
  update(dt: number, p: number, distance: number) {
    const ctx = this.ctx;
    if (!ctx || !this.draught || !this.room || !this.hum) return;
    const t = ctx.currentTime;
    const inside = Math.min(1, Math.max(0, (p - 0.1) / 0.4));
    // the passage breathes a little; the chamber is nearly still
    const swell = 1 + 0.25 * Math.sin(t * 0.31) + 0.15 * Math.sin(t * 0.13 + 1);
    this.draught.gain.gain.setTargetAtTime(0.22 * (1 - 0.75 * inside) * swell, t, 0.4);
    this.draught.filter.frequency.setTargetAtTime(380 + 90 * Math.sin(t * 0.21), t, 0.4);
    this.room.gain.setTargetAtTime(0.5 + 0.35 * inside, t, 0.4);
    this.hum.gain.setTargetAtTime(0.3 / (1 + distance * distance * 0.09), t, 0.3);
  }

  dispose() {
    this.ctx?.close().catch(() => undefined);
  }
}
