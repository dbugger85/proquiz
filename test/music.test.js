// Which background music plays when (the sound itself can only be heard, not tested here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { moodFor, SONGS } from '../public/js/music.js';

const view = (phase, extra = {}) => ({ phase, settings: { music: true }, clip: null, deadline: null, ...extra });

test('the music follows the game', () => {
  assert.equal(moodFor(view('lobby')), 'lobby');
  assert.equal(moodFor(view('board')), 'board');
  assert.equal(moodFor(view('special')), 'silent'); // the Kaosmodus reel
  assert.equal(moodFor(view('reading')), 'thinking');
  assert.equal(moodFor(view('armed', { deadline: 10_000 }), 1000), 'thinking');
  assert.equal(moodFor(view('armed', { deadline: 10_000 }), 7500), 'hot'); // the last 3 seconds
  assert.equal(moodFor(view('armed')), 'thinking'); // no timer
  assert.equal(moodFor(view('answering')), 'answering');
  assert.equal(moodFor(view('revealed')), 'silent');
  assert.equal(moodFor(view('finalWager')), 'final');
  assert.equal(moodFor(view('finalQuestion')), 'finalQ');
  assert.equal(moodFor(view('finalJudge')), 'judge');
  assert.equal(moodFor(view('over')), 'over');
});

test('quiet for sound clips, and off when switched off', () => {
  const clip = { file: 'song.mp3', start: 0 };
  assert.equal(moodFor(view('reading', { clip })), 'silent');
  assert.equal(moodFor(view('armed', { clip })), 'silent');
  assert.equal(moodFor(view('finalQuestion', { clip })), 'silent');
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
