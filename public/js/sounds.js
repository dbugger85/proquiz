// Game-show sounds, made with the Web Audio API (no sound files needed).
// Browsers only allow sound after a click or key press on the page: call unlockAudio() from one.
//
// The sounds are built like real sound effects, not single beeps: layers of slightly detuned oscillators,
// noise for attacks and textures, FM bells for chimes, filters that move, a little saturation, and a
// shared room echo so everything sits in one space.

let ctx = null;
let master = null; // dry effects → limiter
let send = null; // → room echo → limiter
let limiter = null;
let volume = 0.8;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    // iPhone and iPad mute this kind of sound in silent mode: ask to play like a media app instead.
    if (navigator.audioSession) navigator.audioSession.type = 'playback';
    ctx = new AC();
    // A gentle limiter so big layered sounds never clip on loud TV speakers.
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    limiter.connect(ctx.destination);
    master = ctx.createGain();
    master.gain.value = volume;
    master.connect(limiter);
    // One shared room echo for all effects.
    send = ctx.createGain();
    const verb = ctx.createConvolver();
    verb.buffer = room(1.6, 3);
    const back = ctx.createGain();
    back.gain.value = volume * 0.6;
    send.connect(verb).connect(back).connect(limiter);
  }
  return ctx;
}

export function unlockAudio() {
  const a = audio();
  if (a && a.state !== 'running') a.resume().catch(() => {});
  return audioReady();
}

export const audioReady = () => ctx?.state === 'running';

// The shared audio setup, for the background music (which has its own volume but the same limiter).
export function audioGraph() {
  return audioReady() ? { ctx, limiter } : null;
}

export function setVolume(v) {
  volume = v;
  if (master) master.gain.value = v;
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);
const live = () => {
  const a = audio();
  return a && a.state === 'running' ? a : null;
};

// ----- building blocks -----

let brownBuf = null;
let whiteBuf = null;
let roomBuf = null;

// Deep, rumbling noise (brown) and plain hiss (white), 4 seconds each, made once.
function noiseBuffer(kind) {
  const a = audio();
  if (kind === 'brown' && brownBuf) return brownBuf;
  if (kind === 'white' && whiteBuf) return whiteBuf;
  const buf = a.createBuffer(1, a.sampleRate * 4, a.sampleRate);
  const d = buf.getChannelData(0);
  let last = 0;
  for (let i = 0; i < d.length; i++) {
    const w = Math.random() * 2 - 1;
    if (kind === 'brown') {
      last = (last + 0.02 * w) / 1.02;
      d[i] = last * 3.5;
    } else d[i] = w;
  }
  return kind === 'brown' ? (brownBuf = buf) : (whiteBuf = buf);
}

// A made-up room echo: stereo noise that fades out. (The explosion uses a longer, darker one.)
function room(seconds = 2.2, fade = 3.2) {
  const a = audio();
  if (seconds === 2.2 && roomBuf) return roomBuf;
  const len = Math.floor(a.sampleRate * seconds);
  const buf = a.createBuffer(2, len, a.sampleRate);
  for (let ch = 0; ch < 2; ch++) {
    const d = buf.getChannelData(ch);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len) ** fade;
  }
  if (seconds === 2.2) roomBuf = buf;
  return buf;
}

// Soft clipping, for warmth and grit (a new node each time; the curve is made once).
let gritCurve = null;
function distortion(amount = 3) {
  if (!gritCurve) {
    gritCurve = new Float32Array(1024);
    for (let i = 0; i < gritCurve.length; i++) gritCurve[i] = Math.tanh(((i / (gritCurve.length - 1)) * 2 - 1) * 3);
  }
  const node = audio().createWaveShaper();
  node.curve = gritCurve;
  node.oversample = '4x';
  const pre = audio().createGain();
  pre.gain.value = amount / 3;
  pre.connect(node);
  return { input: pre, output: node };
}

// Sends a finished sound to the speakers, a little to the left or right (pan −1…1), with some room echo.
function out(node, { pan = 0, wet = 0.2 } = {}) {
  const a = audio();
  let n = node;
  if (pan) {
    const p = a.createStereoPanner();
    p.pan.value = pan;
    n = n.connect(p);
  }
  n.connect(master);
  if (wet) {
    const w = a.createGain();
    w.gain.value = wet;
    n.connect(w).connect(send);
  }
}

