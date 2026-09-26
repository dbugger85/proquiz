// Plays the open question's sound clip, following the game's `media` state ({ playing, seq }).
// Used by the TV, or by the host laptop when no TV screen is open.

const players = new Map(); // file → <audio>, so clips loaded early start at once
let current = null; // { key, audio }
let lastSeq = null;

const urlFor = (file) => `/files/${encodeURIComponent(file)}`;

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
    current = { key, audio: player(clip.file) };
    seek(current.audio, clip.start);
    lastSeq = media.seq;
  }
  const a = current.audio;
  if (media.seq !== lastSeq) {
    lastSeq = media.seq;
    seek(a, clip.start);
  }
  if (media.playing && a.paused) a.play().catch(() => {});
  if (!media.playing && !a.paused) a.pause();
}

export function stopClip() {
  if (current) current.audio.pause();
  current = null;
}

export const clipPlaying = () => Boolean(current && !current.audio.paused);
