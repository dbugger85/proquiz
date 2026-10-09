// Background music, Kahoot style: a tune for each moment of the game, made with the Web Audio API
// (four original tunes, no files needed), or the host's own music files per moment.
//
// Nothing about the music is stored in the game: moodFor(view) works it out from the phase, so a TV that
// reloads picks up the right tune by itself. The TV plays it (the host laptop only when no TV is open).

import { audioGraph } from './sounds.js';

// ----- which music plays when (a pure function, tested headless) -----

// 'off' | 'silent' | 'lobby' | 'board' | 'thinking' | 'hot' | 'answering' | 'final' | 'finalQ' | 'judge' | 'over'
export function moodFor(view, now = 0) {
  if (!view?.settings?.music) return 'off';
  const p = view.phase;
  if (view.clip && p !== 'lobby' && p !== 'board') return 'silent'; // a question's own sound clip needs quiet
  switch (p) {
    case 'lobby':
      return 'lobby';
    case 'board':
    case 'round2':
      return 'board';
    case 'reading':
      return 'thinking';
    case 'armed':
      return view.deadline != null && view.deadline - now <= 3000 ? 'hot' : 'thinking';
    case 'answering':
      return 'answering';
    case 'finalWager':
      return 'final';
    case 'finalQuestion':
      return 'finalQ';
    case 'finalJudge':
      return 'judge';
    case 'over':
      return 'over';
    default:
      return 'silent'; // special (the Kaosmodus reel), revealed (the stings stand alone)
  }
}

// What each mood plays: a built-in song with some of its layers, at a level, or the host's file for that moment.
const MOODS = {
  lobby: { song: 'day', layers: 'all', level: 1, file: 'lobby' },
  board: { song: 'day', layers: ['pad', 'bass', 'hat'], level: 0.7, file: 'board', fallbackFile: 'lobby', fileLevel: 0.6 },
  thinking: { song: 'tick', layers: 'all', level: 1, file: 'thinking', restart: true },
  hot: { song: 'tick', layers: 'all', level: 1, hot: true, file: 'thinking' },
  answering: { song: 'tick', layers: ['pad', 'bass'], level: 0.4, file: 'thinking', fileLevel: 0.35 },
  final: { song: 'slow', layers: ['pad', 'bass', 'kick', 'bell'], level: 1, file: 'final' },
  finalQ: { song: 'slow', layers: 'all', level: 1, file: 'final' },
  judge: { song: 'slow', layers: ['pad', 'bass'], level: 0.4, file: 'final', fileLevel: 0.35 },
  over: { song: 'party', layers: 'all', level: 1, file: 'over', delay: 3.2 }, // after the fanfare
};

// ----- the built-in songs -----

const C = [48, 52, 55];
const Am = [45, 48, 52];
const F = [41, 45, 48];
const G = [43, 47, 50];
const Em = [40, 43, 47];
const Dm = [38, 41, 45];
const E = [40, 44, 47];
const Fmaj7 = [41, 45, 48, 52];
const E7 = [40, 44, 47, 50];