// A burst of noise through a filter, with its own loudness curve: [[time, level], …] after `at`.
function noiseHit(kind, { at = 0, filter = 'lowpass', freq = [2000], q = 0.7, levels, out: dest = null, pan = 0, wet = 0.2 }) {
  const a = live();
  if (!a) return;
  const t = a.currentTime + at;
  const src = a.createBufferSource();
  src.buffer = noiseBuffer(kind);
  const f = a.createBiquadFilter();
  f.type = filter;
  f.Q.value = q;
  f.frequency.setValueAtTime(freq[0], t);
  freq.slice(1).forEach(([when, v]) => f.frequency.exponentialRampToValueAtTime(v, t + when));
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  for (const [when, level] of levels) g.gain.exponentialRampToValueAtTime(Math.max(level, 0.0001), t + when);
  src.connect(f).connect(g);
  if (dest) g.connect(dest);
  else out(g, { pan, wet });
  const end = levels[levels.length - 1][0];
  src.start(t, Math.random() * 0.5, end + 0.1);
}

// A thick tone: several slightly detuned oscillators through a filter that moves, with an envelope.
//   voices: [[type, cents, level], …]   filter: [start Hz, peak Hz, end Hz]
function stack(freq, { at = 0, dur = 0.4, voices = [['sawtooth', -9, 1], ['sawtooth', 0, 1], ['sawtooth', 9, 1]], gain = 0.2, filter = [800, 3000, 1200], q = 1, attack = 0.008, drive = 0, slide = null, vibrato = 0, pan = 0, wet = 0.2 } = {}) {
  const a = live();
  if (!a) return;
  const t = a.currentTime + at;
  const f = a.createBiquadFilter();
  f.type = 'lowpass';
  f.Q.value = q;
  f.frequency.setValueAtTime(filter[0], t);
  f.frequency.exponentialRampToValueAtTime(filter[1], t + Math.min(0.06, dur / 3));
  f.frequency.exponentialRampToValueAtTime(filter[2], t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.setValueAtTime(gain, t + Math.max(attack, dur * 0.6));
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let lfo = null;
  if (vibrato) {
    lfo = a.createOscillator();
    lfo.frequency.value = 5.5;
    const depth = a.createGain();
    depth.gain.value = vibrato;
    lfo.connect(depth);
    lfo.start(t);
    lfo.stop(t + dur + 0.1);
    lfo.depth = depth;
  }
  for (const [type, cents, level] of voices) {
    const o = a.createOscillator();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
    o.detune.value = cents;
    if (lfo) lfo.depth.connect(o.detune);
    const v = a.createGain();
    v.gain.value = level / voices.length;
    o.connect(v).connect(f);
    o.start(t);
    o.stop(t + dur + 0.05);
  }
  if (drive) {
    const d = distortion(drive);
    f.connect(d.input);
    d.output.connect(g);
  } else f.connect(g);
  out(g, { pan, wet });
}

// An FM bell or chime: a sine whose tone is shaped by a second sine (sounds metallic, not beepy).
// ratio 3.5 = bell, 1.4 = soft chime, 7 = glassy.
function bell(freq, { at = 0, dur = 1.2, gain = 0.2, ratio = 3.5, index = 2.5, pan = 0, wet = 0.3 } = {}) {
  const a = live();
  if (!a) return;
  const t = a.currentTime + at;
  const car = a.createOscillator();
  const mod = a.createOscillator();
  const modGain = a.createGain();
  car.frequency.value = freq;
  mod.frequency.value = freq * ratio;
  modGain.gain.setValueAtTime(freq * index, t);
  modGain.gain.exponentialRampToValueAtTime(freq * 0.05, t + dur * 0.6);
  mod.connect(modGain).connect(car.frequency);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.003);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  car.connect(g);
  // A quiet octave above for sparkle.
  const top = a.createOscillator();
  top.frequency.value = freq * 2.01;
  const tg = a.createGain();
  tg.gain.setValueAtTime(gain * 0.25, t);
  tg.gain.exponentialRampToValueAtTime(0.0001, t + dur * 0.5);
  top.connect(tg).connect(g);
  out(g, { pan, wet });
  for (const o of [car, mod, top]) {
    o.start(t);
    o.stop(t + dur + 0.05);
  }
}

