// The TV screen. Shows the game to the room; never gets an answer before the host reveals it.
import { ranking, COLORS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, translatePage } from './i18n.js';
import { $, h, qrSvg, shortUrl, countdown, runCountdowns, teamStyle } from './ui.js';
import { unlockAudio, audioReady, playEvent, playSound, startTicks } from './sounds.js';
import { syncClip, preloadClips } from './clip.js';

let view = null;
let connected = new Set();
let info = null;
let lastSeq = 0; // the last event we reacted to
let soundSeq = null; // the last event we played a sound for (null until the first state arrives)
let lastScreen = ''; // so the question only zooms in once, not on every update
const seen = new Set(); // teams already on screen, so only new ones pop in

const net = connect({
  role: 'display',
  onMessage(msg) {
    if (msg.type === 'welcome') info = msg.info;
    if (msg.type === 'sound') playSound(view, msg, COLORS);
    if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
      const ev = view.event;
      if (ev && soundSeq !== null && ev.seq !== soundSeq) playEvent(view, ev, COLORS);
      soundSeq = ev?.seq ?? 0;
    }
    if (view) render();
  },
});
runCountdowns(net.now);
startTicks(() => view, net.now);

// The TV plays the sounds. Browsers need one click or key press first.
function showUnlock() {
  $('#sound-unlock').hidden = !view?.settings.sound || audioReady();
}
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    unlockAudio();
    setTimeout(showUnlock, 100);
  });
}

// F for full screen (the TV window has no controls).
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});

const teamById = (id) => view.teams.find((tm) => tm.id === id);

// ----- lobby -----

function renderLobby() {
  if (info?.phoneUrl) {
    if ($('#qr').dataset.url !== info.phoneUrl) {
      $('#qr').replaceChildren(qrSvg(info.phoneUrl));
      $('#qr').dataset.url = info.phoneUrl;
    }
    $('#url').textContent = shortUrl(info.phoneUrl);
  } else {
    $('#url').textContent = t('noNetwork');
  }
  $('#teams').replaceChildren(
    ...view.teams.map((team) => {
      const isNew = !seen.has(team.id);
      seen.add(team.id);
      return h('li', { class: `plate${isNew ? ' new' : ''}${connected.has(team.id) ? '' : ' away'}`, style: teamStyle(team) }, team.name);
    }),
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
          cat.questions.map((q, i) => h('div', { class: `tile${view.used[c][i] ? ' used' : ''}` }, String(q.value))),
        ),
      ),
    ),
    view.picker ? h('p', { class: 'tv-picks' }, h('b', {}, t('picks', { name: teamById(view.picker)?.name ?? '' }))) : null,
  ];
}

function band() {
  const q = view.q;
  const p = view.phase;
  if (p === 'reading') return [h('span', { class: 'muted' }, t('getReady'))];
  if (p === 'armed') {
    const wrong = view.event?.reopened ? teamById(view.event.teamId) : null;
    return [h('span', {}, wrong ? t('wrongReopen', { name: wrong.name }) : t('buzzNow')), countdown(view)];
  }
  if (p === 'answering') {
    const team = teamById(q.buzzedTeam);
    return [h('span', { class: 'plate buzzed-name', style: teamStyle(team) }, team.name), countdown(view)];
  }
  if (p === 'revealed') {
    const r = q.result;
    if (r.type === 'correct') return [h('span', { class: 'plate buzzed-name', style: teamStyle(teamById(r.teamId)) }, `${teamById(r.teamId)?.name} +${q.value}`)];
    return [h('span', { class: 'muted' }, r.type === 'timeout' ? t('resultTimeout') : t('resultNobody'))];
  }
  return [];
}

const img = (name, cls) => (name ? h('img', { class: cls, src: `/files/${encodeURIComponent(name)}`, alt: '' }) : null);

// Load every question picture while the board is showing, so a picture never pops in late.
const preloaded = new Set();
function preloadImages() {
  for (const cat of view.set.categories)
    for (const q of cat.questions)
      if (q.image && !preloaded.has(q.image)) {
        preloaded.add(q.image);
        new Image().src = `/files/${encodeURIComponent(q.image)}`;
      }
  preloadClips(view.set.categories.flatMap((cat) => cat.questions.filter((q) => q.audio).map((q) => q.audio)));
}