// Patterns are 16 steps (16th notes) per bar. Bass: r = root, f = fifth, o = octave. Arp: digits are chord tones.
export const SONGS = {
  day: {
    bpm: 112,
    bars: [C, C, Am, Am, F, F, G, G],
    barsB: [F, F, G, G, Em, Em, Am, Am], // every other time round
    kick: 'x.......x.......',
    snare: '....x.......x...',
    hat: 'x.x.x.x.x.x.x.x.',
    bass: 'r..r..f.r..o.f..',
    arp: ['0.1.2.1.0.1.2.3.', '0.2.1.2.3.2.1.2.', '3.2.1.0.1.2.3.2.'],
    pad: true,
    // A little tune on top, every other time round: [step (of 64), note, length in steps].
    melody: [[0, 76, 3], [4, 79, 3], [8, 81, 2], [10, 79, 2], [12, 76, 4], [16, 72, 3], [20, 74, 3], [24, 76, 6], [32, 81, 3], [36, 79, 3], [40, 76, 2], [42, 74, 2], [44, 72, 4], [48, 74, 3], [52, 76, 3], [56, 72, 6]],
  },
  tick: {
    bpm: 128,
    bars: [Am, F, Dm, E],
    kick: 'x...x...x...x...',
    snare: '....x.......x...', // played as a rimshot
    rim: true,
    shaker: 'xxxxxxxxxxxxxxxx',
    openhat: '..x...x...x...x.', // only when time is nearly up
    bass: 'r.r.r.r.r.r.r.r.',
    arp: ['0123012301230123', '0121012101210123'],
    pad: true,
  },
  slow: {
    bpm: 84,
    bars: [Am, Fmaj7, Dm, E7],
    kick: 'x..x....x..x....', // a heartbeat
    shaker: 'x.x.x.x.x.x.x.x.',
    bass: 'r.......r.......',
    pad: true,
    bell: true,
  },
  party: {
    bpm: 120,
    bars: [C, C, G, G, Am, Am, F, F],
    kick: 'x...x...x...x...',
    snare: '....x.......x...',
    hat: '..x...x...x...x.',
    bass: 'r.ro.r.fr.ro.r.f',
    arp: ['0.1.2.3.2.1.0.1.'],
    pad: true,
    melody: [[0, 72, 2], [2, 76, 2], [4, 79, 4], [8, 84, 6], [16, 83, 2], [18, 79, 2], [20, 76, 4], [24, 79, 6], [32, 81, 2], [34, 79, 2], [36, 76, 4], [40, 72, 6], [48, 74, 2], [50, 76, 2], [52, 77, 4], [56, 72, 8]],
  },
};

// How loud each layer is against the others.
const LAYER_LEVEL = { kick: 0.9, snare: 0.45, hat: 0.18, openhat: 0.16, shaker: 0.12, bass: 0.5, arp: 0.14, pad: 0.1, bell: 0.18, melody: 0.16 };
const LAYERS = Object.keys(LAYER_LEVEL);

// ----- the engine -----

let ctx = null;
let out = null; // music volume → the shared limiter
let noise = null; // one second of noise, shared by all drum hits
let current = null; // what is playing: { kind: 'song' | 'file', key, bus, ... }
let lastMood = null;
let volume = null; // the music volume setting (0–100) last applied
const bad = new Set(); // the host's files that failed to load (their moment plays the built-in tune)
const files = new Map(); // file → { el, gain }

const hz = (m) => 440 * 2 ** ((m - 69) / 12);

function ready() {
  const g = audioGraph();
  if (!g) return false;
  if (!ctx) {
    ctx = g.ctx;
    out = ctx.createGain();
    out.gain.value = 0;
    out.connect(g.limiter);
    noise = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate);
    const d = noise.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  return true;
}

// 0–100 → gain. The default 35 sits clearly audible under the sound effects; 100 is about as loud as them.
export const curve = (v) => 0.9 * (v / 100) ** 1.2;

function tone(dest, freq, t, dur, { type = 'sine', gain = 1, attack = 0.005, filter = null, slide = null } = {}) {
  const o = ctx.createOscillator();
  const g = ctx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + attack);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let node = o.connect(g);
  if (filter) {
    const f = ctx.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filter;
    node = g.connect(f);
  }
  node.connect(dest);
  o.start(t);
  o.stop(t + dur + 0.05);
}