// A deep hit that falls in pitch (a kick drum, a timpani, a tile landing).
function thump(from, to, { at = 0, dur = 0.3, gain = 0.6, wet = 0.1 } = {}) {
  const a = live();
  if (!a) return;
  const t = a.currentTime + at;
  const o = a.createOscillator();
  o.frequency.setValueAtTime(from, t);
  o.frequency.exponentialRampToValueAtTime(to, t + dur * 0.8);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.004);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g);
  out(g, { wet });
  o.start(t);
  o.stop(t + dur + 0.05);
}

// A crash cymbal: bright noise with a long, shimmering fade.
function cymbal({ at = 0, dur = 1.8, gain = 0.18, wet = 0.4 } = {}) {
  noiseHit('white', { at, filter: 'highpass', freq: [5500], levels: [[0.004, gain], [0.15, gain * 0.5], [dur, 0.0001]], wet });
  noiseHit('white', { at, filter: 'bandpass', freq: [9000], q: 0.6, levels: [[0.004, gain * 0.6], [dur * 0.7, 0.0001]], wet, pan: 0.3 });
}

// A snare drum hit.
function snare({ at = 0, gain = 0.3, wet = 0.2 } = {}) {
  noiseHit('white', { at, filter: 'bandpass', freq: [2200], q: 0.8, levels: [[0.002, gain], [0.12, 0.0001]], wet });
  thump(240, 160, { at, dur: 0.08, gain: gain * 0.8, wet });
}

// A wooden tick (the reel, the last seconds of a timer).
function woodblock({ at = 0, pitch = 1800, gain = 0.25 } = {}) {
  noiseHit('white', { at, filter: 'bandpass', freq: [pitch], q: 9, levels: [[0.001, gain], [0.035, 0.0001]], wet: 0.12 });
  thump(pitch * 0.55, pitch * 0.45, { at, dur: 0.04, gain: gain * 0.5, wet: 0.05 });
}

// A filtered noise sweep: the "whoosh" of something moving.
function whoosh({ at = 0, dur = 0.45, gain = 0.3, from = 300, to = 4000, wet = 0.3 } = {}) {
  const a = live();
  if (!a) return;
  noiseHit('white', { at, filter: 'bandpass', freq: [from, [dur, to]], q: 1.4, levels: [[dur * 0.6, gain], [dur, 0.0001]], wet, pan: -0.2 });
}

// Each team's buzz is a different note of a major pentatonic scale, so any two teams sound good together
// and everyone learns their own tone. Index = the team's colour number (0–7).
const TEAM_NOTES = [72, 76, 79, 81, 84, 86, 88, 91]; // C5 E5 G5 A5 C6 D6 E6 G6

const MAJOR = (root) => [root, root + 4, root + 7];

