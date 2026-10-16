// The hub: the one game and everyone connected to it (the host laptop, the TV screens and the phones), the
// WebSocket protocol (docs/dev/network-and-remote.md), fair buzzing, resume, and "players elsewhere" (the PIN).
// It knows nothing about Node: server.js gives it `ws` sockets and tells it which connections come from the
// laptop itself, and the website version (docs/dev/web-plan.md) gives it the same from a Durable Object. The only
// socket surface used is send(), readyState === 1, on('message' | 'close' | 'pong'), ping() and terminate().

import { validateSet } from './validate.js';
import { SAMPLE_ID } from './store-core.js';
import { cleanBrand, cleanLogo, isNoBrand, NO_BRAND } from './brand-core.js';
import { apply, newGame, hostView, displayView, phoneView, GameError, DEFAULT_SETTINGS, nextTimerAt, MAX_SLACK_MS, MAX_REMOTE_SLACK_MS, COLORS, MAX_TEAMS, MAX_PLAYERS, newColor, resumeFix, reactionFor } from './game.js';

// What the host laptop may do, and what a phone may do (always for its own team).
export const HOST_ACTIONS = new Set([
  'settings', 'loadSet', 'start', 'setPicker', 'pick', 'arm', 'correct', 'wrong', 'reveal', 'cancel',
  'next', 'end', 'judgeFinal', 'adjust', 'undo', 'restart', 'removeTeam', 'mediaToggle', 'mediaRestart', 'freeze', 'bet',
  'skip', // Quick quiz
]);
export const PHONE_ACTIONS = new Set(['buzz', 'wager', 'finalAnswer', 'pick', 'freezePick', 'bet', 'answer', 'language']); // language: the phone's choice of quiz language (lib/languages.js)

// Quick quiz reactions: a phone may send one this often; extra ones are dropped (100 players can't flood the TV).
const REACT_EVERY_MS = 1000;

// Fair buzzing: how the server measures each phone's clock (see clockSample() and pressTime() below).
export const CLOCK_EVERY_MS = 5000; // one measurement per phone this often, while the setting is on (the website: 20 s)
export const CLOCK_BURST = 5; // measurements right after a phone connects (or the setting is turned on)
const CLOCK_KEEP_MS = 20_000; // older measurements are forgotten
const CLOCK_MAX_RTT_MS = 2000; // a reply slower than this is useless

// The website version: a quiz sent by the host over the WebSocket (`cmd loadSet`) may be this big as JSON.
export const MAX_SET_BYTES = 600 * 1024;
// The website version: wrong host keys allowed per minute (web/room.js); after that, wrong keys are refused without
// being looked at for a minute. The right key always works: a 128-bit key can't be guessed, so locking it out would
// only let anyone with the room code keep the host out.
export const HOST_KEY_TRIES_PER_MINUTE = 5;
// Dead connections (a phone whose Wi-Fi dropped) are noticed by a ping every so often (the website: 30 s, since
// every answer there is a message the room pays for).
export const HEARTBEAT_MS = 10_000;

// A saved game as the autosave (or the host's browser) hands it over: { v: 1, savedAt, state } with teams and a quiz.
export const looksLikeSave = (data) => Boolean(data && data.v === 1 && Array.isArray(data.state?.teams) && data.state.set);

// Settings saved before 2.3 (no `soundVolume` yet) had the music at 35% by default; the default is 80% now, so a
// save still at exactly 35 moves to 80, once. Any other value is the host's own choice and stays.
export function louderSettings(saved) {
  if (!saved || typeof saved !== 'object' || 'soundVolume' in saved || saved.musicVolume !== 35) return saved;
  return { ...saved, musicVolume: 80 };
}

// Settings from a save, but only the ones this version knows (so an old save can't break a new game).
function pickSettings(saved) {
  if (!saved) return {};
  saved = louderSettings(saved);
  const out = {};
  for (const key of Object.keys(DEFAULT_SETTINGS)) if (key in saved) out[key] = saved[key];
  try {
    newGame({ categories: [] }, out);
    return out;
  } catch {
    return {};
  }
}

