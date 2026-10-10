// Avatars (a Quick quiz player's face, a board team's mascot): which parts there are and how many options each
// has, checking what a phone sends, and a random one. No DOM: the server, the tests and the browser share it.
// The drawings live in public/js/avatar.js; a test checks that both agree on the number of options.

// Option counts. 0 is "bald" for hair and "none" for glasses and hats.
export const AVATAR_PARTS = { skin: 6, hair: 8, hairColor: 6, eyes: 5, mouth: 5, glasses: 4, hat: 6 };
export const AVATAR_KEYS = Object.keys(AVATAR_PARTS);

// Is this a complete avatar with every part a whole number in range? (Other keys are ignored.)
export function isValidAvatar(a) {
  if (!a || typeof a !== 'object' || Array.isArray(a)) return false;
  return AVATAR_KEYS.every((k) => Number.isInteger(a[k]) && a[k] >= 0 && a[k] < AVATAR_PARTS[k]);
}

// The avatar with only the known parts, in a fixed order, or null for none. Call isValidAvatar() first.
export function cleanAvatar(a) {
  if (a == null) return null;
  return Object.fromEntries(AVATAR_KEYS.map((k) => [k, a[k]]));
}

// A random avatar. Glasses and hats are left off about half the time, so a lobby isn't all hats.
export function randomAvatar(rnd = Math.random) {
  const pick = (n) => Math.min(n - 1, Math.floor(rnd() * n));
  const a = Object.fromEntries(AVATAR_KEYS.map((k) => [k, pick(AVATAR_PARTS[k])]));
  a.glasses = rnd() < 0.5 ? 0 : 1 + pick(AVATAR_PARTS.glasses - 1);
  a.hat = rnd() < 0.5 ? 0 : 1 + pick(AVATAR_PARTS.hat - 1);
  return a;
}

// A short text that is the same for the same avatar, e.g. "3-5-1-2-0-4-0" (for caches).
export const avatarKey = (a) => (isValidAvatar(a) ? AVATAR_KEYS.map((k) => a[k]).join('-') : '');

// `{ avatar }` for a team that has one, else `{}`: spread into the views so teams without one stay as they were.
export const avatarOf = (team) => (team?.avatar ? { avatar: team.avatar } : {});
