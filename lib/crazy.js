// Kaosmodus / Crazy mode: hidden special tiles on the board.
//
//   triple   3× the points, and 3× the penalty for every team that answers wrong
//   bomb     no question: the picking team loses the tile's value at once
//   hotseat  only the picking team may answer (normal penalty)
//   rescue   only the team in last place may answer (no penalty)
//   turbo    this tile plus 2 random unplayed ones, back to back: only the picking team answers,
//            5 seconds each, no buzzing and no penalty
//   jackpot  every point lost to wrong answers and bombs has gone into a secret pot; a right answer wins it
//   freeze   the picking team picks a team whose buzzer is off for this question
//
// Randomness comes from a seed the server rolls at the start (state.rng), so the rules stay pure and testable.

export const KINDS = ['triple', 'bomb', 'hotseat', 'rescue', 'turbo', 'jackpot', 'freeze'];
export const TURBO_COUNT = 3;
export const TURBO_SECONDS = 5;
export const CRAZY_LEVELS = ['off', 'some', 'lots'];
const ONLY_ONE = ['turbo', 'jackpot', 'rescue']; // at most one of each on a board

// A small seeded random generator (mulberry32). Returns a number in [0, 1) and moves the seed on.
export function nextRandom(s) {
  let t = (s.rng = (s.rng + 0x6d2b79f5) >>> 0);
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}

// How many specials a board gets: about 1 in 8 tiles for "a little", 1 in 4 for "lots".
export function specialCount(level, tiles) {
  if (level === 'some') return Math.min(tiles, Math.max(1, Math.round(tiles / 8)));
  if (level === 'lots') return Math.min(tiles, Math.max(2, Math.round(tiles / 4)));
  return 0;
}

// Where the specials go: { "c-i": kind }. Always a triple and a bomb first, then a random mix.
export function placeSpecials(s, level) {
  const tiles = [];
  s.set.categories.forEach((cat, c) => cat.questions.forEach((_, i) => tiles.push(`${c}-${i}`)));
  const count = specialCount(level, tiles.length);
  const kinds = ['triple', 'bomb'].slice(0, count);
  while (kinds.length < count) {
    const options = KINDS.filter((k) => !(ONLY_ONE.includes(k) && kinds.includes(k)));
    kinds.push(options[Math.floor(nextRandom(s) * options.length)]);
  }
  // Shuffle the tiles and hand out the kinds.
  for (let n = tiles.length - 1; n > 0; n--) {
    const m = Math.floor(nextRandom(s) * (n + 1));
    [tiles[n], tiles[m]] = [tiles[m], tiles[n]];
  }
  return Object.fromEntries(kinds.map((kind, n) => [tiles[n], kind]));
}

// Turbo: pick more unplayed tiles (not the picked one, not other specials), in random order.
export function turboTiles(s, count) {
  const free = [];
  s.used.forEach((col, c) =>
    col.forEach((used, i) => {
      if (!used && !s.specials[`${c}-${i}`]) free.push([c, i]);
    }),
  );
  const out = [];
  while (out.length < count && free.length) out.push(free.splice(Math.floor(nextRandom(s) * free.length), 1)[0]);
  return out;
}

// The team in last place (for rescue). With a tie, the first of them in the team list.
export function lastPlace(teams) {
  return teams.reduce((low, t) => (low === null || t.score < low.score ? t : low), null);
}
