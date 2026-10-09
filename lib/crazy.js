// Kaosmodus / Crazy mode: hidden special tiles on the board.
//
//   triple   3× the points, and 3× the penalty for every team that answers wrong
//   bomb     no question: the picking team loses the tile's value at once
//   hotseat  only the picking team may answer (normal penalty)
//   rescue   only the team in last place may answer (no penalty)
//   turbo    this tile plus 2 random unplayed ones, back to back: only the picking team answers,
//            5 seconds each, no buzzing and no penalty
//   jackpot  every point lost to wrong answers and bombs has gone into a secret pot; a right answer wins it
//   freeze   the picking team picks a team (on its phone, or the host clicks it) whose buzzer is off for this question
//   double   Daily Double: the picking team bets first (up to its score, or the board's top value if that's more),
//            then answers alone; right wins the bet, wrong loses all of it
//
// A quiz can also have specials placed by hand in the editor (`special` on a question). Those always play
// (unless the host turns them off in the lobby), and Kaosmodus adds random ones on the other tiles.
//
// Randomness comes from a seed the server rolls at the start (state.rng), so the rules stay pure and testable.

export const KINDS = ['triple', 'bomb', 'hotseat', 'rescue', 'turbo', 'jackpot', 'freeze', 'double'];
export const TURBO_COUNT = 3;
export const TURBO_SECONDS = 5;
export const CRAZY_LEVELS = ['off', 'some', 'lots'];
const ONLY_ONE = ['turbo', 'jackpot', 'rescue', 'double']; // at most one of each on a board (random ones)

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

// Where the specials go: { "c-i": kind }. A triple and a bomb first (unless left out), then a random mix
// of the kinds the host kept. With few kinds left (only turbo, say) the board may get fewer specials.
// They're spread out: no category gets a second special before every category has one. The kinds where
// one team answers alone (SOLO) never go on a picture question, so everyone gets to see those.
// `own` are the specials placed by hand ({ "c-i": kind }): they count towards the number, their tiles
// are taken, and a kind that may only appear once isn't added again.
export const SOLO = ['hotseat', 'rescue', 'turbo', 'double'];

// The board being played: round 2's categories once round 2 has started, otherwise the main board.
export function boardOf(s) {
  return s.round === 2 && s.set.round2 ? s.set.round2.categories : s.set.categories;
}
const hasPicture = (q) => Boolean(q?.image);

export function placeSpecials(s, level, exclude = [], own = {}) {
  const allowed = KINDS.filter((k) => !exclude.includes(k));
  const ownKinds = Object.values(own);
  const tiles = [];
  boardOf(s).forEach((cat, c) => cat.questions.forEach((q, i) => tiles.push({ key: `${c}-${i}`, c, picture: hasPicture(q) })));
  const count = allowed.length ? Math.max(0, specialCount(level, tiles.length) - ownKinds.length) : 0;
  const kinds = ['triple', 'bomb'].filter((k) => allowed.includes(k) && !ownKinds.includes(k)).slice(0, count);
  while (kinds.length < count) {
    const options = allowed.filter((k) => !(ONLY_ONE.includes(k) && (kinds.includes(k) || ownKinds.includes(k))));
    if (!options.length) break;
    kinds.push(options[Math.floor(nextRandom(s) * options.length)]);
  }
  // Shuffle the tiles, then hand out the kinds: each takes a free tile it may go on, in the category
  // with the fewest specials so far.
  for (let n = tiles.length - 1; n > 0; n--) {
    const m = Math.floor(nextRandom(s) * (n + 1));
    [tiles[n], tiles[m]] = [tiles[m], tiles[n]];
  }
  const out = {};
  const inCategory = {};
  for (const key of Object.keys(own)) inCategory[key.split('-')[0]] = (inCategory[key.split('-')[0]] ?? 0) + 1;
  for (const kind of kinds) {
    let best = null;
    for (const t of tiles) {
      if (t.key in out || t.key in own || (SOLO.includes(kind) && t.picture)) continue;
      if (!best || (inCategory[t.c] ?? 0) < (inCategory[best.c] ?? 0)) best = t;
    }
    if (!best) continue;
    out[best.key] = kind;
    inCategory[best.c] = (inCategory[best.c] ?? 0) + 1;
  }
  return out;
}

// Turbo: pick more unplayed tiles (not the picked one, not other specials, no pictures), in random order.
export function turboTiles(s, count) {
  const free = [];
  s.used.forEach((col, c) =>
    col.forEach((used, i) => {
      if (!used && !s.specials[`${c}-${i}`] && !hasPicture(boardOf(s)[c].questions[i])) free.push([c, i]);
    }),
  );
  const out = [];
  while (out.length < count && free.length) out.push(free.splice(Math.floor(nextRandom(s) * free.length), 1)[0]);
  return out;
}

// The specials placed by hand on a board: { "c-i": kind } for every question with a known `special`.
export function ownSpecials(categories) {
  const out = {};
  (categories ?? []).forEach((cat, c) => cat.questions.forEach((q, i) => KINDS.includes(q?.special) && (out[`${c}-${i}`] = q.special)));
  return out;
}

// Daily Double: the most a team may bet. Its score, or the top value of the board being played if that is more.
export function maxBet(categories, score) {
  const top = Math.max(0, ...categories.flatMap((cat) => cat.questions.map((q) => q.value)));
  return Math.max(score, top);
}

// The team in last place (for rescue). With a tie, the first of them in the team list.
export function lastPlace(teams) {
  return teams.reduce((low, t) => (low === null || t.score < low.score ? t : low), null);
}
