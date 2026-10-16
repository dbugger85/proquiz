// Plays the open question's sound clip, following the game's `media` state ({ playing, seq }).
// Used by the TV, or by the host laptop when no TV screen is open.
//
// The clip is `{ file, start, length? }`: it starts at `start` seconds and, when `length` is set (the editor's trim
// bar), pauses by itself at `start + length`. Key 0 (a new `seq`) or a new question plays the trimmed part again,
// and pressing play after the end starts it over from `start`.

import { fileUrl } from './env.js';

const players = new Map(); // file → <audio>, so clips loaded early start at once
const wired = new WeakSet(); // <audio> elements that already watch for the end of the trimmed part
let current = null; // { key, audio, clip, ended, playing }
let lastSeq = null;
let endTimer = null;

const urlFor = fileUrl;
const endOf = (clip) => (clip.length > 0 ? clip.start + clip.length : Infinity);

function player(file) {
  let a = players.get(file);
  if (!a) {
    a = new Audio(urlFor(file));
    a.preload = 'auto';
    players.set(file, a);
  }
  return a;
}

// Start loading clips before they are needed (called while the board shows).
export function preloadClips(files) {
  for (const f of files) player(f);
}

function seek(a, seconds) {
  const go = () => {
    try {
      a.currentTime = seconds;
    } catch {}
  };
  if (a.readyState >= 1) go();
  else a.addEventListener('loadedmetadata', go, { once: true });
}

// Pause at the end of the trimmed part: a timer set from where the clip is (precise to a few ms), with the
// `timeupdate` event as a safety net, and nothing at all when the clip plays to its end.
function stopAtEnd() {
  if (!current || current.ended) return;
  const { audio: a, clip } = current;
  if (a.currentTime >= endOf(clip) - 0.02) {
    a.pause();
    current.ended = true;
    clearTimeout(endTimer);
  }
}
function armEnd() {
  clearTimeout(endTimer);
  endTimer = null;
  if (!current || current.ended || current.audio.paused) return;
  const { audio: a, clip } = current;
  const end = endOf(clip);
  if (end === Infinity) return;
  const left = Math.max(0, (end - a.currentTime) * 1000);
  endTimer = setTimeout(() => {
    stopAtEnd();
    if (current && !current.ended) armEnd();
  }, Math.max(10, left - 5));
}

function attach(a) {
  a.addEventListener('timeupdate', stopAtEnd);
  a.addEventListener('play', armEnd);
  a.addEventListener('pause', () => clearTimeout(endTimer));
}

// `key` names the open question, so the same file on two questions still starts over.
export function syncClip(view, key) {
  const clip = view.clip;
  const media = view.media;
  if (!clip || !media) {
    stopClip();
    return;
  }
  if (!current || current.key !== key) {
    stopClip();
    current = { key, audio: player(clip.file), clip, ended: false, playing: false };
    const a = current.audio;
    if (!wired.has(a)) {
      attach(a);
      wired.add(a);
    }
    seek(a, clip.start);
    lastSeq = media.seq;
  }
  current.clip = clip;
  const a = current.audio;
  if (media.seq !== lastSeq) {
    lastSeq = media.seq;
    current.ended = false;
    seek(a, clip.start);
  }
  if (media.playing && !current.playing && current.ended) {
    // Play pressed after the trimmed part ended: from the start of it again.
    current.ended = false;
    seek(a, clip.start);
  }
  current.playing = media.playing;
  if (media.playing && a.paused && !current.ended) a.play().catch(() => {});
  if (!media.playing && !a.paused) a.pause();
}

export function stopClip() {
  clearTimeout(endTimer);
  endTimer = null;
  if (current) current.audio.pause();
  current = null;
}

export const clipPlaying = () => Boolean(current && !current.audio.paused);
// For tests: whether the trimmed part has played to its end, and where the player is.
export const clipEnded = () => Boolean(current?.ended);
export const clipTime = () => (current ? { paused: current.audio.paused, time: current.audio.currentTime } : null);
