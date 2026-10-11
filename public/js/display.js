// The TV screen. Shows the game to the room; never gets an answer before the host reveals it.
import { ranking, COLORS, unveilProgress, SHAPES, OPTION_COLORS } from '/lib/game.js';
import { connect } from './net.js';
import { t, pts, setLang, translatePage, fastestTitle, secondsText, licenseName } from './i18n.js';
import { $, h, fill, qrSvg, shortUrl, urlNodes, countdown, runCountdowns, teamStyle, setGlass, shapeSvg, optionStyle, timerTotal, setBrand, brandLogo } from './ui.js';
import { unlockAudio, audioReady, playEvent, playSound, startTicks, sounds } from './sounds.js';
import { animateRanks, cancelRanks, countTo, shownCount, setTickSound, reducedMotion } from './rankanim.js';
import { syncClip, preloadClips } from './clip.js';
import { syncMusic } from './music.js';
import { ICONS, ruleFor, badgeFor } from './specials.js';
import { avatarEl } from './avatar.js';

let view = null;
let connected = new Set();
let info = null;
let remote = { status: 'off', url: null }; // joining over the internet: how far along it is, and the address once it's on
let brand = null; // the host's logo, event name and accent colour (brand.js)
let lastSeq = 0; // the last event we reacted to
let soundSeq = null; // the last event we played a sound for (null until the first state arrives)
let lastScreen = ''; // so the question only zooms in once, not on every update
const seen = new Set(); // teams already on screen, so only new ones pop in

// Inside the host page (single-screen mode, no separate TV): the tiles can be clicked and keys go to the host controls.
const embedded = new URLSearchParams(location.search).has('embedded');
if (embedded) document.body.classList.add('embedded');
const toHost = (msg) => window.parent.postMessage({ proquiz: true, ...msg }, location.origin);

const net = connect({
  role: 'display',
  extra: { embedded },
  onMessage(msg) {
    if (msg.type === 'welcome') info = msg.info;
    if (msg.type === 'sound') playSound(view, msg, COLORS);
    if (msg.type === 'reaction') showReaction(msg);
    if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
      remote = msg.remote ?? remote;
      brand = msg.brand ?? null;
      const ev = view.event;
      if (ev && soundSeq !== null && ev.seq !== soundSeq) playEvent(view, ev, COLORS);
      soundSeq = ev?.seq ?? 0;
    }
    // Inside the host page, the host's own clicks allow sound, so switch it on without a click here.
    if (embedded && !audioReady()) unlockAudio();
    if (view) render();
  },
});
runCountdowns(net.now);
startTicks(() => view, net.now);
setTickSound((p) => view?.settings.sound && sounds.countTick(p)); // points counting up

// The TV plays the sounds. Browsers need one click or key press first.
function showUnlock() {
  $('#sound-unlock').hidden = !(view?.settings.sound || view?.settings.music) || audioReady();
}
// The background music follows every update, and checks a few times a second for "time's nearly up".
setInterval(() => view && syncMusic(view, net.now()), 250);
// iPad Safari only counts the end of a tap (touchend or click) as permission, so listen for those too.
for (const type of ['pointerdown', 'touchend', 'click', 'keydown']) {
  document.addEventListener(type, () => {
    unlockAudio();
    setTimeout(() => {
      showUnlock();
      if (view) syncMusic(view, net.now());
    }, 100);
  });
}