// What the host sees before deciding to resume: when, who, and how far the game got.
// For a Quick quiz `played`/`total` count questions (a question counts once its result has been shown).
function summary(saved) {
  const st = saved.state;
  const quick = st.mode === 'quick';
  return {
    savedAt: saved.savedAt,
    title: st.set?.title ?? '',
    mode: quick ? 'quick' : 'board',
    teams: st.teams.map((t) => ({ name: t.name, color: newColor(t.color), ...(t.avatar && { avatar: t.avatar }), score: t.score })),
    played: quick ? quickPlayed(st) : st.used?.flat().filter(Boolean).length ?? 0,
    total: quick ? (st.set.sections ?? []).reduce((n, sec) => n + sec.questions.length, 0) : st.used?.flat().length ?? 0,
    phase: st.phase,
    round: st.round ?? 1,
  };
}

function quickPlayed(st) {
  const sections = st.set.sections ?? [];
  if (st.phase === 'over') return sections.reduce((n, sec) => n + sec.questions.length, 0);
  if (!st.pos) return 0;
  const before = sections.slice(0, st.pos.s).reduce((n, sec) => n + sec.questions.length, 0) + st.pos.i;
  return before + (['result', 'ranks'].includes(st.phase) ? 1 : 0);
}

// Players elsewhere: wrong PINs allowed per minute (for all remote phones together), so nobody can try them all.
const PIN_TRIES_PER_MINUTE = 10;