function hiss(dest, t, dur, { type = 'highpass', freq = 7000, gain = 1 } = {}) {
  const src = ctx.createBufferSource();
  src.buffer = noise;
  const f = ctx.createBiquadFilter();
  f.type = type;
  f.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(gain, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(dest);
  src.start(t, Math.random() * 0.5, dur + 0.05);
}

// Everything that sounds on one 16th-note step of a song.
function playStep(song, st, step, t) {
  const bar = Math.floor(step / 16);
  const s16 = step % 16;
  const loop = Math.floor(bar / song.bars.length);
  const bars = song.barsB && loop % 2 === 1 ? song.barsB : song.bars;
  const chord = bars[bar % bars.length];
  const L = st.layers;
  const hit = (pattern) => pattern && pattern[s16] !== '.';
  const stepLen = 60 / song.bpm / 4;
  const fill = bar % 4 === 3 && s16 >= 12; // a small drum fill every 4th bar

  if (hit(song.kick)) tone(L.kick, 150, t, 0.25, { gain: 1, slide: 45 });
  if (hit(song.snare) || (fill && song.snare)) {
    if (song.rim) tone(L.snare, 1800, t, 0.03, { type: 'square', gain: 0.4, filter: 4000 });
    else {
      hiss(L.snare, t, 0.12, { type: 'bandpass', freq: 1800, gain: 0.9 });
      tone(L.snare, 200, t, 0.05, { gain: 0.5 });
    }
  }
  if (hit(song.hat)) hiss(L.hat, t, s16 % 4 === 2 ? 0.05 : 0.03);
  if (hit(song.shaker)) hiss(L.shaker, t, 0.04, { type: 'bandpass', freq: 5000, gain: s16 % 4 === 0 ? 1 : 0.6 });
  if (st.hot && hit(song.openhat)) hiss(L.openhat, t, 0.12);

  const b = song.bass?.[s16];
  if (b && b !== '.') {
    const root = chord[0] - 12 + (st.hot ? 12 : 0);
    const note = { r: root, f: root + 7, o: root + 12 }[b];
    const long = song.bass === SONGS.slow.bass;
    tone(L.bass, hz(note), t, long ? stepLen * 7 : stepLen * 1.8, { type: 'triangle', gain: 1, filter: 500 });
    if (!long) tone(L.bass, hz(note), t, stepLen * 1.2, { type: 'square', gain: 0.15, filter: 400 });
  }

  // Now and then the arp sits a round out, so the tune breathes.
  if (song.arp && !(loop % 4 === 3 && song === SONGS.day)) {
    const pattern = song.arp[loop % song.arp.length];
    const a = pattern[s16];
    if (a !== '.') {
      const tones = [...chord.map((n) => n + 24), chord[0] + 36];
      tone(L.arp, hz(tones[Number(a)]), t, stepLen * 1.5, { type: 'square', gain: 1, filter: st.hot ? 3000 : 1500 });
    }
  }

  if (song.pad && s16 === 0 && (bar % 2 === 0 || song.bpm < 100 || song === SONGS.tick)) {
    const dur = stepLen * (song.bpm < 100 || song === SONGS.tick ? 16 : 32);
    for (const n of chord) {
      for (const detune of [-0.06, 0.06]) tone(L.pad, hz(n + 12 + detune), t, dur, { type: 'sawtooth', gain: 0.5, attack: 0.4, filter: 800 });
    }
  }

  // A soft bell on a chord note every second bar (the same note each time round, so it feels planned).
  if (song.bell && s16 === 8 && bar % 2 === 1) tone(L.bell, hz(chord[bar % chord.length] + 24), t, 1.8, { gain: 1, attack: 0.01 });

  // The little tune, every other time round.
  if (song.melody && loop % 2 === 1) {
    const at = (bar % 4) * 16 + s16;
    for (const [s, n, len] of song.melody) if (s === at) tone(L.melody, hz(n), t, stepLen * len, { type: 'triangle', gain: 1, attack: 0.01 });
  }
}

function startSong(name, delay = 0) {
  const song = SONGS[name];
  const bus = ctx.createGain();
  bus.gain.value = 0;
  bus.connect(out);
  const layers = {};
  for (const l of LAYERS) {
    layers[l] = ctx.createGain();
    layers[l].gain.value = 0;
    layers[l].connect(bus);
  }
  const st = { kind: 'song', key: name, bus, layers, step: 0, next: ctx.currentTime + 0.1 + delay, hot: false, start: ctx.currentTime + delay };
  const stepLen = 60 / song.bpm / 4;
  // The lookahead scheduler: every 50 ms, plan the notes of the next 0.2 s on the audio clock.
  st.timer = setInterval(() => {
    while (st.next < ctx.currentTime + 0.2) {
      playStep(song, st, st.step, st.next);
      st.step += 1;
      st.next += stepLen;
    }
  }, 50);
  return st;
}

function fadeOut(st, seconds) {
  if (!st) return;
  const t = ctx.currentTime;
  st.bus.gain.cancelScheduledValues(t);
  st.bus.gain.setValueAtTime(st.bus.gain.value, t);
  st.bus.gain.linearRampToValueAtTime(0, t + seconds);
  setTimeout(() => {
    if (st.timer) clearInterval(st.timer);
    if (st.kind === 'file') st.el.pause();
    else st.bus.disconnect();
  }, seconds * 1000 + 100);
}

function ramp(param, value, seconds, at = ctx.currentTime) {
  param.cancelScheduledValues(at);
  param.setValueAtTime(param.value, at);
  param.linearRampToValueAtTime(value, at + seconds);
}

function filePlayer(name) {
  if (!files.has(name)) {
    const el = new Audio(`/files/${encodeURIComponent(name)}`);
    el.loop = true;
    el.preload = 'auto';
    el.addEventListener('error', () => bad.add(name));
    const gain = ctx.createGain();
    gain.gain.value = 0;
    ctx.createMediaElementSource(el).connect(gain).connect(out);
    files.set(name, { el, gain });
  }
  return files.get(name);
}

// Which of the host's files a mood uses, if any (and it hasn't failed to load).
function fileFor(m, musicFiles) {
  for (const key of [m.file, m.fallbackFile]) {
    const name = key && musicFiles?.[key];
    if (name && !bad.has(name)) return { name, level: key === m.file ? (m.fileLevel ?? m.level) : m.fileLevel ?? 0.6 };
  }
  return null;
}

// Called on every update of the page that plays the music (and a few times a second, for "time's nearly up").
export function syncMusic(view, now) {
  const mood = moodFor(view, now);
  if (typeof document !== 'undefined') document.body.dataset.music = mood;
  if (!ready()) return;
  const v = view?.settings?.musicVolume ?? 35;
  if (v !== volume) {
    volume = v;
    ramp(out.gain, curve(v), 0.2);
  }
  const m = MOODS[mood];
  const first = lastMood === null;
  const changed = mood !== lastMood;
  lastMood = mood;

  if (!m) {
    if (current) fadeOut(current, 0.25);
    current = null;
    return;
  }
  const file = fileFor(m, view.settings.musicFiles);
  const key = file ? `file:${file.name}` : m.song;
  const delay = m.delay && changed && !first ? m.delay : 0;

  if (current?.key !== key) {
    if (current) fadeOut(current, 0.6);
    if (file) {
      const f = filePlayer(file.name);
      if (m.restart) f.el.currentTime = 0;
      setTimeout(() => f.el.play().catch(() => bad.add(file.name)), delay * 1000);
      current = { kind: 'file', key, bus: f.gain, el: f.el };
      ramp(f.gain.gain, file.level, 0.6, ctx.currentTime + delay);
    } else {
      current = startSong(m.song, delay);
      ramp(current.bus.gain, m.level, 0.6, ctx.currentTime + delay);
    }
  } else if (changed) {
    // Same song or file, another moment (thinking → answering, say): only the level changes.
    // (A new question always starts from silence, so a thinking file starts from the beginning each time.)
    ramp(current.bus.gain, file ? file.level : m.level, 0.15);
  }
  if (current.kind === 'song' && current.mood !== mood) {
    current.mood = mood;
    current.hot = Boolean(m.hot);
    const on = m.layers === 'all' ? LAYERS : m.layers;
    const at = Math.max(ctx.currentTime, current.start);
    for (const l of LAYERS) ramp(current.layers[l].gain, on.includes(l) ? LAYER_LEVEL[l] : 0, 0.15, at);
  }
}

export function stopMusic() {
  if (current && ctx) fadeOut(current, 0.4);
  current = null;
  lastMood = null;
  if (typeof document !== 'undefined') delete document.body.dataset.music;
}
