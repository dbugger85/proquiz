// Game-show sounds, made with the Web Audio API (no sound files needed).
// Browsers only allow sound after a click or key press on the page: call unlockAudio() from one.

let ctx = null;
let master = null;
let limiter = null;
let volume = 0.8;

function audio() {
  if (!ctx) {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return null;
    ctx = new AC();
    master = ctx.createGain();
    master.gain.value = volume;
    // A gentle limiter so chords never clip on loud TV speakers.
    limiter = ctx.createDynamicsCompressor();
    limiter.threshold.value = -10;
    limiter.ratio.value = 6;
    limiter.connect(ctx.destination);
    master.connect(limiter);
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

// One note: an oscillator with a quick attack and a smooth fade.
function note(freq, { at = 0, dur = 0.3, type = 'sine', gain = 0.3, slide = null, filter = null } = {}) {
  const a = audio();
  if (!a || a.state !== 'running') return;
  const t = a.currentTime + at;
  const osc = a.createOscillator();
  const g = a.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(freq, t);
  if (slide) osc.frequency.exponentialRampToValueAtTime(slide, t + dur);
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  let out = osc.connect(g);
  if (filter) {
    const f = a.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = filter;
    out = g.connect(f);
  }
  out.connect(master);
  osc.start(t);
  osc.stop(t + dur + 0.05);
}

// A short burst of filtered noise that sweeps up: the "whoosh" when a question opens.
function whoosh({ at = 0, dur = 0.45, gain = 0.25 } = {}) {
  const a = audio();
  if (!a || a.state !== 'running') return;
  const t = a.currentTime + at;
  const buf = a.createBuffer(1, Math.ceil(a.sampleRate * dur), a.sampleRate);
  const data = buf.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  const src = a.createBufferSource();
  src.buffer = buf;
  const f = a.createBiquadFilter();
  f.type = 'bandpass';
  f.Q.value = 1.2;
  f.frequency.setValueAtTime(300, t);
  f.frequency.exponentialRampToValueAtTime(3500, t + dur);
  const g = a.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(gain, t + dur * 0.6);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  src.connect(f).connect(g).connect(master);
  src.start(t);
}

const hz = (midi) => 440 * 2 ** ((midi - 69) / 12);

// Each team's buzz is a different note of a major pentatonic scale, so any two teams sound good together
// and everyone learns their own tone. Index = the team's colour number (0–7).
const TEAM_NOTES = [72, 76, 79, 81, 84, 86, 88, 91]; // C5 E5 G5 A5 C6 D6 E6 G6

export const sounds = {
  join() {
    note(hz(79), { dur: 0.12, gain: 0.2 });
    note(hz(84), { at: 0.07, dur: 0.18, gain: 0.2 });
  },
  pick() {
    whoosh();
    note(hz(67), { at: 0.3, dur: 0.25, type: 'triangle', gain: 0.18 });
  },
  armed() {
    // A bright "go" ding.
    note(hz(88), { dur: 0.5, gain: 0.25 });
    note(hz(95), { dur: 0.35, gain: 0.08 });
  },
  buzz(teamIndex = 0) {
    const n = TEAM_NOTES[teamIndex % TEAM_NOTES.length];
    // A punchy chord on the team's note: root, fifth and octave, with a buzzy edge.
    note(hz(n), { dur: 0.6, type: 'sawtooth', gain: 0.16, filter: 2600 });
    note(hz(n + 7), { dur: 0.55, type: 'square', gain: 0.07, filter: 2200 });
    note(hz(n + 12), { dur: 0.5, type: 'triangle', gain: 0.14 });
  },
  early() {
    note(180, { dur: 0.18, type: 'sine', gain: 0.25, slide: 110 });
  },
  correct() {
    [72, 76, 79, 84].forEach((m, i) => note(hz(m + 12), { at: i * 0.08, dur: 0.45, type: 'triangle', gain: 0.2 }));
    note(hz(96), { at: 0.32, dur: 0.6, gain: 0.1 });
  },
  wrong() {
    note(233, { dur: 0.55, type: 'sawtooth', gain: 0.22, slide: 147, filter: 900 });
    note(220, { dur: 0.55, type: 'square', gain: 0.1, slide: 139, filter: 700 });
  },
  timeup() {
    // The classic "doo doo doo".
    [67, 64, 60].forEach((m, i) => note(hz(m), { at: i * 0.22, dur: 0.24, type: 'square', gain: 0.13, filter: 1500 }));
  },
  tick() {
    note(1800, { dur: 0.04, type: 'square', gain: 0.06, filter: 4000 });
  },
  reveal() {
    note(hz(76), { dur: 0.25, type: 'triangle', gain: 0.18 });
    note(hz(72), { at: 0.12, dur: 0.35, type: 'triangle', gain: 0.16 });
  },
  undo() {
    note(hz(79), { dur: 0.1, gain: 0.14, slide: hz(72) });
  },
  final() {
    // A suspense sting for the final round.
    [48, 55, 60, 63].forEach((m, i) => note(hz(m), { at: i * 0.18, dur: 1.6 - i * 0.18, type: 'sawtooth', gain: 0.08, filter: 1200 }));
  },
  // Kaosmodus reveal: the reel ticks, slowing down over ~1.9 s (as long as the TV's reel animation),
  // then the special's own sting as it lands.
  mystery(kind) {
    sounds.sting(kind, sounds.reel());
  },
  // Each special's own sound (on its own, `at` = 0).
  sting(kind, at = 0) {
    const stings = {
      triple: () => [76, 83, 88].forEach((m, i) => note(hz(m), { at: at + i * 0.1, dur: 0.5, type: 'triangle', gain: 0.2 })),
      bomb: () => {
        note(90, { at, dur: 1.1, type: 'sawtooth', gain: 0.2, slide: 45, filter: 400 });
        note(hz(55), { at, dur: 0.9, type: 'square', gain: 0.06, filter: 700 });
      },
      turbo: () => [0, 1, 2, 3, 4, 5].forEach((n) => note(hz(79 + n * 2), { at: at + n * 0.06, dur: 0.08, type: 'square', gain: 0.1, filter: 3000 })),
      jackpot: () => [72, 76, 79, 84, 88].forEach((m, i) => note(hz(m + 12), { at: at + i * 0.07, dur: 0.6, type: 'triangle', gain: 0.14 })),
      freeze: () => [96, 91, 88, 84].forEach((m, i) => note(hz(m), { at: at + i * 0.09, dur: 0.5, gain: 0.12 })),
      hotseat: () => note(hz(60), { at, dur: 0.8, type: 'sawtooth', gain: 0.12, slide: hz(72), filter: 1800 }),
      rescue: () => [67, 72, 76].forEach((m, i) => note(hz(m), { at: at + i * 0.14, dur: 0.4, type: 'triangle', gain: 0.18 })),
    };
    stings[kind]?.();
  },
  // The reel's ticks; returns how long they last (in seconds).
  reel() {
    let at = 0;
    for (let n = 0; n < 16; n++) {
      note(1200 + (n % 2) * 300, { at, dur: 0.035, type: 'square', gain: 0.07, filter: 5000 });
      at += 0.035 + n * n * 0.0011;
    }
    return at;
  },
  boom() {
    whoosh({ dur: 0.9, gain: 0.35 });
    note(70, { dur: 1.4, type: 'sawtooth', gain: 0.3, slide: 30, filter: 300 });
    note(45, { at: 0.05, dur: 1.2, type: 'sine', gain: 0.35, slide: 25 });
  },
  fanfare() {
    // Da-da-da-daaa, with a big major chord at the end.
    const brass = (m, at, dur) => {
      note(hz(m), { at, dur, type: 'sawtooth', gain: 0.12, filter: 2400 });
      note(hz(m + 12), { at, dur, type: 'triangle', gain: 0.08 });
    };
    brass(67, 0, 0.16);
    brass(67, 0.18, 0.16);
    brass(67, 0.36, 0.16);
    brass(72, 0.56, 1.4);
    [76, 79, 84].forEach((m) => note(hz(m), { at: 0.56, dur: 1.4, type: 'triangle', gain: 0.09 }));
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
