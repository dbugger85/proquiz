// Which background music plays when (the sound itself can only be heard, not tested here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moodFor, SONGS, MOODS, curve } from '../public/js/music.js';
import { soundGain } from '../public/js/sounds.js';
import { MUSIC_MOODS, DEFAULT_SETTINGS } from '../lib/game.js';

const view = (phase, extra = {}) => ({ phase, settings: { music: true }, clip: null, deadline: null, ...extra });

test('the music follows the game', () => {
  assert.equal(moodFor(view('lobby')), 'lobby');
  assert.equal(moodFor(view('board')), 'board');
  assert.equal(moodFor(view('round2')), 'board'); // round 2's intro keeps the board music going
  assert.equal(moodFor(view('special')), 'silent'); // the Kaosmodus reel
  assert.equal(moodFor(view('reading')), 'thinking');
  assert.equal(moodFor(view('armed', { deadline: 10_000 }), 1000), 'thinking');
  assert.equal(moodFor(view('armed', { deadline: 10_000 }), 7500), 'hot'); // the last 3 seconds
  assert.equal(moodFor(view('armed')), 'thinking'); // no timer
  assert.equal(moodFor(view('answering')), 'answering');
  assert.equal(moodFor(view('revealed')), 'calm'); // a soft tune after the answer's sting
  assert.equal(moodFor(view('finalWager')), 'final');
  assert.equal(moodFor(view('finalQuestion')), 'finalQ');
  assert.equal(moodFor(view('finalJudge')), 'judge');
  assert.equal(moodFor(view('over')), 'over');
});

test('the music follows a Quick quiz', () => {
  assert.equal(moodFor(view('section')), 'board');
  assert.equal(moodFor(view('ready', { deadline: 4000 })), 'thinking');
  assert.equal(moodFor(view('open', { deadline: 20_000 }), 1000), 'thinking');
  assert.equal(moodFor(view('open', { deadline: 20_000 }), 18_000), 'hot'); // the last 3 seconds
  assert.equal(moodFor(view('result')), 'calm'); // after the reveal chime, a soft tune
  assert.equal(moodFor(view('ranks')), 'calmUp'); // the same tune, a little fuller, under the top 5
  assert.equal(moodFor(view('over')), 'over');
  const clip = { file: 'song.mp3', start: 0 };
  assert.equal(moodFor(view('ready', { clip })), 'silent');
  assert.equal(moodFor(view('open', { clip })), 'silent');
  assert.equal(moodFor(view('result', { clip })), 'silent'); // the clip plays on
  assert.equal(moodFor(view('section', { clip: null, settings: { music: false } })), 'off');
});

test('quiet for sound clips, and off when switched off', () => {
  const clip = { file: 'song.mp3', start: 0 };
  assert.equal(moodFor(view('reading', { clip })), 'silent');
  assert.equal(moodFor(view('armed', { clip })), 'silent');
  assert.equal(moodFor(view('finalQuestion', { clip })), 'silent');
  assert.equal(moodFor(view('revealed', { clip })), 'silent');
  assert.equal(moodFor(view('lobby', { settings: { music: false } })), 'off');
  assert.equal(moodFor(null), 'off');
});

test('the built-in songs are well formed', () => {
  for (const [name, song] of Object.entries(SONGS)) {
    for (const key of ['kick', 'snare', 'hat', 'shaker', 'openhat', 'bass']) if (song[key]) assert.equal(song[key].length, 16, `${name}.${key}`);
    for (const p of song.arp ?? []) {
      assert.equal(p.length, 16, `${name}.arp`);
      assert.match(p, /^[0-3.]+$/);
    }
    assert.ok(song.bars.every((chord) => chord.length >= 3));
    if (song.bass) assert.match(song.bass, /^[rfo.]+$/);
  }
});

test('the calm tune is ambient and every mood has music', () => {
  const glow = SONGS.glow;
  for (const key of ['kick', 'snare', 'hat', 'shaker', 'openhat', 'melody']) assert.equal(glow[key], undefined, `glow.${key}`);
  assert.ok(glow.bpm < 90);
  assert.ok(MOODS.calm.delay > 0); // the reveal chime stands alone first
  assert.equal(MOODS.calm.song, MOODS.calmUp.song); // so the top 5 only lifts it, no crossfade
  const phases = ['lobby', 'board', 'round2', 'reading', 'armed', 'answering', 'revealed', 'special', 'finalWager', 'finalQuestion', 'finalJudge', 'over', 'section', 'ready', 'open', 'result', 'ranks'];
  const moods = new Set(phases.flatMap((p) => [moodFor(view(p, { deadline: 10_000 }), 0), moodFor(view(p, { deadline: 10_000 }), 9000)]));
  for (const mood of moods) if (mood !== 'silent' && mood !== 'off') assert.ok(MOODS[mood], mood);
  for (const [name, m] of Object.entries(MOODS)) {
    assert.ok(SONGS[m.song], `${name}.song`);
    for (const f of [m.file, m.fallbackFile]) if (f) assert.ok(MUSIC_MOODS.includes(f), `${name}: ${f}`);
  }
});

test('louder by default: both volumes start at 80, 80% effects are a little above the old level, 100% stays under the limiter', () => {
  assert.equal(DEFAULT_SETTINGS.musicVolume, 80);
  assert.equal(DEFAULT_SETTINGS.soundVolume, 80);
  assert.ok(soundGain(80) > 0.8 && soundGain(80) <= 1.0, `80% gives ${soundGain(80)}`); // the effects played at 0.8 before 2.3
  assert.ok(soundGain(100) <= 1.25);
  assert.ok(soundGain(100) > soundGain(80));
  assert.equal(soundGain(0), 0);
  assert.equal(soundGain(undefined), soundGain(80)); // a game saved before the setting existed
  assert.equal(soundGain(140), soundGain(100));
  assert.ok(curve(80) > curve(35)); // the music is louder at the new default too
});