export const sounds = {
  // A soft pluck with a bell on top.
  join() {
    bell(hz(79), { dur: 0.5, gain: 0.26, ratio: 1.4, index: 1.5 });
    bell(hz(86), { at: 0.07, dur: 0.6, gain: 0.22, ratio: 1.4, index: 1.5, pan: 0.3 });
  },
  // A whoosh as the question flies in, and the tile landing.
  pick() {
    whoosh({ dur: 0.4, gain: 0.35 });
    thump(170, 80, { at: 0.34, dur: 0.18, gain: 0.45 });
    noiseHit('white', { at: 0.34, filter: 'bandpass', freq: [1500], q: 1.5, levels: [[0.002, 0.15], [0.05, 0.0001]] });
    bell(hz(79), { at: 0.36, dur: 0.8, gain: 0.08, ratio: 1.4 });
  },
  // "Go!": a bright double chime with a soft thump under it.
  armed() {
    thump(90, 50, { dur: 0.3, gain: 0.35 });
    bell(hz(88), { dur: 1, gain: 0.2, pan: -0.15 });
    bell(hz(95), { at: 0.09, dur: 1.1, gain: 0.18, pan: 0.15 });
  },
  // The buzzer: a fat, gritty chord on the team's own note, with a sharp click at the start.
  buzz(teamIndex = 0) {
    const n = TEAM_NOTES[teamIndex % TEAM_NOTES.length] - 12;
    noiseHit('white', { filter: 'bandpass', freq: [3500], q: 1, levels: [[0.001, 0.35], [0.03, 0.0001]], wet: 0.05 });
    thump(140, 60, { dur: 0.15, gain: 0.4 });
    const voices = [['sawtooth', -14, 1], ['sawtooth', 0, 1], ['sawtooth', 13, 1], ['square', -1200, 0.9], ['sawtooth', 700, 0.5]];
    stack(hz(n), { dur: 0.62, gain: 0.34, voices, filter: [1800, 4200, 1600], q: 1.5, drive: 4, wet: 0.15 });
  },
  // "Too early": a dull, woody bonk.
  early() {
    thump(200, 90, { dur: 0.16, gain: 0.5 });
    stack(hz(50), { dur: 0.18, gain: 0.12, voices: [['square', 0, 1], ['square', 12, 1]], filter: [500, 900, 300], wet: 0.05 });
  },
  // Right answer: a sparkling rising chime over a bright chord.
  correct() {
    [72, 76, 79, 84].forEach((m, i) => bell(hz(m + 12), { at: i * 0.07, dur: 1.2, gain: 0.3, pan: -0.3 + i * 0.2 }));
    for (const m of MAJOR(72)) stack(hz(m), { at: 0.2, dur: 0.9, gain: 0.13, filter: [1200, 3500, 1500], wet: 0.35 });
    bell(hz(96), { at: 0.3, dur: 1.4, gain: 0.18, ratio: 7, index: 1 });
    thump(120, 70, { at: 0.2, dur: 0.25, gain: 0.35 });
    noiseHit('white', { at: 0.25, filter: 'highpass', freq: [8000], levels: [[0.05, 0.1], [0.8, 0.0001]], wet: 0.5 });
  },
  // Wrong answer: the classic two-part "eh-ehh" buzzer, low and gritty.
  wrong() {
    const voices = [['sawtooth', -10, 1], ['sawtooth', 8, 1], ['square', 0, 0.8], ['square', -1200, 0.6]];
    stack(116, { dur: 0.26, gain: 0.3, voices, filter: [900, 1600, 700], drive: 5, wet: 0.1 });
    stack(104, { at: 0.32, dur: 0.5, gain: 0.3, voices, filter: [900, 1500, 500], drive: 5, wet: 0.12 });
  },
  // Time's up: three falling brass stabs, "doo, doo, dooo".
  timeup() {
    [[67, 0, 0.22], [64, 0.25, 0.22], [60, 0.5, 0.6]].forEach(([m, at, dur]) => {
      for (const x of [m, m - 12]) stack(hz(x), { at, dur, gain: 0.22, filter: [400, 2600, 700], drive: 1.5, wet: 0.25 });
    });
  },
  // A wooden tick for the last seconds of a timer.
  tick() {
    woodblock({ pitch: 1900, gain: 0.5 });
  },
  // The answer is shown: a soft two-note chime.
  reveal() {
    bell(hz(79), { dur: 1.2, gain: 0.24, ratio: 1.4 });
    bell(hz(84), { at: 0.1, dur: 1.4, gain: 0.24, ratio: 1.4, pan: 0.2 });
  },
  // Undo: a short swoosh backwards.
  undo() {
    whoosh({ dur: 0.25, gain: 0.7, from: 3500, to: 400, wet: 0.15 });
    thump(220, 110, { at: 0.18, dur: 0.1, gain: 0.25 });
  },
  // The final round: a timpani hit and a dark swell that opens up, with a rising cymbal.
  final() {
    thump(100, 55, { dur: 1.1, gain: 0.6, wet: 0.3 });
    noiseHit('brown', { filter: 'lowpass', freq: [400], levels: [[0.01, 0.6], [1, 0.0001]], wet: 0.3 });
    for (const [m, pan] of [[45, 0], [57, -0.3], [60, 0.3], [64, 0]]) {
      stack(hz(m), { dur: 2.2, gain: 0.09, attack: 0.5, filter: [200, 300, 2000], vibrato: 6, pan, wet: 0.45 });
    }
    noiseHit('white', { filter: 'highpass', freq: [6000], levels: [[1.4, 0.1], [2.2, 0.0001]], wet: 0.5 });
  },
  // Round 2: a rising whoosh into a bright, climbing brass fanfare, one step up from the first board.
  round2() {
    whoosh({ dur: 0.6, gain: 0.5, from: 300, to: 4000, wet: 0.2 });
    thump(110, 55, { at: 0.55, dur: 0.5, gain: 0.55, wet: 0.2 });
    [[67, 0.55], [71, 0.7], [74, 0.85], [79, 1.0]].forEach(([m, at], i) => {
      const dur = i === 3 ? 1.2 : 0.18;
      for (const x of [m, m - 12]) stack(hz(x), { at, dur, gain: 0.16, filter: [600, 3200, 1200], drive: 1.5, wet: 0.3 });
    });
    bell(hz(91), { at: 1.0, dur: 1.6, gain: 0.16, ratio: 3.5, index: 1.2 });
    noiseHit('white', { at: 1.0, filter: 'highpass', freq: [7000], levels: [[0.05, 0.12], [1.2, 0.0001]], wet: 0.5 });
  },
  // Kaosmodus reveal: the reel ticks, slowing down over ~1.9 s (as long as the TV's reel animation),
  // then the special's own sting as it lands.
  mystery(kind) {
    sounds.sting(kind, sounds.reel());
  },
  // Each special's own sound (on its own, `at` = 0).
  sting(kind, at = 0) {
    const stings = {
      // Three rising bells and a brass hit.
      triple: () => {
        [76, 83, 88].forEach((m, i) => bell(hz(m), { at: at + i * 0.1, dur: 1, gain: 0.26, pan: -0.3 + i * 0.3 }));
        for (const m of MAJOR(64)) stack(hz(m), { at: at + 0.3, dur: 0.7, gain: 0.08, filter: [500, 3500, 1200], drive: 1.5, wet: 0.3 });
        cymbal({ at: at + 0.3, dur: 1.2, gain: 0.1 });
      },
      // A lit fuse: hissing and crackling, over an ominous low hit.
      bomb: () => {
        noiseHit('white', { at, filter: 'bandpass', freq: [4500, [1.4, 6500]], q: 1.2, levels: [[0.03, 0.22], [1.2, 0.18], [1.5, 0.0001]], wet: 0.1 });
        for (let n = 0; n < 18; n++) {
          noiseHit('white', { at: at + Math.random() * 1.4, filter: 'highpass', freq: [3000], levels: [[0.002, 0.3 * Math.random() + 0.1], [0.02, 0.0001]], wet: 0.05, pan: Math.random() - 0.5 });
        }
        thump(60, 45, { at, dur: 1.4, gain: 0.5, wet: 0.2 });
        stack(110, { at, dur: 1.2, gain: 0.08, voices: [['sawtooth', -8, 1], ['sawtooth', 8, 1]], filter: [300, 600, 200], wet: 0.2 });
      },
      // A roaring riser: a thick chord sliding up as its filter opens, with a whoosh.
      hotseat: () => {
        for (const [m, pan] of [[48, 0], [55, -0.3], [60, 0.3]]) stack(hz(m), { at, dur: 0.9, gain: 0.12, attack: 0.2, slide: hz(m + 12), filter: [300, 500, 4000], drive: 2, pan, wet: 0.3 });
        whoosh({ at, dur: 0.9, gain: 0.25, from: 400, to: 6000 });
        thump(120, 50, { at: at + 0.85, dur: 0.3, gain: 0.5 });
      },
      // Friendly and warm: a bright major chord of chimes over a soft pad.
      rescue: () => {
        [67, 72, 76, 79].forEach((m, i) => bell(hz(m), { at: at + i * 0.09, dur: 1.4, gain: 0.24, ratio: 1.4, pan: -0.3 + i * 0.2 }));
        for (const m of MAJOR(60)) stack(hz(m), { at, dur: 1.4, gain: 0.1, attack: 0.15, filter: [600, 1500, 900], wet: 0.4 });
      },
      // Power-up: a fast, gritty climbing run and a laser zap.
      turbo: () => {
        [0, 2, 4, 7, 9, 12, 14, 16].forEach((n, i) => stack(hz(67 + n), { at: at + i * 0.045, dur: 0.12, gain: 0.12, voices: [['square', 0, 1], ['sawtooth', 7, 1]], filter: [2000, 5000, 2500], drive: 2, wet: 0.15 }));
        stack(hz(96), { at: at + 0.38, dur: 0.35, gain: 0.12, voices: [['sawtooth', 0, 1], ['square', 5, 1]], slide: hz(60), filter: [6000, 8000, 800], wet: 0.2 });
        thump(150, 60, { at: at + 0.38, dur: 0.25, gain: 0.45 });
      },
      // Coins pouring in, with a shimmer.
      jackpot: () => {
        for (let n = 0; n < 9; n++) {
          const t0 = at + n * 0.075;
          bell(1975, { at: t0, dur: 0.35, gain: 0.2, ratio: 3.02, index: 1.2, pan: Math.random() - 0.5, wet: 0.25 });
          bell(2637, { at: t0 + 0.035, dur: 0.4, gain: 0.16, ratio: 3.02, index: 1.2, pan: Math.random() - 0.5, wet: 0.25 });
        }
        cymbal({ at: at + 0.1, dur: 1.6, gain: 0.08 });
        for (const m of MAJOR(72)) stack(hz(m), { at: at + 0.6, dur: 0.8, gain: 0.12, filter: [800, 3500, 1500], wet: 0.35 });
      },
      // Icy: glassy bells falling over a cold, shimmering hiss.
      freeze: () => {
        [100, 96, 93, 88, 84].forEach((m, i) => bell(hz(m), { at: at + i * 0.08, dur: 1.4, gain: 0.18, ratio: 7.1, index: 1.5, pan: 0.4 - i * 0.2, wet: 0.5 }));
        noiseHit('white', { at, filter: 'highpass', freq: [7000], levels: [[0.2, 0.08], [1.4, 0.0001]], wet: 0.6 });
        stack(hz(52), { at, dur: 1.4, gain: 0.06, attack: 0.2, voices: [['sine', 0, 1], ['triangle', 5, 1]], filter: [800, 1200, 600], wet: 0.5 });
      },
      // Dice rattling, then two big brass hits: double!
      double: () => {
        for (let n = 0; n < 10; n++) woodblock({ at: at + n * 0.045 + Math.random() * 0.02, pitch: 1400 + Math.random() * 1400, gain: 0.3 });
        for (const [i, root] of [[0, 55], [1, 62]]) {
          for (const m of MAJOR(root)) stack(hz(m), { at: at + 0.5 + i * 0.22, dur: 0.6, gain: 0.09, filter: [600, 4000, 1400], drive: 1.6, wet: 0.3 });
          thump(110, 50, { at: at + 0.5 + i * 0.22, dur: 0.3, gain: 0.4 });
        }
        cymbal({ at: at + 0.72, dur: 1.2, gain: 0.1 });
      },
    };
    stings[kind]?.();
  },
  // The reel's wooden ticks; returns how long they last (in seconds).
  reel() {
    let at = 0;
    for (let n = 0; n < 16; n++) {
      woodblock({ at, pitch: n % 2 ? 2200 : 1700, gain: 0.45 });
      at += 0.035 + n * n * 0.0011;
    }
    return at;
  },
  // A real-sounding explosion: a crack, a deep thump, a roaring burst that darkens, debris, a rumbling tail.
  boom() {
    const a = live();
    if (!a) return;
    const t = a.currentTime;
    // Everything goes through a little grit and a room echo.
    const dry = a.createGain();
    dry.gain.value = 0.9;
    const wet = a.createGain();
    wet.gain.value = 0.35;
    const verb = a.createConvolver();
    verb.buffer = room();
    const bus = a.createGain();
    bus.gain.value = 0.9;
    const d = distortion();
    bus.connect(d.input);
    d.output.connect(dry).connect(master);
    bus.connect(verb).connect(wet).connect(master);

    // 1. The crack: a very short, bright burst.
    noiseHit('white', { filter: 'highpass', freq: [1500], levels: [[0.002, 1], [0.05, 0.05], [0.12, 0.0001]], out: bus });
    // 2. The thump: a deep sine that falls, felt more than heard.
    const o = a.createOscillator();
    const og = a.createGain();
    o.frequency.setValueAtTime(95, t);
    o.frequency.exponentialRampToValueAtTime(32, t + 0.6);
    og.gain.setValueAtTime(0.0001, t);
    og.gain.exponentialRampToValueAtTime(1.2, t + 0.01);
    og.gain.exponentialRampToValueAtTime(0.0001, t + 1.1);
    o.connect(og).connect(bus);
    o.start(t);
    o.stop(t + 1.2);
    // 3. The blast: loud noise whose filter closes from bright to dark as it fades.
    noiseHit('white', { filter: 'lowpass', freq: [5000, [0.25, 1400], [1.4, 180]], levels: [[0.008, 0.9], [0.3, 0.35], [1.6, 0.0001]], out: bus });
    // 4. The rumble: deep noise that rolls on for a few seconds.
    noiseHit('brown', { filter: 'lowpass', freq: [900, [2.8, 90]], levels: [[0.05, 1], [0.8, 0.55], [3.2, 0.0001]], out: bus });
    // 5. Debris: a few crackles scattered over the first second.
    for (let n = 0; n < 12; n++) {
      const when = 0.12 + Math.random() * 1.1;
      noiseHit('white', { at: when, filter: 'bandpass', freq: [1200 + Math.random() * 2500], q: 2, levels: [[0.003, 0.25 * (1 - when / 1.4)], [0.04, 0.0001]], out: bus });
    }
  },
  // The winner: a brass section "da-da-da-daaa" with a snare roll, a timpani and a crash cymbal.
  fanfare() {
    const brass = (notes, at, dur) => {
      notes.forEach((m, i) => stack(hz(m), { at, dur, gain: 0.1, filter: [300, 3200, 1600], q: 1.2, drive: 1.5, vibrato: dur > 0.5 ? 12 : 0, pan: -0.4 + (i / Math.max(1, notes.length - 1)) * 0.8, wet: 0.3 }));
    };
    for (let n = 0; n < 10; n++) snare({ at: n * 0.05, gain: 0.08 + n * 0.012, wet: 0.15 });
    brass([55, 62, 67], 0, 0.16);
    brass([55, 62, 67], 0.18, 0.16);
    brass([55, 62, 67], 0.36, 0.16);
    brass([48, 60, 64, 67, 72], 0.56, 1.6);
    thump(110, 55, { at: 0.56, dur: 0.9, gain: 0.6, wet: 0.3 });
    cymbal({ at: 0.56, dur: 2.2, gain: 0.16 });
    bell(hz(84), { at: 0.56, dur: 1.8, gain: 0.08, ratio: 3.5 });
  },
};