// Holds the one game and everyone connected to it. `tunnel` (lib/tunnel.js) is the internet tunnel, if any,
// `updates` (lib/update.js) the "a new version is out" check, asked when a host page connects, and `selfUpdate`
// (lib/selfupdate.js) the "Update now" of the compiled program. `hostInfo` goes in the host's welcome only.
// `fromLaptop(req)` says whether a connection comes from the laptop's own pages (server.js; the host may only
// connect from there). The website version (docs/dev/web-plan.md §1.1) sets `hosted` (every phone counts as
// "elsewhere", so the PIN and the slack caps work as over the tunnel, and the TV never shows the PIN), `hostKey`
// (a host hello carries it instead of being local; a string, or a function `(key) => boolean` when the room
// learns its key from the first host, see web/room.js), `clockEveryMs`/`clockBurst` (fewer clock pings) and has no
// `store`: the host sends the quiz itself with `cmd loadSet` and the autosave back with `restore`. It has no `brand`
// store either: the host's browser sends its branding with `brand {name, accent, plate, logo}` (the logo as the
// name of a file it put in the room's file store, `logoUrl(name)` gives the address the screens load it from), and
// the hub keeps it in memory for every view, as brand.js's does on the laptop.
export function createHub({
  set,
  info,
  hostInfo = {},
  saved = null,
  save = () => {},
  store = null,
  tunnel = null,
  brand = null,
  updates = null,
  selfUpdate = null,
  onQuit = () => {},
  fromLaptop = () => false,
  hosted = false,
  hostKey = null,
  clockEveryMs = CLOCK_EVERY_MS,
  clockBurst = CLOCK_BURST,
  heartbeatMs = HEARTBEAT_MS,
  logoUrl = (name) => `/files/${name}`,
}) {
  // A new game keeps the settings and the quiz from last time. A saved game with teams can be resumed from the lobby.
  const fromSave = (data) => {
    const lastSet = data?.state?.set && validateSet(data.state.set).length === 0 ? data.state : null;
    return {
      state: newGame(lastSet ? lastSet.set : set, pickSettings(data?.state?.settings), lastSet ? lastSet.setId : SAMPLE_ID),
      resumable: data?.state?.teams?.length ? data : null,
    };
  };
  let { state, resumable } = fromSave(saved);
  const clients = new Set(); // { ws, role: 'host' | 'display' | 'phone', local, remote, teamId, askedTeamId, alive, pings, samples }
  let pinMisses = []; // times of wrong PINs (players elsewhere)
  let ownBrand = null; // the website version: the host's branding as its browser sent it ({name, accent, plate, logo: file name})
  let timer = null;
  let pingId = 0;

  // The host's logo, event name and accent colour, the same for everyone: from brand.js on the laptop, from the
  // host's `brand` message on the website (the logo's address points into the room's file store).
  function brandView() {
    if (brand) return brand.view();
    if (!ownBrand) return null;
    return { name: ownBrand.name, accent: ownBrand.accent, plate: ownBrand.plate, logo: ownBrand.logo ? logoUrl(ownBrand.logo) : null };
  }

  // The website version: the host's browser sends its branding (on every connection, since a fresh room has none).
  // Checked like brand.js checks a save; only a change is broadcast. Nothing set at all is the same as no brand.
  function setBrand(input) {
    const next = { ...cleanBrand(input, NO_BRAND), logo: cleanLogo(input?.logo) };
    const was = JSON.stringify(ownBrand);
    ownBrand = isNoBrand(next) ? null : next;
    if (JSON.stringify(ownBrand) !== was) broadcast();
  }

  const send = (ws, msg) => ws.readyState === 1 && ws.send(JSON.stringify(msg));
  // Phone clocks are measured for fair buzzing, and always in a Quick quiz (faster answers score more).
  const fairOn = (st = state) => Boolean(st.settings.fairBuzz || st.mode === 'quick');

  function connectedTeams() {
    const ids = new Set();
    for (const c of clients) if (c.role === 'phone' && c.teamId) ids.add(c.teamId);
    return [...ids];
  }

  // ----- fair buzzing: measuring each phone's clock -----
  // The server asks "what does your stopwatch say?" and times the answer. Half the round trip after asking is
  // roughly when the phone answered, which gives the gap between the phone's stopwatch and the server's clock.
  // The quickest answer of the last few is the most trustworthy one.

  function ping(c) {
    if (c.ws.readyState !== 1) return;
    const now = Date.now();
    for (const [id, sent] of c.pings) if (now - sent > CLOCK_MAX_RTT_MS) c.pings.delete(id);
    pingId += 1;
    c.pings.set(pingId, now);
    send(c.ws, { type: 'clock', id: pingId });
  }

  function burst(c) {
    for (let k = 0; k < clockBurst; k++) setTimeout(() => clients.has(c) && ping(c), k * 150);
    setTimeout(sendLatency, clockBurst * 150 + 400);
  }

  const phones = () => [...clients].filter((c) => c.role === 'phone');

  function clockSample(c, { id, t }) {
    const sent = c.pings.get(id);
    if (sent === undefined || !Number.isFinite(t)) return;
    c.pings.delete(id);
    const now = Date.now();
    const rtt = now - sent;
    if (rtt > CLOCK_MAX_RTT_MS) return;
    c.samples = [...c.samples.filter((x) => now - x.at < CLOCK_KEEP_MS), { offset: t - (sent + rtt / 2), rtt, at: now }].slice(-8);
  }

  function bestSample(c) {
    const now = Date.now();
    const fresh = c.samples.filter((x) => now - x.at < CLOCK_KEEP_MS);
    return fresh.length ? fresh.reduce((a, b) => (b.rtt < a.rtt ? b : a)) : null;
  }

  // A phone over the internet may be a lot slower than one on the Wi-Fi, so its cap is higher.
  const slackCap = (c) => (c.remote ? MAX_REMOTE_SLACK_MS : MAX_SLACK_MS);

  // A buzz's press time on the server clock, and how much earlier than its arrival it may count
  // (the rules check both). A phone that hasn't been measured counts by arrival. `lead` is half the round trip,
  // roughly how long a message from the server takes to reach the phone (used for Quick quiz answers).
  function pressTime(c, at) {
    const best = bestSample(c);
    if (!Number.isFinite(at) || !best) return {};
    const slack = Math.min(Math.ceil(best.rtt) + 5, slackCap(c));
    return { at: at - best.offset, slack, lead: Math.min(Math.round(best.rtt / 2), slackCap(c) / 2) };
  }

  // Fair buzzing: after the first buzz, how long to wait for the others. A slow phone (one elsewhere) can
  // need longer than the usual short wait for its press to arrive.
  function buzzWait(except) {
    let wait = 0;
    for (const c of phones()) {
      const best = c !== except && c.teamId && bestSample(c);
      if (best) wait = Math.max(wait, Math.min(Math.ceil(best.rtt) + 5, slackCap(c)));
    }
    return wait;
  }

  // Quick quiz: when time runs out, answers from phones elsewhere may still be on their way.
  function answerGrace() {
    let grace = 0;
    for (const c of phones()) {
      const best = c.remote && c.teamId && bestSample(c);
      if (best) grace = Math.max(grace, Math.min(Math.ceil(best.rtt / 2) + 20, slackCap(c) / 2));
    }
    return grace;
  }

  // The host lobby shows each phone's measured delay (round trip, ms) while the setting is on.
  function latency() {
    const out = {};
    for (const c of phones()) {
      const best = c.teamId && bestSample(c);
      if (best) out[c.teamId] = Math.round(best.rtt);
    }
    return out;
  }

  function sendLatency() {
    if (!fairOn()) return;
    for (const c of clients) if (c.role === 'host') send(c.ws, { type: 'latency', latency: latency() });
  }

  function viewFor(c) {
    if (c.role === 'host') return hostView(state);
    if (c.role === 'display') {
      const view = displayView(state);
      // The TV page opened over the internet (or any TV on the website, where anyone with the room code can open
      // one) must not show the PIN: whoever has the address could read it.
      return c.remote || hosted ? { ...view, settings: { ...view.settings, remotePin: '' } } : view;
    }
    return phoneView(state, c.teamId);
  }

  // Players elsewhere: what the screens need to know about the internet tunnel.
  function remoteFor(c) {
    const st = tunnel?.status() ?? { status: 'off', url: null };
    if (c.role === 'host') return { ...st, remoteTeams: phones().filter((p) => p.remote && p.teamId).map((p) => p.teamId) };
    // The TV: how far along it is (so it can say "getting the internet address ready"), and the address once it's on.
    if (c.role === 'display') return { status: st.status, url: st.status === 'on' ? st.url : null };
    return null;
  }

  function broadcast() {
    const connected = connectedTeams();
    // `displays` counts every TV screen in the room (the host plays the sounds when there is none); `tvs` leaves out
    // the one shown inside the host page when there is no separate TV screen (single-screen mode). A TV page opened
    // over the internet (by a player elsewhere) counts in neither.
    const displays = [...clients].filter((c) => c.role === 'display' && !c.remote).length;
    const tvs = [...clients].filter((c) => c.role === 'display' && !c.embedded && !c.remote).length;
    const serverNow = Date.now();
    const resume = resumable && summary(resumable);
    const brandNow = brandView(); // the host's logo, event name and accent colour (the same for everyone)
    const update = updateFor();
    for (const c of clients) {
      if (!c.role) continue;
      const msg = { type: 'state', view: viewFor(c), connected, displays, tvs, serverNow, brand: brandNow };
      if (c.role === 'host' && resume) msg.resume = resume;
      if (c.role === 'host' && fairOn()) msg.latency = latency();
      // A newer ProQuiz is out: only the host laptop hears about it (never the TV, the phones or anyone over the tunnel).
      if (c.role === 'host' && !c.remote && update) msg.update = update;
      if (c.role !== 'phone') msg.remote = remoteFor(c);
      // A phone joining over the internet types the PIN when the host has set one.
      if (c.role === 'phone' && c.remote && state.settings.remotePin && !c.teamId) msg.needPin = true;
      send(c.ws, msg);
    }
  }

  // A newer ProQuiz is out: the release plus whether this program can install it itself and how far that has got.
  function updateFor() {
    const release = updates?.current();
    if (!release) return null;
    return { ...release, canInstall: Boolean(selfUpdate?.available()), install: selfUpdate?.status() ?? null };
  }

  // "Update now" moved on (a percent more downloaded, checking, restarting, failed): only the host pages hear it,
  // as a small message of its own rather than a whole new state for everyone.
  function sendUpdate() {
    const update = updateFor();
    for (const c of clients) if (c.role === 'host' && !c.remote) send(c.ws, { type: 'update', update });
  }

  // The host pressed Update now: only the compiled program, only in the lobby, only a known newer release, one at
  // a time. The download, check, swap and restart are lib/selfupdate.js's; `beforeRestart` there saves and closes.
  function updateNow() {
    if (!selfUpdate?.available()) throw new GameError('update-not-here');
    if (state.phase !== 'lobby') throw new GameError('update-in-game');
    const release = updates?.current();
    if (!release) throw new GameError('update-none');
    if (['downloading', 'checking', 'restarting'].includes(selfUpdate.status().stage)) throw new GameError('update-busy');
    selfUpdate.run(release, { port: info.port }).catch(() => {});
  }

  // Before the program restarts for an update: the game that is waiting to be continued (kept only in memory after
  // Main menu) or the lobby as it is goes to the autosave, so the new program offers or shows the same.
  function saveForExit() {
    save(resumable ? resumable.state : state);
  }

  // The host pressed Quit ProQuiz (only ever from a host connection, so only from this laptop, never over the
  // tunnel): save the game to be continued next time, tell every screen goodbye (so they stop trying to connect
  // again), and let startServer() close the listeners, stop the tunnel and end the program.
  let quitting = false;
  function quit() {
    if (quitting) return;
    quitting = true;
    saveForExit();
    for (const c of clients) send(c.ws, { type: 'bye' });
    onQuit();
  }

  // Something that isn't part of the game (a sound, a player's reaction): goes to the TV screens (the one inside
  // the host page too), or to the host laptop if no TV is open in the room. TV pages opened elsewhere always get it.
  function toRoom(msg) {
    const tvs = [...clients].filter((c) => c.role === 'display' && !c.remote);
    const targets = tvs.length ? tvs : [...clients].filter((c) => c.role === 'host');
    targets.push(...[...clients].filter((c) => c.role === 'display' && c.remote));
    for (const c of targets) send(c.ws, msg);
  }
  const soundToRoom = (sound) => toRoom({ type: 'sound', ...sound });

  // Players elsewhere: wrong PINs, at most PIN_TRIES_PER_MINUTE a minute for everyone together.
  function checkPin(c, pin) {
    const want = state.settings.remotePin;
    if (!c.remote || !want || c.teamId) return;
    const now = Date.now();
    pinMisses = pinMisses.filter((at) => now - at < 60_000);
    if (pinMisses.length >= PIN_TRIES_PER_MINUTE) throw new GameError('pin-wait');
    if (String(pin ?? '').trim() !== want) {
      pinMisses.push(now);
      throw new GameError('bad-pin');
    }
  }

  // The host picks which quiz to play (lobby only). Quizzes with problems can't be played.
  async function chooseSet(c, id) {
    const found = await store.get(String(id));
    if (!found) return send(c.ws, { type: 'error', code: 'set-missing' });
    if (validateSet(found.set).length) return send(c.ws, { type: 'error', code: 'set-has-problems' });
    dispatch({ type: 'loadSet', set: found.set, setId: String(id) });
  }

  // The website version: the host's browser sends the quiz itself (`cmd {type: 'loadSet', set, setId}`), since there
  // is no store on the server. Quizzes with problems can't be played, and a huge one is refused rather than broadcast.
  function checkLoadSet(action) {
    if (validateSet(action.set).length) throw new GameError('set-has-problems');
    if (JSON.stringify(action.set).length > MAX_SET_BYTES) throw new GameError('set-too-big');
  }

  // The website version: the autosave comes back from the host's browser (`restore {saved}`) when the room is new.
  // Only in an empty lobby, and shaped exactly like a save read when ProQuiz starts. A finished game (phase `over`)
  // brings back its quiz and settings but isn't offered to continue; a quiz bigger than `loadSet` allows is refused.
  function restore(data) {
    if (state.phase !== 'lobby' || state.teams.length) throw new GameError('restore-in-game');
    if (!looksLikeSave(data)) throw new GameError('bad-save');
    if (JSON.stringify(data.state.set).length > MAX_SET_BYTES) throw new GameError('set-too-big');
    ({ state, resumable } = fromSave(data));
    if (data.state.phase === 'over') resumable = null;
    schedule();
    broadcast();
  }

  // The website version: a host hello carries the key the room was made with (docs/dev/web-plan.md §1.4). `hostKey`
  // is the key itself, or a function that says whether a key is the room's (the room only learns its key from the
  // first host, and limits wrong keys per room: web/room.js).
  const checkHostKey = (key) => typeof key === 'string' && (typeof hostKey === 'function' ? hostKey(key) === true : key === hostKey);

  // When the quiz on show in the lobby is edited, the lobby gets the new version.
  function setSaved(id, set, problems) {
    if (state.phase === 'lobby' && state.setId === id && problems.length === 0) dispatch({ type: 'loadSet', set, setId: id });
    broadcast(); // the host's list of quizzes may have changed
  }

  // Back to the main menu in the middle of a game, just as if ProQuiz had been closed and started again:
  // the game is kept as the one to continue, and the lobby starts empty with the same quiz and settings.
  function mainMenu() {
    if (state.phase === 'lobby') return;
    resumable = { v: 1, savedAt: Date.now(), state: { ...state, history: [] } };
    state = newGame(state.set, state.settings, state.setId);
    for (const c of clients) {
      if (c.role !== 'phone') continue;
      c.askedTeamId = c.teamId ?? c.askedTeamId; // so "Continue" puts the phone back in its team
      c.teamId = null;
      send(c.ws, { type: 'welcome', teamId: null });
    }
    schedule();
    broadcast(); // not saved: the file keeps the game until something new happens in the lobby
  }

  // Continue the saved game. Phones that are already back get their team again.
  function resume() {
    if (!resumable) return;
    const lobbyTeams = state.teams;
    const { joinMode, remotePin } = state.settings; // how players join is chosen in the lobby, not saved with the game
    state = { round: 1, ...resumable.state, deadline: null }; // games saved before round 2 existed are in round 1
    state.settings = { ...DEFAULT_SETTINGS, ...louderSettings(state.settings), joinMode, remotePin }; // defaults: a game saved before a setting existed
    state.teams = state.teams.map((t) => ({ ...t, color: newColor(t.color) })); // saved with the colours before 1.7
    // Teams that joined in the lobby meanwhile play on with zero points (a free colour if theirs is taken;
    // in a Quick quiz colours may repeat).
    const quick = state.mode === 'quick';
    for (const t of lobbyTeams) {
      if (state.teams.length >= (quick ? MAX_PLAYERS : MAX_TEAMS)) break;
      if (state.teams.some((o) => o.id === t.id || o.name.toLowerCase() === t.name.toLowerCase())) continue;
      const taken = !quick && state.teams.some((o) => o.color === t.color);
      const color = taken ? COLORS.find((col) => !state.teams.some((o) => o.color === col)) : t.color;
      state.teams = [...state.teams, { ...t, color, score: 0 }];
      if (state.final) state.final = { ...state.final, base: { ...state.final.base, [t.id]: 0 } };
    }
    const playing = new Set(state.teams.map((t) => t.id));
    for (const c of clients) if (c.role === 'phone' && c.teamId && !playing.has(c.teamId)) c.teamId = null;
    // A picture that was appearing carries on from where it was, not from the old clock.
    if (state.q?.unveil?.since != null) state.q = { ...state.q, unveil: { ...state.q.unveil, since: Date.now() } };
    state = resumeFix(state, Date.now()); // Quick quiz: a question that was showing starts again
    resumable = null;
    for (const c of clients) {
      if (c.role === 'phone' && c.askedTeamId && state.teams.some((t) => t.id === c.askedTeamId)) {
        c.teamId = c.askedTeamId;
        send(c.ws, { type: 'welcome', teamId: c.teamId });
      }
    }
    schedule();
    save(state);
    broadcast();
  }

  // How players join (setting `joinMode`): the internet tunnel runs while it says 'internet'. Choosing it starts
  // the tunnel and choosing Wi-Fi stops it. A saved 'internet' never starts a tunnel by itself when ProQuiz starts:
  // only when the host page opens the lobby (`hostHello`), and not again after it failed (the host retries).
  function syncTunnel({ hostHello = false } = {}) {
    if (!tunnel) return;
    const st = tunnel.status().status;
    if (state.settings.joinMode !== 'internet') {
      if (st !== 'off') tunnel.stop().catch(() => {});
    } else if (!hostHello || (st === 'off' && state.phase === 'lobby')) {
      tunnel.start().catch(() => {});
    }
  }

  // "A new version is out": asked when a host page connects (not when ProQuiz starts), and lib/update.js makes sure
  // it is at most once every 6 hours. Off with the setting `updateCheck`. A new answer reaches the host at once.
  function checkUpdate() {
    if (!updates || !state.settings.updateCheck) return;
    const before = updates.current();
    updates
      .check()
      .then((found) => found !== before && broadcast())
      .catch(() => {});
  }

  // Runs one action through the rules; everyone gets the new state if something changed.
  function dispatch(action) {
    const before = state;
    state = apply(state, { ...action, now: Date.now() });
    if (state.settings.joinMode !== before.settings.joinMode) syncTunnel();
    // Fair buzzing was just turned on (or a Quick quiz chosen): measure every phone now rather than in a few seconds.
    if (fairOn() && !fairOn(before)) phones().forEach(burst);
    schedule();
    if (state !== before) {
      save(state);
      broadcast();
    }
  }

  // One timer for whatever deadline the game has right now.
  function schedule() {
    clearTimeout(timer);
    timer = null;
    let at = nextTimerAt(state); // the end of a fair-buzz wait, or the running timer
    if (at != null && state.mode === 'quick' && state.phase === 'open') at += answerGrace();
    if (at != null) {
      timer = setTimeout(() => dispatch({ type: 'timeout' }), Math.max(0, at - Date.now()) + 5);
    }
  }

  function handle(c, msg) {
    if (msg.type === 'hello') {
      // Over the internet nobody is the host (the host screen shows the answers). On the website the host is
      // whoever has the room's key.
      if (msg.role === 'host' && !c.local) {
        if (!hostKey) return send(c.ws, { type: 'error', code: 'host-only-on-laptop' });
        if (!checkHostKey(msg.key)) return send(c.ws, { type: 'error', code: 'bad-host-key' });
      }
      if (!['host', 'display', 'phone'].includes(msg.role)) return;
      c.role = msg.role;
      c.embedded = c.role === 'display' && msg.embedded === true;
      if (c.role === 'phone' && hosted) c.remote = true; // the website: every phone is "elsewhere" (PIN, slack caps, answer grace)
      if (c.role === 'phone') {
        c.askedTeamId = typeof msg.teamId === 'string' ? msg.teamId : null;
        const known = state.teams.some((t) => t.id === msg.teamId);
        c.teamId = known ? msg.teamId : null;
        send(c.ws, { type: 'welcome', teamId: c.teamId });
        c.samples = []; // a new connection, maybe a reloaded page: measure the clock again
        if (fairOn()) burst(c);
      } else {
        send(c.ws, { type: 'welcome', info: c.role === 'host' ? { ...info, ...hostInfo } : info });
        if (c.role === 'host') {
          syncTunnel({ hostHello: true });
          checkUpdate();
        }
      }
      return broadcast();
    }
    if (c.role === 'phone' && msg.type === 'join') {
      checkPin(c, msg.pin);
      // Keep the phone's saved id if it has one, so it stays the same team after a server restart.
      const saved = typeof msg.teamId === 'string' && /^[\w-]{8,40}$/.test(msg.teamId) ? msg.teamId : null;
      const teamId = c.teamId || saved || globalThis.crypto.randomUUID();
      const previous = c.teamId;
      c.teamId = teamId; // before dispatch, so the new team is never shown as offline
      try {
        dispatch({ type: 'join', teamId, name: msg.name, color: msg.color, avatar: msg.avatar, lang: msg.lang });
      } catch (err) {
        c.teamId = previous;
        throw err;
      }
      send(c.ws, { type: 'joined', teamId });
    }
    // In the lobby a buzz just plays that team's tone, so everyone can hear what theirs sounds like.
    if (c.role === 'phone' && msg.type === 'buzz' && c.teamId && state.phase === 'lobby') {
      return soundToRoom({ name: 'buzz', teamId: c.teamId });
    }
    if (c.role === 'host' && msg.type === 'testSound') return soundToRoom({ name: 'fanfare' });
    if (c.role === 'host' && msg.type === 'chooseSet' && store) return chooseSet(c, msg.id);
    if (c.role === 'phone' && msg.type === 'clock') return clockSample(c, msg);
    if (c.role === 'phone' && msg.type === 'resync') {
      c.samples = [];
      if (fairOn()) burst(c);
      return;
    }
    if (c.role === 'phone' && msg.type === 'buzz' && c.teamId) {
      // Only the server's own measurement decides how early a press may count, never the phone.
      const { at, slack } = pressTime(c, msg.at);
      return dispatch({ type: 'buzz', teamId: c.teamId, at, slack, wait: buzzWait(c) });
    }
    // Quick quiz: a player's emoji reaction after a question (`emoji` is an index into REACTIONS). Not a game
    // action: the rules (reactionFor) say whether it is allowed right now, and it only goes to the TV.
    if (c.role === 'phone' && msg.type === 'react') {
      const now = Date.now();
      if (!c.teamId || now - (c.reactedAt ?? 0) < REACT_EVERY_MS) return;
      const reaction = reactionFor(state, c.teamId, msg.emoji);
      if (!reaction) return;
      c.reactedAt = now;
      return toRoom({ type: 'reaction', ...reaction });
    }
    if (c.role === 'phone' && msg.type === 'answer' && c.teamId) {
      // Quick quiz: the press time counts like a buzz's (faster answers score more).
      // `option`, `options` or `order` by the question's kind; the rules check the shape.
      return dispatch({ type: 'answer', teamId: c.teamId, option: msg.option, options: msg.options, order: msg.order, ...pressTime(c, msg.at) });
    }
    if (c.role === 'phone' && PHONE_ACTIONS.has(msg.type) && c.teamId) {
      return dispatch({ ...msg, teamId: c.teamId });
    }
    // Players join over the internet (on) or on this Wi-Fi (off). The same as choosing it in the settings, and
    // `on` while it already says internet tries again (after a failure).
    if (c.role === 'host' && msg.type === 'tunnel' && tunnel) {
      const joinMode = msg.on ? 'internet' : 'wifi';
      if (state.settings.joinMode !== joinMode) return dispatch({ type: 'settings', settings: { joinMode } });
      return msg.on ? tunnel.start() : tunnel.stop();
    }
    if (c.role === 'host' && msg.type === 'tunnelDownload' && tunnel) return tunnel.download();
    if (c.role === 'host' && msg.type === 'updateNow') return updateNow();
    if (c.role === 'host' && msg.type === 'resume') return resume();
    if (c.role === 'host' && msg.type === 'mainMenu') return mainMenu();
    if (c.role === 'host' && msg.type === 'quit' && !hosted) return quit(); // the website has no program to quit
    if (c.role === 'host' && msg.type === 'restore') return restore(msg.saved);
    if (c.role === 'host' && msg.type === 'brand' && hosted && !brand) return setBrand(msg); // the website: the host's branding from its browser
    if (c.role === 'host' && msg.type === 'discardSave') {
      resumable = null;
      return broadcast();
    }
    if (c.role === 'host' && msg.type === 'cmd' && HOST_ACTIONS.has(msg.action?.type)) {
      const action = { ...msg.action };
      if (action.type === 'loadSet') checkLoadSet(action);
      if (action.type === 'start') {
        resumable = null; // a new game replaces the one waiting to be continued
        if (!action.picker && state.teams.length) action.picker = state.teams[Math.floor(Math.random() * state.teams.length)].id;
        action.seed = Math.floor(Math.random() * 2 ** 32); // Kaosmodus: where the specials go
        delete action.specials; // only tests place specials by hand
      }
      // Fair buzzing: a fresh measurement of every phone just as the buzzers open.
      if (action.type === 'arm' && state.settings.fairBuzz) phones().forEach(ping);
      // Quick quiz: the same just before a question's answers can appear.
      if (action.type === 'next' && state.mode === 'quick' && ['section', 'ready', 'ranks'].includes(state.phase)) phones().forEach(ping);
      return dispatch(action);
    }
  }

  // `remote`: the connection came through the internet tunnel's own listener (never the host, whatever its address).
  // `local`: from the laptop's own pages (the only place a host may connect from without a key); when not given,
  // server.js's `fromLaptop(req)` decides. The website passes both as false and never a request.
  function connect(ws, req, { remote = false, local } = {}) {
    const c = { ws, role: null, local: local ?? (!remote && fromLaptop(req)), remote, teamId: null, alive: true, pings: new Map(), samples: [] };
    clients.add(c);
    ws.on('pong', () => (c.alive = true));
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }
      try {
        handle(c, msg);
      } catch (err) {
        if (!(err instanceof GameError)) throw err;
        send(ws, { type: 'error', code: err.code });
      }
    });
    ws.on('close', () => {
      clients.delete(c);
      if (c.role === 'phone' || c.role === 'display') broadcast();
    });
  }

  // Phones that vanish without closing (Wi-Fi drop, battery) are noticed within two heartbeats (~20 s on the laptop).
  const heartbeat = setInterval(() => {
    for (const c of clients) {
      if (!c.alive) c.ws.terminate();
      else {
        c.alive = false;
        c.ws.ping();
      }
    }
  }, heartbeatMs);

  // Fair buzzing: keep every phone's clock measurement fresh.
  const clockTimer = setInterval(() => {
    if (!fairOn()) return;
    phones().forEach(ping);
    sendLatency(); // for the host's lobby
  }, clockEveryMs);

  return {
    connect,
    setSaved,
    broadcast, // the internet tunnel's status changed
    sendUpdate, // "Update now" moved on
    saveForExit,
    dispatch, // for tests (e.g. placing Kaosmodus specials by hand)
    getState: () => state,
    stop() {
      clearTimeout(timer);
      clearInterval(heartbeat);
      clearInterval(clockTimer);
    },
  };
}