// Moving bars while a sound clip plays: "listen!"
function clipViz() {
  if (!view.clip) return null;
  return h('div', { class: `clip-viz${view.media?.playing ? ' on' : ''}`, 'aria-hidden': 'true' }, [1, 2, 3, 4, 5, 6, 7].map(() => h('span')));
}

function renderQuestion() {
  const q = view.q;
  const zoom = lastScreen !== `q${q.c}-${q.i}`;
  lastScreen = `q${q.c}-${q.i}`;
  // When the answer comes with its own picture, it takes the question picture's place.
  const picture = q.answerImage || q.image;
  return h(
    'div',
    { class: `tv-q${picture ? ' has-image' : ''}`, style: zoom ? '' : 'animation: none' },
    h('div', { class: 'where' }, h('span', {}, view.set.categories[q.c].name), h('b', {}, String(q.value))),
    img(picture, `q-img${q.answerImage ? ' reveal-img' : ''}`),
    picture ? null : clipViz(),
    q.question ? h('p', { class: 'question' }, q.question) : h('div', { class: 'spacer' }),
    picture ? clipViz() : null,
    q.answer ? h('p', { class: 'answer' }, q.answer) : null,
    h('div', { class: 'band' }, band()),
  );
}

// ----- final round -----

function finalTeams(mark) {
  return h(
    'ul',
    { class: 'final-teams' },
    view.teams.map((tm) => {
      const done = mark(tm.id);
      return h('li', { class: `plate${done ? '' : ' waiting'}`, style: teamStyle(tm) }, h('span', {}, tm.name), h('b', {}, done ? '✓' : '…'));
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
          h('span', { class: 'who' }, tm.name),
          h('span', { class: 'what' }, r ? r.answer || '—' : '?'),
          r ? h('span', { class: 'bet' }, r.wager === 0 ? '0' : `${verdict ? '+' : '−'}${r.wager}`) : null,
        );
      }),
    ),
    f.answer ? h('p', { class: 'judge-answer' }, img(f.answerImage, 'judge-img'), h('span', {}, t('theAnswer')), h('b', {}, f.answer)) : null,
  );
}

function renderOver() {
  const ranked = ranking(view.teams);
  const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;
  return h(
    'div',
    { class: 'tv-over' },
    h('h1', {}, ranked.length ? (tie ? t('tie') : t('winner', { name: ranked[0].name })) : t('gameOver')),
    h('ol', {}, ranked.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, tm.name), h('span', {}, String(tm.score))))),
  );
}

// The score strip along the bottom. A team's score bumps when it changes.
function renderScores(bumped) {
  const q = view.q;
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
        h('span', { class: 'name' }, team.name),
        h('span', { class: 'pts' }, String(team.score)),
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
  if (p === 'board') {
    lastScreen = 'board';
    preloadImages();
    stage = renderBoard();
  } else if (view.q) stage = renderQuestion();
  else if (p === 'over') stage = renderOver();
  else stage = renderFinal();

  // The buzz takeover: the frame floods in the colour of the team that buzzed.
  const buzzed = p === 'answering' ? teamById(view.q.buzzedTeam) : null;
  const takeover = buzzed ? h('div', { class: `tv-takeover${fresh && ev.type === 'buzz' ? ' flash' : ''}`, style: teamStyle(buzzed) }) : null;
  const bumped = fresh && ['correct', 'wrong', 'timeup'].includes(ev.type) ? ev.teamId : null; // includes final judgements

  $('#game').replaceChildren(
    h('div', { class: 'tv-game' }, takeover, h('div', { class: 'tv-stage' }, stage), p === 'over' ? null : renderScores(bumped)),
  );
}

function render() {
  setLang(view.settings.lang);
  translatePage();
  const inLobby = view.phase === 'lobby';
  $('#lobby').hidden = !inLobby;
  $('#game').hidden = inLobby;
  document.querySelector('.display > .wordmark').hidden = !inLobby;
  if (inLobby) renderLobby();
  else renderGame();
  syncClip(view, view.q ? `q${view.q.c}-${view.q.i}` : 'final');
  showUnlock();
}
