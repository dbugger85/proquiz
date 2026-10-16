// Room codes for the website version (docs/dev/web-plan.md §1.4). The host's browser makes a secret key; the room
// code is made from the key, so the server can tell the host by recomputing it and never has to store anything.
// Pure: runs in Node, Deno, a browser and a Worker through globalThis.crypto.

export const CODE_LENGTH = 6;
// 32 symbols, without 0/O and 1/I so a code read out loud or typed from a TV can't be misread.
export const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
export const ROOM_CODE = new RegExp(`^[${CODE_ALPHABET}]{${CODE_LENGTH}}$`);

// A fresh host key: 16 random bytes as base64url (22 characters, no padding).
export function newKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(16));
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export const KEY = /^[A-Za-z0-9_-]{22}$/;

// The room code for a key: the first CODE_LENGTH base32 characters of sha256(key).
export async function codeFor(key) {
  if (typeof key !== 'string' || !key) throw new Error('bad-key');
  const hash = new Uint8Array(await globalThis.crypto.subtle.digest('SHA-256', new TextEncoder().encode(key)));
  return base32(hash).slice(0, CODE_LENGTH);
}

// Bytes as base32 with CODE_ALPHABET (no padding).
export function base32(bytes) {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CODE_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CODE_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

// What someone typed, as a code: upper case, spaces and dashes dropped. Returns the code, or null when it can't
// be one (a code never has 0, O, 1 or I, so those are a sign of a misread).
export function normalizeCode(text) {
  const code = String(text ?? '').toUpperCase().replace(/[\s-]/g, '');
  return ROOM_CODE.test(code) ? code : null;
}

// Pictures and clips during a game on the website (web-plan.md §3, owner's decision 5): the host's browser uploads
// them into the room, which keeps them in memory while the game is played. One file at most MAX_ROOM_FILE, and
// all of a quiz's files together at most MAX_ROOM_MEDIA.
export const MAX_ROOM_FILE = 8 * 1024 * 1024;
export const MAX_ROOM_MEDIA = 48 * 1024 * 1024;
