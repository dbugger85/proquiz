// This browser's room on the website version (docs/dev/web-plan.md §1.4): a secret key the browser makes and keeps
// in localStorage, and the room code made from it. The host page opens its room with it, and the editor sends it
// with its picture and song searches (which run in the room). The same key reopens the same room after a refresh
// (or a restart of the room). Only used when HOSTED.

import { newKey, codeFor, KEY } from '/lib/room.js';

export const ROOM_KEY = 'proquiz.room'; // { code, key, at }

// The saved room, with its code worked out again from the key; null when there is none.
export async function loadRoom() {
  try {
    const saved = JSON.parse(localStorage.getItem(ROOM_KEY));
    if (saved && KEY.test(saved.key)) return { ...saved, code: await codeFor(saved.key) };
  } catch {
    // nothing saved, or no storage
  }
  return null;
}

// A new key, and so a new room, kept for next time.
export async function makeRoom() {
  const key = newKey();
  const made = { code: await codeFor(key), key, at: Date.now() };
  try {
    localStorage.setItem(ROOM_KEY, JSON.stringify(made));
  } catch {
    // no storage: the room lasts as long as this page
  }
  return made;
}

// The room this browser has, or a new one.
export const myRoom = async () => (await loadRoom()) ?? (await makeRoom());