// Plays the sound for something that just happened in the game (state.event).
export function playEvent(view, ev, colors) {
  if (!view.settings.sound) return;
  const teamIndex = () => colors.indexOf(view.teams.find((tm) => tm.id === ev.teamId)?.color);
  switch (ev.type) {
    case 'join':
      if (view.phase === 'lobby') sounds.buzz(Math.max(0, teamIndex())); // each team hears its own tone when it joins
      else sounds.join();
      break;
    case 'start':
    case 'armed':
      sounds.armed();
      break;
    case 'pick':
      sounds.pick();
      break;
    case 'buzz':
      sounds.buzz(Math.max(0, teamIndex()));
      break;
    case 'early':
      sounds.early();
      break;
    case 'correct':
      sounds.correct();
      break;
    case 'wrong':
      sounds.wrong();
      break;
    case 'timeup':
      sounds.timeup();
      break;
    case 'reveal':
      sounds.reveal();
      break;
    case 'undo':
      sounds.undo();
      break;
    case 'finalWager':
      sounds.final();
      break;
    case 'round2':
      sounds.round2();
      break;
    case 'finalQuestion':
      sounds.armed();
      break;
    case 'over':
      sounds.fanfare();
      break;
    case 'special':
      sounds.mystery(ev.kind);
      break;
    case 'boom':
      sounds.boom();
      break;
  }
}

// Ticks during the last three seconds of any timer.
export function startTicks(getView, now) {
  let last = null;
  setInterval(() => {
    const view = getView();
    if (!view?.settings.sound || view.deadline == null) return (last = null);
    const left = Math.ceil((view.deadline - now()) / 1000);
    if (left !== last && left >= 1 && left <= 3) sounds.tick();
    last = left;
  }, 50);
}

// A sound sent by the server outside the game (lobby buzzer test, host's test button).
export function playSound(view, msg, colors) {
  if (!view?.settings.sound) return;
  if (msg.name === 'buzz') sounds.buzz(Math.max(0, colors.indexOf(view.teams.find((tm) => tm.id === msg.teamId)?.color)));
  else sounds[msg.name]?.();
}