// F for full screen (the TV window has no controls).
document.addEventListener('keydown', (e) => {
  if (embedded) {
    if (e.target.closest?.('input, select, textarea')) return;
    if (e.key === ' ') e.preventDefault();
    return toHost({ type: 'key', key: e.key, repeat: e.repeat, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
  }
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});

const teamById = (id) => view.teams.find((tm) => tm.id === id);
// A team's avatar (its mascot, or a Quick quiz player's face), or nothing for a team without one.
const face = (team, cls) => avatarEl(team?.avatar, cls);

// ----- players' reactions (Quick quiz) -----

// A `reaction` message from the server: "🔥 Alex" floats up from the bottom edge at a random spot and fades out
// (style.css; with "reduce motion" it only fades). At most MAX_REACTIONS on screen, the oldest goes first, so a
// hundred players can't flood the TV. Nothing about it is in the game state.
const MAX_REACTIONS = 12;
function showReaction(r) {
  const box = $('#reactions');
  while (box.children.length >= MAX_REACTIONS) box.firstChild.remove();
  const el = h(
    'div',
    { class: 'reaction', style: `${teamStyle(r)}; left: ${8 + Math.random() * 84}%; --drift: ${((Math.random() - 0.5) * 10).toFixed(1)}vw` },
    h('span', { class: 'reaction-emoji' }, r.emoji),
    h('span', { class: 'plate reaction-name' }, face(r), h('span', {}, r.name)),
  );
  el.addEventListener('animationend', () => el.remove());
  setTimeout(() => el.remove(), 4000); // in case the browser never plays the animation
  box.append(el);
}

// ----- lobby -----

const LOBBY_PLATES = 48; // name plates on the TV lobby at most (then the newest, plus "+ n more")

function renderLobby() {
  // The host's logo (big) and event name above "Scan to join".
  const box = $('#tv-brand');
  const brandKey = JSON.stringify(brand);
  if (box.dataset.key !== brandKey) {
    box.dataset.key = brandKey;
    box.replaceChildren(...[brandLogo(brand, 'brand-logo big'), brand?.name ? h('p', { class: 'brand-name' }, brand.name) : null].filter(Boolean));
    box.hidden = !box.children.length;
  }
  // One QR code: this Wi-Fi's address, or the internet address when players join over the internet. Until that
  // is ready, the Wi-Fi code stands in (labelled so), with a line saying what is happening.
  const internet = view.settings.joinMode === 'internet';
  const ready = internet && remote.status === 'on' && Boolean(remote.url);
  const waiting = internet && !ready;
  const url = ready ? remote.url : info?.phoneUrl;
  if (url) {
    if ($('#qr').dataset.url !== url) {
      $('#qr').replaceChildren(qrSvg(url));
      $('#qr').dataset.url = url;
    }
    $('#url').replaceChildren(...urlNodes(url));
  } else {
    $('#url').textContent = t('noNetwork');
  }
  $('#url').classList.toggle('long', Boolean(ready));
  $('#qrs').classList.toggle('waiting', waiting);
  $('#qr-label').hidden = !internet;
  $('#qr-label').textContent = ready ? t('fromAnywhere') : waiting ? t('wifiForNow') : '';
  $('#tv-wait').hidden = !waiting;
  $('#tv-wait').textContent = !waiting ? '' : ['starting', 'downloading'].includes(remote.status) ? t('tvWaitStarting') : t('tvWaitDown');
  $('#tv-wait').classList.toggle('bad', waiting && !['starting', 'downloading'].includes(remote.status));
  // The PIN (a TV page opened over the internet never gets it).
  const pin = ready && view.settings.remotePin;
  $('#remote-pin').hidden = !pin;
  $('#remote-pin').textContent = pin ? t('pinOnTv', { pin }) : '';
  // The newest player first, so whoever just joined sees their name at once. Over LOBBY_PLATES players the
  // newest ones show and the rest are counted ("+ 24 more"), so a lobby of 100 still fits on the TV.
  const newest = [...view.teams].reverse();
  const shown = newest.length > LOBBY_PLATES ? newest.slice(0, LOBBY_PLATES - 1) : newest;
  $('#lobby').classList.toggle('crowd', view.teams.length > 12);
  $('#lobby').classList.toggle('packed', view.teams.length > 20);
  $('#lobby').classList.toggle('horde', view.teams.length > 40);
  fill(
    $('#teams'),
    ...shown.map((team) => {
      const isNew = !seen.has(team.id);
      seen.add(team.id);
      return h('li', { class: `plate${isNew ? ' new' : ''}${connected.has(team.id) ? '' : ' away'}${team.avatar ? ' has-face' : ''}`, style: teamStyle(team) }, face(team), h('span', {}, team.name));
    }),
    newest.length > shown.length ? h('li', { class: 'more' }, t('lobbyMore', { n: newest.length - shown.length })) : null,
  );
}

// ----- game -----

function renderBoard() {
  const rows = Math.max(...view.set.categories.map((c) => c.questions.length));
  return [
    h(
      'div',
      { class: 'tv-board', style: `--rows: ${rows}` },
      view.set.categories.map((cat, c) =>
        h(
          'div',
          { class: 'col' },
          h('div', { class: 'cat' }, cat.name),
          cat.questions.map((q, i) =>
            embedded && !view.used[c][i]
              ? h('button', { class: 'tile', type: 'button', onclick: () => toHost({ type: 'pick', c, i }) }, pts(q.value))
              : h('div', { class: `tile${view.used[c][i] ? ' used' : ''}` }, pts(q.value)),
          ),
        ),
      ),
    ),
    view.picker
      ? h('p', { class: 'tv-picks' }, view.round === 2 ? h('span', { class: 'round-tag' }, t('round2Title')) : null, h('b', {}, t(view.settings.phonePick && connected.has(view.picker) ? 'picksOnPhone' : 'picks', { name: teamById(view.picker)?.name ?? '' })))
      : null,
  ];
}

function band() {
  const q = view.q;
  const p = view.phase;
  if (p === 'reading' && q.solo) {
    const team = teamById(q.solo);
    return [h('span', { class: 'plate buzzed-name', style: teamStyle(team) }, face(team), h('span', {}, t('standBack', { name: team.name })))];
  }
  if (p === 'reading') return [h('span', { class: 'muted' }, t('getReady'))];
  if (p === 'armed') {
    const wrong = view.event?.reopened ? teamById(view.event.teamId) : null;
    return [h('span', {}, wrong ? t('wrongReopen', { name: wrong.name }) : t('buzzNow')), countdown(view)];
  }
  if (p === 'answering') {
    const team = teamById(q.buzzedTeam);
    return [h('span', { class: 'plate buzzed-name', style: teamStyle(team) }, face(team), h('span', {}, team.name)), countdown(view)];
  }
  if (p === 'revealed') {
    const r = q.result;
    if (r.type === 'correct') {
      const won = q.won ? ` +${pts(q.won)} ${ICONS.jackpot}` : '';
      return [h('span', { class: 'plate buzzed-name', style: teamStyle(teamById(r.teamId)) }, face(teamById(r.teamId)), h('span', {}, `${teamById(r.teamId)?.name} +${pts(q.value)}${won}`))];
    }
    // Daily Double lost: the whole bet goes.
    if (q.fullPenalty && q.lockedOut.includes(q.solo)) return [h('span', { class: 'plate buzzed-name', style: teamStyle(teamById(q.solo)) }, face(teamById(q.solo)), h('span', {}, `${teamById(q.solo)?.name} −${pts(q.value)}`))];
    return [h('span', { class: 'muted' }, r.type === 'timeout' ? t('resultTimeout') : t('resultNobody'))];
  }
  return [];
}

const img = (name, cls) => (name ? h('img', { class: cls, src: `/files/${encodeURIComponent(name)}`, alt: '' }) : null);
// Who made a picture found with "Find a free picture": the view only has it once the answer is out, and only
// while the lobby setting `showCredits` is on.
const creditLine = (c) =>
  c
    ? h(
        'p',
        { class: 'pic-credit' },
        c.author
          ? t('picCreditLine', { author: c.author, license: licenseName(c.license), source: t(c.source === 'wikimedia' ? 'picSourceWikimedia' : 'picSourceOpenverse') })
          : t('picCreditNoAuthor', { license: licenseName(c.license), source: t(c.source === 'wikimedia' ? 'picSourceWikimedia' : 'picSourceOpenverse') }),
      )
    : null;

// Load every question picture while the board is showing, so a picture never pops in late.
const images = new Map(); // file → Image, kept for drawing slowly appearing pictures
function imageFor(file) {
  if (!images.has(file)) {
    const im = new Image();
    im.src = `/files/${encodeURIComponent(file)}`;
    images.set(file, im);
  }
  return images.get(file);
}
function preloadImages() {
  if (view.mode === 'quick') {
    // A Quick quiz only tells the TV the current section's files.
    for (const f of view.set.preload) if (f.image) imageFor(f.image);
    preloadClips(view.set.preload.filter((f) => f.audio).map((f) => f.audio));
    return;
  }
  for (const cat of view.set.categories) for (const q of cat.questions) if (q.image) imageFor(q.image);
  preloadClips(view.set.categories.flatMap((cat) => cat.questions.filter((q) => q.audio).map((q) => q.audio)));
}

// Moving bars while a sound clip plays: "listen!"
function clipViz() {
  if (!view.clip) return null;
  return h('div', { class: `clip-viz${view.media?.playing ? ' on' : ''}`, 'aria-hidden': 'true' }, [1, 2, 3, 4, 5, 6, 7].map(() => h('span')));
}

// ----- Kaosmodus -----

// The reel of icons the reveal spins through, fixed per tile so re-drawing doesn't reshuffle it.
const reels = new Map();
function reelFor(key, kind) {
  if (!reels.has(key)) {
    const kinds = Object.keys(ICONS);
    const reel = [];
    for (let n = 0; n < 14; n++) reel.push(kinds[Math.floor(Math.random() * kinds.length)]);
    reel.push(kind);
    reels.set(key, reel);
  }
  return reels.get(key);
}

function renderSpecialTv() {
  const q = view.q;
  const key = `s${q.c}-${q.i}`;
  const fresh = lastScreen !== key;
  lastScreen = key;
  const reel = reelFor(key, q.special);
  const picker = teamById(view.picker);
  return h(
    'div',
    { class: `tv-special k-${q.special}${fresh ? ' spin' : ''}` },
    h('div', { class: 'reel' }, h('div', { class: 'reel-strip', style: `--n: ${reel.length}` }, reel.map((k) => h('span', {}, ICONS[k])))),
    h('div', { class: 'special-text' }, h('h1', {}, t(`k-${q.special}`)), h('p', {}, ruleFor(view)), picker ? h('span', { class: 'plate special-team', style: teamStyle(picker) }, face(picker), h('span', {}, picker.name)) : null),
  );
}

function renderBoom() {
  const q = view.q;
  const team = teamById(q.result.teamId);
  const fresh = lastScreen !== `boom${q.c}-${q.i}`;
  lastScreen = `boom${q.c}-${q.i}`;
  return h(
    'div',
    { class: `tv-boom${fresh ? ' bang' : ''}` },
    h('span', { class: 'boom-icon' }, '💥'),
    h('h1', {}, 'BOOM!'),
    team ? h('span', { class: 'plate buzzed-name', style: teamStyle(team) }, face(team), h('span', {}, `${team.name} −${pts(q.result.amount)}`)) : null,
  );
}

// ----- slowly appearing pictures: big blocks that get smaller -----

// Blocks across the picture at each step; after the last step the picture is clear.
const STEPS = [6, 8, 11, 16, 22, 32, 45, 64, 90, 128];
const stepAt = (u, now) => Math.min(STEPS.length, Math.floor(unveilProgress(u, now) * (STEPS.length + 1)));

function unveilCanvas(q) {
  const u = q.unveil;
  const key = `${q.c}-${q.i}`;
  // Keep the canvas that's already on screen (with its drawing), so updates never flash an empty picture.
  const canvas = document.querySelector(`canvas.unveil[data-q="${key}"]`) ?? h('canvas', { class: 'q-img unveil', 'data-q': key, 'data-file': q.image });
  Object.assign(canvas.dataset, { ms: u.ms, done: u.done, since: u.since ?? '' });
  return canvas;
}

function drawStep(canvas, img, step) {
  const aspect = img.naturalWidth && img.naturalHeight ? img.naturalWidth / img.naturalHeight : 1.5;
  const W = 1280;
  const H = Math.round(W / aspect);
  if (canvas.width !== W || canvas.height !== H) Object.assign(canvas, { width: W, height: H });
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, W, H);
  if (step >= STEPS.length) {
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(img, 0, 0, W, H);
    return;
  }
  // Draw the picture tiny (each pixel becomes the average colour of a block), then blow it up without smoothing.
  const sw = STEPS[step];
  const sh = Math.max(1, Math.round(sw / aspect));
  const small = (drawStep.small ??= document.createElement('canvas'));
  Object.assign(small, { width: sw, height: sh });
  const sctx = small.getContext('2d');
  sctx.imageSmoothingEnabled = true;
  sctx.drawImage(img, 0, 0, sw, sh);
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(small, 0, 0, sw, sh, 0, 0, W, H);
}

// Redraws a slowly appearing picture whenever it reaches its next step (on the server clock).
function runUnveil() {
  const tick = () => {
    for (const canvas of document.querySelectorAll('canvas.unveil')) {
      const u = { ms: Number(canvas.dataset.ms), done: Number(canvas.dataset.done), since: canvas.dataset.since === '' ? null : Number(canvas.dataset.since) };
      const step = stepAt(u, net.now());
      const img = imageFor(canvas.dataset.file);
      if (String(step) === canvas.dataset.step || !img.complete) continue;
      drawStep(canvas, img, step);
      canvas.dataset.step = String(step);
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}
runUnveil();

function renderQuestion() {
  const q = view.q;
  if (q.result?.type === 'boom') return renderBoom();
  const zoom = lastScreen !== `q${q.c}-${q.i}`;
  lastScreen = `q${q.c}-${q.i}`;
  // When the answer comes with its own picture, it takes the question picture's place.
  const picture = q.answerImage || q.image;
  // The clear picture is only put on screen once the answer is revealed.
  const blocks = q.unveil && q.image && !q.answerImage && view.phase !== 'revealed';
  return h(
    'div',
    { class: `tv-q${picture ? ' has-image' : ''}`, style: zoom ? '' : 'animation: none' },
    h('div', { class: 'where' }, h('span', {}, view.set.categories[q.c].name), q.special ? h('span', { class: `special-badge k-${q.special}` }, badgeFor(view)) : null, h('b', {}, pts(q.value))),
    blocks ? unveilCanvas(q) : img(picture, `q-img${q.answerImage ? ' reveal-img' : ''}`),
    picture ? creditLine(q.credit) : null,
    picture ? null : clipViz(),
    q.question ? h('p', { class: 'question' }, q.question) : h('div', { class: 'spacer' }),
    picture ? clipViz() : null,
    q.answer ? h('p', { class: 'answer' }, q.answer) : null,
    h('div', { class: 'band' }, band()),
  );
}

// ----- Quick quiz (multiple choice) -----
// section (title card + standings) → ready (the question) → open (the answers, the clock) → result (who picked
// what) → ranks (top 5) … → over (the podium). The answer tiles sit where the phones' buttons are.

const optStyle = (i) => optionStyle(OPTION_COLORS[i]);
const sectionNow = () => view.set.sections[view.pos?.s] ?? { name: '', n: 0 };

function pointsBadge(q) {
  if (q.points === 2000) return h('span', { class: 'pts-badge double' }, `×2 ${t('quickDouble')}`);
  if (q.points === 0) return h('span', { class: 'pts-badge' }, t('quickSurvey'));
  return null;
}

function quickWhere(q) {
  const sec = sectionNow();
  return h('div', { class: 'where' }, h('span', {}, h('span', { class: 'where-sec' }, sec.name), t('quickQuestionOf', { n: view.pos.i + 1, total: sec.n })), pointsBadge(q));
}

// The big round clock: a ring that empties, with the seconds left in the middle.
function timerRing() {
  if (view.deadline == null) return h('div', { class: 'q-timer off' });
  return h('div', { class: 'q-timer', 'data-deadline': view.deadline, 'data-total': timerTotal(view), role: 'timer' }, h('span', { 'data-deadline': view.deadline, 'data-seconds': '' }));
}

function answeredCount(q) {
  return h('div', { class: 'q-count' }, h('b', {}, String(q.answered)), h('span', {}, t('quickAnsweredOf', { total: q.total })));
}

// The right options (a list, from the result on; several when any of them counts), or for a "put in order"
// question the right order (the shown positions, first first), or null before.
const rightOf = (q) => (q.correct == null ? null : [].concat(q.correct));

// "Tick all that are right" / "Put in the right order" under the question, so everyone knows what to do.
// Never how many are right.
function styleLine(q) {
  if (q.type !== 'multi' && q.type !== 'order') return null;
  return h('p', { class: `quick-style ${q.type}` }, h('span', { class: 'style-icon', 'aria-hidden': 'true' }, q.type === 'order' ? '1 2 3' : '✓✓'), t(q.type === 'order' ? 'quickStyleOrder' : 'quickStyleMulti'));
}

function optionTiles(q) {
  const rights = rightOf(q);
  const settled = rights !== null;
  const order = q.type === 'order';
  return h(
    'div',
    { class: `quick-opts n${q.n}` },
    q.options.map((text, i) =>
      h(
        'div',
        { class: `quick-opt${settled ? (order ? ' placed' : rights.includes(i) ? ' right' : ' wrong') : ''}`, style: `${optStyle(i)}; --i: ${i}` },
        h('span', { class: 'opt-shape' }, shapeSvg(SHAPES[i])),
        h('span', { class: 'opt-text' }, text),
        // The tick on a right option; on a "put in order" question, its right place.
        settled && order ? h('span', { class: 'opt-tick opt-rank' }, String(rights.indexOf(i) + 1)) : settled && rights.includes(i) ? h('span', { class: 'opt-tick' }, '✓') : null,
      ),
    ),
  );
}

// After a "put in order" question: the options in the right order, each with how many put it in that place.
function orderResult(q) {
  return h(
    'ol',
    { class: 'quick-order-result' },
    rightOf(q).map((p, k) =>
      h(
        'li',
        { style: `${optStyle(p)}; --i: ${k}` },
        h('b', { class: 'order-n' }, String(k + 1)),
        h('span', { class: 'opt-shape' }, shapeSvg(SHAPES[p])),
        h('span', { class: 'opt-text' }, q.options[p]),
        h('span', { class: 'order-count' }, t('quickPlaced', { n: q.counts[p] })),
      ),
    ),
  );
}

// "4 of 6 got it right", in the kind's words.
function verdictText(q) {
  if (q.points === 0) return t('quickSurvey');
  const n = q.nRight ?? rightOf(q).reduce((sum, i) => sum + (q.counts[i] ?? 0), 0); // everyone who picked a right one
  if (!n) return t('quickNobodyRight');
  return t(q.type === 'order' ? 'quickGotOrder' : q.type === 'multi' ? 'quickGotAll' : 'quickGotIt', { n, total: q.total });
}

// After the answers: a bar per option, as tall as how many picked it.
function answerBars(q) {
  const rights = rightOf(q) ?? [];
  const max = Math.max(1, ...q.counts);
  return h(
    'div',
    { class: 'quick-bars' },
    q.counts.map((n, i) =>
      h(
        'div',
        { class: `qbar${rights.includes(i) ? ' right' : ''}`, style: `${optStyle(i)}; --h: ${n / max}; --i: ${i}` },
        h('b', {}, String(n)),
        h('span', { class: 'qbar-fill' }),
        h('span', { class: 'qbar-shape' }, shapeSvg(SHAPES[i]), rights.includes(i) ? h('i', {}, '✓') : null),
      ),
    ),
  );
}

function quickQuestion(fresh) {
  const q = view.q;
  const p = view.phase;
  if (p === 'ready') {
    return h(
      'div',
      { class: `tv-q quick-ready${q.image ? ' has-image' : ''}${fresh ? '' : ' still'}` },
      quickWhere(q),
      img(q.image, 'q-img'),
      q.image ? null : clipViz(),
      q.question ? h('p', { class: 'question' }, q.question) : h('div', { class: 'spacer' }),
      styleLine(q),
      q.image ? clipViz() : null,
      h('div', { class: 'band' }, h('span', { class: 'muted' }, t(view.deadline == null ? 'quickAnswersSpace' : 'quickAnswersSoon')), countdown(view)),
    );
  }
  const settled = p === 'result' || p === 'ranks';
  const media = img(q.image, 'q-img') ?? (view.clip ? clipViz() : null);
  return h(
    'div',
    { class: `quick-q${settled ? ' settled' : ''}${fresh ? ' fresh' : ''}` },
    h('div', { class: 'quick-head' }, quickWhere(q), h('p', { class: 'question' }, q.question), styleLine(q)),
    h(
      'div',
      { class: `quick-mid${media && !settled ? ' has-media' : ''}` },
      settled ? null : timerRing(),
      settled ? (q.type === 'order' ? orderResult(q) : answerBars(q)) : h('div', { class: 'quick-media' }, media),
      settled ? null : answeredCount(q),
    ),
    settled ? h('div', { class: 'quick-verdict' }, h('span', {}, verdictText(q)), fastestBadge(q.fastest)) : null,
    settled ? creditLine(q.credit) : null,
    optionTiles(q),
  );
}

// The fastest right answer: a fun title, the name in its colour, and the time.
function fastestBadge(f) {
  if (!f) return null;
  return h('span', { class: 'fastest', style: teamStyle(f) }, h('span', { class: 'fastest-title' }, `⚡ ${fastestTitle(view.pos)}`), h('span', { class: 'plate' }, face(f), h('span', {}, f.name)), h('b', {}, secondsText(f.ms)));
}

// The place in a circle, or with an avatar: the face with the place as a small badge on its corner.
function rankFace(e, rank) {
  const n = h('span', { class: 'rank-n' }, String(rank));
  return e.avatar ? h('span', { class: 'rank-face' }, face(e), n) : n;
}

// One leaderboard row: the arrow, the place, the name, what this question gave, the score.
// `was` (the standing before the question) shows the old place and score until the animation moves it on.
function rankRow(e, i, was = e) {
  const arrow = e.move === 'up' ? `▲ ${e.places}` : e.move === 'down' ? `▼ ${e.places}` : e.move === 'new' ? '★' : '–';
  return h(
    'li',
    { 'data-id': e.id, class: was.rank === 1 ? 'lead' : null, style: `${teamStyle(e)}; --i: ${i}` }, // everyone in 1st place (ties too) is big
    h('span', { class: `move ${e.move ?? 'same'}` }, arrow),
    h(
      'span',
      { class: 'plate rank-plate' },
      rankFace(e, was.rank),
      h('span', { class: 'rank-name' }, e.name),
      e.delta ? h('span', { class: 'rank-delta' }, `+${pts(e.delta)}`) : null,
      h('span', { class: 'rank-score' }, pts(was.score)),
    ),
    h('span', { class: 'move-pad', 'aria-hidden': 'true' }), // as wide as the arrow column, so the plate sits centred under the title
  );
}

// The top 5. When it first shows, it starts as it stood before the question: the points count up, then the
// rows glide to their new places (rankanim.js). A redraw while that runs shows the end result at once.
function quickRanks(fresh) {
  const top = view.ranks?.top ?? [];
  const before = view.ranks?.before ?? [];
  const animate = fresh && before.length > 0 && !reducedMotion();
  let list;
  if (animate) {
    const now = new Map(top.map((e) => [e.id, e]));
    const was = new Set(before.map((e) => e.id));
    const rows = [...before.map((b, i) => rankRow(now.get(b.id) ?? b, i, b)), ...top.filter((e) => !was.has(e.id)).map((e, i) => rankRow(e, before.length + i))];
    rows.slice(before.length).forEach((li) => li.classList.add('waiting'));
    list = h('ol', { class: 'top-list animating' }, rows);
    animateRanks(list, before, top, { swap: () => view.settings.sound && sounds.swap() });
  } else {
    list = h('ol', { class: 'top-list' }, top.map((e, i) => rankRow(e, i)));
    document.body.dataset.rankanim = 'done';
  }
  return h(
    'div',
    { class: `quick-ranks${fresh ? ' fresh' : ''}` },
    h('p', { class: 'final-kicker' }, t('quickQuestionOf', { n: view.pos.i + 1, total: sectionNow().n })),
    h('h1', {}, t('quickTop', { n: Math.min(5, top.length) })),
    list,
  );
}

// Between sections: the section's name, and the full standings (or just who is playing, before any points).
function quickSection(fresh) {
  const sec = sectionNow();
  const all = view.standings ?? [];
  const scored = all.some((e) => e.score > 0);
  const shown = all.slice(0, 10);
  return h(
    'div',
    { class: `tv-final quick-section${fresh ? '' : ' still'}` },
    h('p', { class: 'final-kicker' }, t('quickSectionOf', { n: view.pos.s + 1, total: view.set.sections.length })),
    h('h1', { class: 'final-cat' }, sec.name),
    h('p', { class: 'final-note' }, t('quickNQuestions', { n: sec.n })),
    scored
      ? h(
          'div',
          { class: 'standings' },
          h('h2', {}, t('quickStandings')),
          h('ol', { class: `standings-list${shown.length > 5 ? ' two' : ''}` }, shown.map((e, i) => h('li', { class: 'plate', style: `${teamStyle(e)}; --i: ${i}` }, rankFace(e, e.rank), h('span', { class: 'rank-name' }, e.name), h('b', {}, pts(e.score))))),
          all.length > shown.length ? h('p', { class: 'final-note' }, t('quickAndMore', { n: all.length - shown.length })) : null,
        )
      : [h('ul', { class: 'final-teams' }, all.map((e) => h('li', { class: 'plate', style: teamStyle(e) }, face(e), h('span', {}, e.name)))), h('p', { class: 'final-note' }, t('quickPlayersReady'))],
  );
}

// The end: a podium, revealed 3rd, 2nd, 1st, and everyone else underneath.
function quickPodium(fresh) {
  const all = view.standings ?? [];
  const podium = all.slice(0, 3);
  const tie = all.length > 1 && all[0].score === all[1].score;
  // Each step's points count up as it rises (3rd, 2nd, then 1st, in time with the CSS).
  const rise = { 3: 300, 2: 1200, 1: 2200 };
  const step = (e, n) => {
    if (!e) return h('div', { class: `step p${n} empty` });
    const key = `podium-${n}`;
    if (fresh) countTo(key, 0, e.score, { ms: 700, delay: rise[n] + 150 });
    return h(
      'div',
      { class: `step p${n}`, style: teamStyle(e) },
      face(e, 'step-face'),
      h('span', { class: 'plate step-name' }, e.name),
      h('div', { class: 'step-block' }, h('span', { class: 'step-place' }, t(`quickPlace${e.rank > 3 ? 3 : e.rank}`)), h('b', { 'data-count': key }, pts(shownCount(key, e.score)))),
    );
  };
  return h(
    'div',
    { class: `quick-podium${fresh ? ' fresh' : ''}` },
    brandBlock(),
    h('h1', {}, all.length ? (tie ? t('tie') : t('winner', { name: all[0].name })) : t('gameOver')),
    h('div', { class: 'podium' }, step(podium[1], 2), step(podium[0], 1), step(podium[2], 3)),
    all.length > 3
      ? h('ol', { class: 'podium-rest' }, all.slice(3, 15).map((e) => h('li', { style: teamStyle(e) }, h('span', {}, `${e.rank}.`), face(e), ` ${e.name} `, h('b', {}, pts(e.score)))))
      : null,
  );
}

let quickSig = ''; // what the screen showed last time
let quickOpenSig = ''; // the same, without the answer count
function renderQuick() {
  const p = view.phase;
  const key = `quick-${p}-${view.pos?.s}-${view.pos?.i}`;
  const fresh = lastScreen !== key;
  const sig = JSON.stringify([brand, view.settings.lang, view.q, view.ranks, view.standings, view.deadline, view.clip, view.media?.playing, view.set.sections]);
  const openSig = p === 'open' ? JSON.stringify([view.settings.lang, { ...view.q, answered: 0 }, view.deadline, view.clip, view.media?.playing]) : '';
  if (!fresh && $('#game .tv-game')) {
    // Same screen and nothing on it changed: keep it (and its animations) as it is.
    if (sig === quickSig) return false;
    // While the answers are open, most updates only change how many have answered.
    const count = document.querySelector('.q-count b');
    if (p === 'open' && openSig === quickOpenSig && count) {
      count.textContent = String(view.q.answered);
      quickSig = sig;
      return false;
    }
  }
  quickSig = sig;
  quickOpenSig = openSig;
  lastScreen = key;
  cancelRanks(); // a new screen (or the same one redrawn): the top 5's animation stops
  preloadImages();
  if (p === 'section') return quickSection(fresh);
  if (p === 'ranks') return quickRanks(fresh);
  if (p === 'over') return quickPodium(fresh);
  if (view.q) return quickQuestion(fresh);
  return h('div', { class: 'spacer' });
}

// ----- final round -----

function finalTeams(mark) {
  return h(
    'ul',
    { class: 'final-teams' },
    view.teams.map((tm) => {
      const done = mark(tm.id);
      return h('li', { class: `plate${done ? '' : ' waiting'}`, style: teamStyle(tm) }, face(tm), h('span', {}, tm.name), h('b', {}, done ? '✓' : '…'));
    }),
  );
}

function renderFinal() {
  const f = view.final;
  const p = view.phase;
  if (p === 'finalWager') {
    const zoom = lastScreen !== 'finalWager';
    lastScreen = 'finalWager';
    return h(
      'div',
      { class: 'tv-final', style: zoom ? '' : 'animation: none' },
      h('p', { class: 'final-kicker' }, t('finalRound')),
      h('h1', { class: 'final-cat' }, f.category),
      h('p', { class: 'final-note' }, t('placeBets')),
      finalTeams((id) => f.wagered.includes(id)),
    );
  }
  if (p === 'finalQuestion') {
    const zoom = lastScreen !== 'finalQuestion';
    lastScreen = 'finalQuestion';
    return h(
      'div',
      { class: `tv-q${f.image ? ' has-image' : ''}`, style: zoom ? '' : 'animation: none' },
      h('div', { class: 'where' }, h('span', {}, `${t('finalRound')}: ${f.category}`)),
      img(f.image, 'q-img'),
      f.image ? null : clipViz(),
      f.question ? h('p', { class: 'question' }, f.question) : h('div', { class: 'spacer' }),
      h('div', { class: 'band' }, h('span', {}, t('typeAnswers')), countdown(view)),
      finalTeams((id) => f.answered.includes(id)),
    );
  }
  // finalJudge: each team's answer and bet appear as the host judges it.
  lastScreen = 'finalJudge';
  return h(
    'div',
    { class: 'tv-judge' },
    h('div', { class: 'judge-q' }, h('span', { class: 'muted' }, `${t('finalRound')}: ${f.category}`), h('p', {}, f.question)),
    h(
      'ul',
      { class: 'judge-cards' },
      view.teams.map((tm) => {
        const r = f.reveal[tm.id];
        const verdict = f.judged[tm.id];
        return h(
          'li',
          { class: `judge-card${r ? ' shown' : ''}${verdict === true ? ' right' : verdict === false ? ' wrong' : ''}`, style: teamStyle(tm) },
          h('span', { class: 'who' }, face(tm), h('span', {}, tm.name)),
          h('span', { class: 'what' }, r ? r.answer || '—' : '?'),
          r ? h('span', { class: 'bet' }, r.wager === 0 ? '0' : `${verdict ? '+' : '−'}${pts(r.wager)}`) : null,
        );
      }),
    ),
    f.answer ? h('p', { class: 'judge-answer' }, img(f.answerImage, 'judge-img'), h('span', {}, t('theAnswer')), h('b', {}, f.answer)) : null,
    f.answer ? creditLine(f.credit) : null,
  );
}

// Round 2's intro: a new board, bigger points, and the team with the fewest points picks first.
function renderRound2() {
  const zoom = lastScreen !== 'round2';
  lastScreen = 'round2';
  const top = Math.max(0, ...view.set.categories.flatMap((cat) => cat.questions.map((q) => q.value)));
  const picker = teamById(view.picker);
  return h(
    'div',
    { class: 'tv-final tv-round2', style: zoom ? '' : 'animation: none' },
    h('p', { class: 'final-kicker' }, t('round2Kicker')),
    h('h1', { class: 'final-cat' }, t('round2Title')),
    h('p', { class: 'final-note' }, t('round2UpTo', { n: pts(top) })),
    h('ul', { class: 'round2-cats' }, view.set.categories.map((cat) => h('li', {}, cat.name))),
    picker ? h('p', { class: 'plate round2-picker', style: teamStyle(picker) }, face(picker), h('span', {}, t('round2PicksFirst', { name: picker.name }))) : null,
  );
}

// The host's logo and event name on the end screen (nothing without branding).
function brandBlock() {
  const parts = [brandLogo(brand, 'brand-logo big'), brand?.name ? h('p', { class: 'brand-name' }, brand.name) : null].filter(Boolean);
  return parts.length ? h('div', { class: 'tv-brand end' }, parts) : null;
}

// `fresh`: the game just ended, so the scores count up from 0, the last place first.
function renderOver(fresh) {
  const ranked = ranking(view.teams);
  const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;
  const key = (tm) => `over-${tm.id}`;
  if (fresh) ranked.forEach((tm, i) => countTo(key(tm), 0, tm.score, { ms: 900, delay: 400 + (ranked.length - 1 - i) * 160, tick: false })); // the fanfare plays meanwhile
  return h(
    'div',
    { class: 'tv-over' },
    brandBlock(),
    h('h1', {}, ranked.length ? (tie ? t('tie') : t('winner', { name: ranked[0].name })) : t('gameOver')),
    h('ol', {}, ranked.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', { class: 'over-name' }, face(tm), h('span', {}, tm.name)), h('span', { 'data-count': key(tm) }, pts(shownCount(key(tm), tm.score)))))),
  );
}

// The score strip along the bottom. A team's score bumps when it changes, and counts to its new value.
const stripScores = new Map(); // team id → the score the strip last showed
function renderScores(bumped) {
  const q = view.q;
  for (const team of view.teams) {
    const was = stripScores.get(team.id);
    const key = `strip-${team.id}`;
    if (was !== undefined && was !== team.score) countTo(key, shownCount(key, was), team.score, { ms: 500 });
    stripScores.set(team.id, team.score);
  }
  return h(
    'ul',
    { class: 'tv-scores' },
    view.teams.map((team) =>
      h(
        'li',
        {
          class: `plate${view.picker === team.id && view.phase === 'board' ? ' picker' : ''}${q?.lockedOut.includes(team.id) ? ' out' : ''}${bumped === team.id ? ' bump' : ''}`,
          style: teamStyle(team),
        },
        face(team),
        h('span', { class: 'name' }, team.name),
        h('span', { class: 'pts', 'data-count': `strip-${team.id}` }, pts(shownCount(`strip-${team.id}`, team.score))),
      ),
    ),
  );
}

function renderGame() {
  const p = view.phase;
  const ev = view.event;
  const fresh = ev && ev.seq !== lastSeq;
  if (ev) lastSeq = ev.seq;

  let stage;
  if (view.mode === 'quick') {
    stage = renderQuick();
    if (stage === false) return; // nothing to redraw
  } else if (p === 'board') {
    lastScreen = 'board';
    preloadImages();
    stage = renderBoard();
  } else if (p === 'round2') stage = renderRound2();
  else if (p === 'special') stage = renderSpecialTv();
  else if (view.q) stage = renderQuestion();
  else if (p === 'over') stage = renderOver(fresh && ev.type === 'over');
  else stage = renderFinal();

  // The buzz takeover: the frame floods in the colour of the team that buzzed.
  const buzzed = p === 'answering' ? teamById(view.q.buzzedTeam) : null;
  const takeover = buzzed ? h('div', { class: `tv-takeover${fresh && ev.type === 'buzz' ? ' flash' : ''}`, style: teamStyle(buzzed) }) : null;
  const bumped = fresh && ['correct', 'wrong', 'timeup'].includes(ev.type) ? ev.teamId : null; // includes final judgements

  $('#game').replaceChildren(
    // A Quick quiz has no score strip: too many players, and the top 5 shows after every question.
    h('div', { class: `tv-game${view.mode === 'quick' ? ' quick' : ''}` }, takeover, h('div', { class: 'tv-stage' }, stage), p === 'over' || view.mode === 'quick' ? null : renderScores(bumped)),
  );
}

function render() {
  setGlass(view.settings.glass);
  setBrand(brand);
  setLang(view.settings.lang);
  translatePage();
  const inLobby = view.phase === 'lobby';
  document.body.dataset.mode = view.mode ?? 'board';
  if (inLobby) {
    lastScreen = '';
    stripScores.clear(); // a new game's scores start fresh, without counting
    cancelRanks();
  }
  // The glass look's glow behind the stage takes the first teams' colours (the stage light when there are none).
  for (const [i, name] of ['a', 'b', 'c'].entries()) document.body.style.setProperty(`--glow-${name}`, view.teams[i]?.color ?? '');
  $('#lobby').hidden = !inLobby;
  $('#game').hidden = inLobby;
  // The wordmark (or the host's logo) in the corner: ProQuiz's only in the lobby; a logo all game long, except where it
  // is shown big (the lobby and the end screen).
  // Inside the host page (single-screen mode) the host bar above already shows it.
  const corner = Boolean(brand?.logo) && !inLobby && view.phase !== 'over' && !embedded;
  document.querySelector('.display > .wordmark').hidden = brand?.logo ? !corner : !inLobby;
  document.body.classList.toggle('logo-corner', corner);
  if (inLobby) renderLobby();
  else renderGame();
  syncClip(view, view.mode === 'quick' ? `quick-${view.pos?.s}-${view.pos?.i}` : view.q ? `q${view.round}-${view.q.c}-${view.q.i}` : 'final');
  syncMusic(view, net.now());
  showUnlock();
}
