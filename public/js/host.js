// The host laptop: lobby with settings, then the game controls. The host sees the answers.
//
// Keys: Space = turn buzzers on / back to the board, Y = correct, N = wrong, R = show answer,
// Esc = put the question back, U = undo.
import { ranking, COLORS, KINDS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, translatePage } from './i18n.js';
import { $, h, fill, qrSvg, shortUrl, countdown, runCountdowns, teamStyle } from './ui.js';
import { unlockAudio, audioReady, playEvent, playSound, startTicks } from './sounds.js';
import { syncClip, stopClip } from './clip.js';
import { ICONS, ruleFor, badgeFor } from './specials.js';

let view = null;
let connected = new Set();
let info = null;
let displays = 0; // TV screens open; when there are none, this laptop plays the sounds
let soundSeq = null;
let resume = null; // a saved game the host can continue

const net = connect({
  role: 'host',
  onMessage(msg) {
    if (msg.type === 'welcome') {
      info = msg.info;
      renderQr();
    } else if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
      displays = msg.displays;
      resume = msg.resume ?? null;
      const ev = view.event;
      if (ev && soundSeq !== null && ev.seq !== soundSeq && displays === 0) playEvent(view, ev, COLORS);
      soundSeq = ev?.seq ?? 0;
      render();
    } else if (msg.type === 'sound') {
      playSound(view, msg, COLORS);
    } else if (msg.type === 'error') {
      showError(t(`err-${msg.code}`));
    }
  },
});
runCountdowns(net.now);
startTicks(() => (displays === 0 ? view : null), net.now);

function showUnlock() {
  $('#sound-unlock').hidden = !view?.settings.sound || displays > 0 || audioReady();
}
for (const type of ['pointerdown', 'keydown']) {
  document.addEventListener(type, () => {
    unlockAudio();
    setTimeout(showUnlock, 100);
  });
}

const cmd = (action) => net.send({ type: 'cmd', action });

function showError(text) {
  const el = $('#host-error');
  el.textContent = text;
  el.hidden = !text;
}

function renderQr() {
  if (!info) return;
  if (info.phoneUrl) {
    if ($('#qr').dataset.url !== info.phoneUrl) {
      $('#qr').replaceChildren(qrSvg(info.phoneUrl));
      $('#qr').dataset.url = info.phoneUrl;
    }
    $('#url').textContent = shortUrl(info.phoneUrl);
  } else {
    $('#qr').replaceChildren();
    $('#url').textContent = t('noNetwork');
  }
}

const teamName = (id) => view.teams.find((tm) => tm.id === id)?.name ?? '?';

// ----- lobby -----

function renderTeams() {
  const teams = view.teams;
  $('#team-count').textContent = `${teams.length}/8`;
  $('#no-teams').hidden = teams.length > 0;
  $('#teams').replaceChildren(
    ...teams.map((team) => {
      const on = connected.has(team.id);
      return h(
        'li',
        { class: 'plate', style: teamStyle(team) },
        h('span', { class: 'name' }, team.name),
        h('span', { class: 'conn' }, h('span', { class: `dot${on ? ' on' : ''}` }), on ? t('online') : t('offline')),
        h(
          'button',
          {
            class: 'remove',
            type: 'button',
            'aria-label': t('removeTeam', { name: team.name }),
            title: t('removeTeam', { name: team.name }),
            onclick: () => confirm(t('confirmRemove', { name: team.name })) && cmd({ type: 'removeTeam', teamId: team.id }),
          },
          '×',
        ),
      );
    }),
  );
  $('#start').disabled = teams.length === 0;
  $('#start-why').hidden = teams.length > 0;
}

// Fill the settings form from the game, unless the host is typing in it right now.
function renderSettings() {
  const form = $('#settings');
  for (const [key, value] of Object.entries(view.settings)) {
    const el = form.elements[key];
    if (!el || el === document.activeElement) continue;
    if (el.type === 'checkbox') el.checked = value;
    else el.value = String(value);
  }
  form.elements.finalSeconds.disabled = !view.settings.finalRound;
  renderCrazyKinds();
}

// Kaosmodus: a tick for each special; unticked ones are left out of the game.
function renderCrazyKinds() {
  const box = $('#crazy-kinds');
  box.hidden = view.settings.crazy === 'off';
  const excluded = view.settings.crazyExclude;
  if (!$('#crazy-kind-list').children.length) {
    fill(
      $('#crazy-kind-list'),
      KINDS.map((kind) =>
        h('label', { class: 'check' }, h('input', { type: 'checkbox', name: 'crazyKind', value: kind }), h('span', { class: `kind-icon k-${kind}` }, ICONS[kind]), h('span', { 'data-t': `n-${kind}` }, t(`n-${kind}`))),
      ),
    );
  }
  for (const input of box.querySelectorAll('input[name=crazyKind]')) input.checked = !excluded.includes(input.value);
  $('#crazy-none').hidden = excluded.length < KINDS.length;
}

$('#settings').addEventListener('change', (e) => {
  const el = e.target;
  if (el.name === 'crazyKind') {
    const excluded = [...$('#settings').querySelectorAll('input[name=crazyKind]')].filter((x) => !x.checked).map((x) => x.value);
    return cmd({ type: 'settings', settings: { crazyExclude: excluded } });
  }
  let value = el.type === 'checkbox' ? el.checked : el.value;
  if (el.type === 'number') {
    value = Math.round(Number(value));
    if (!Number.isFinite(value) || value < Number(el.min) || value > Number(el.max)) {
      el.value = String(view.settings[el.name]);
      return;
    }
  }
  cmd({ type: 'settings', settings: { [el.name]: value } });
});

$('#start').addEventListener('click', () => cmd({ type: 'start' }));

// The list of quizzes to choose from (fetched when the lobby shows, and when the window gets focus again).
let quizList = [];
async function loadQuizzes() {
  try {
    quizList = await (await fetch('/api/sets')).json();
  } catch {
    return;
  }
  renderSetPicker();
}
function renderSetPicker() {
  const sel = $('#set-picker');
  if (!view || sel === document.activeElement) return;
  const opts = quizList.map((q) =>
    h('option', { value: q.id, disabled: q.problems > 0 }, q.problems ? `${q.title} (${t('needsFixing')})` : q.title),
  );
  if (!quizList.some((q) => q.id === view.setId)) opts.unshift(h('option', { value: view.setId ?? '' }, view.set.title));
  sel.replaceChildren(...opts);
  sel.value = view.setId ?? '';
}
$('#set-picker').addEventListener('change', (e) => net.send({ type: 'chooseSet', id: e.target.value }));
window.addEventListener('focus', loadQuizzes);
loadQuizzes();
$('#test-sound').addEventListener('click', () => net.send({ type: 'testSound' }));
$('#resume-yes').addEventListener('click', () => net.send({ type: 'resume' }));
$('#resume-no').addEventListener('click', () => net.send({ type: 'discardSave' }));

function renderResume() {
  $('#resume').hidden = !resume;
  if (!resume) return;
  const time = new Date(resume.savedAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('#resume-text').textContent = t('resumeText', { title: resume.title, time, played: resume.played, total: resume.total });
  $('#resume-teams').replaceChildren(
    ...resume.teams.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, tm.name), h('b', {}, String(tm.score)))),
  );
}

// ----- game -----

// The buttons for the current moment. Each has a key; the same list drives the keyboard.
function controls() {
  const p = view.phase;
  const list = [];
  const add = (key, label, action, cls = '') => list.push({ key, label, action, cls });
  if (p === 'special') {
    add(' ', view.q.special === 'bomb' ? t('bombGo') : t('specialGo'), { type: 'next' }, 'btn-primary');
    add('Escape', t('cancelBtn'), { type: 'cancel' });
  } else if (p === 'reading') {
    add(' ', view.q.solo ? t('soloArm') : t('armBtn'), { type: 'arm' }, 'btn-primary');
    add('r', t('revealBtn'), { type: 'reveal' });
    add('Escape', t('cancelBtn'), { type: 'cancel' });
  } else if (p === 'armed') {
    add('r', t('revealBtn'), { type: 'reveal' });
    if (!view.q.lockedOut.length) add('Escape', t('cancelBtn'), { type: 'cancel' });
  } else if (p === 'answering') {
    add('y', t('correctBtn'), { type: 'correct' }, 'btn-good');
    add('n', t('wrongBtn'), { type: 'wrong' }, 'btn-bad');
  } else if (p === 'revealed') {
    add(' ', t('nextBtn'), { type: 'next' }, 'btn-primary');
  } else if (p === 'board') {
    add('e', t('endBoardBtn'), () => confirm(t('confirmEnd')) && cmd({ type: 'end' }));
  } else if (p === 'finalWager') {
    add(' ', t('showFinalQ'), { type: 'next' }, 'btn-primary');
  } else if (p === 'finalQuestion') {
    add(' ', t('stopAnswers'), { type: 'next' }, 'btn-primary');
  } else if (p === 'finalJudge') {
    const left = view.teams.filter((tm) => !(tm.id in view.final.judged)).length;
    add(' ', t('showScores'), () => (left === 0 || confirm(t('confirmUnjudged', { n: left }))) && cmd({ type: 'next' }), 'btn-primary');
  } else if (p === 'over') {
    add('', t('restartBtn'), () => confirm(t('confirmRestart')) && cmd({ type: 'restart' }));
  }
  if (view.media) {
    add('p', view.media.playing ? t('clipPause') : t('clipPlay'), { type: 'mediaToggle' });
    add('0', t('clipRestart'), { type: 'mediaRestart' });
  }
  if (view.canUndo && p !== 'over') add('u', t('undoBtn'), { type: 'undo' }, 'push');
  add('m', view.settings.sound ? t('soundIsOn') : t('soundIsOff'), { type: 'settings', settings: { sound: !view.settings.sound } }, view.canUndo && p !== 'over' ? '' : 'push');
  return list;
}

const run = (action) => (typeof action === 'function' ? action() : cmd(action));
const keyLabel = (key) => ({ ' ': 'Space', Escape: 'Esc' })[key] ?? key.toUpperCase();

// The keyboard help (? or the Keys button).
const HELP = [
  ['Space', 'helpSpace'],
  ['Y', 'helpY'],
  ['N', 'helpN'],
  ['R', 'helpR'],
  ['Esc', 'helpEsc'],
  ['U', 'helpU'],
  ['P', 'helpP'],
  ['0', 'help0'],
  ['M', 'helpM'],
  ['E', 'helpE'],
  ['?', 'helpHelp'],
];
function toggleHelp(show = $('#help').hidden) {
  fill(
    $('#help'),
    h(
      'div',
      { class: 'help-card', role: 'dialog', 'aria-label': t('helpTitle') },
      h('h2', {}, t('helpTitle')),
      h('dl', {}, HELP.map(([key, text]) => [h('dt', {}, h('kbd', {}, key)), h('dd', {}, t(text))])),
      h('p', { class: 'help-foot' }, t('helpTv')),
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => toggleHelp(false) }, t('helpClose')),
    ),
  );
  $('#help').hidden = !show;
}
$('#help-btn').addEventListener('click', () => toggleHelp());
$('#help').addEventListener('click', (e) => e.target === $('#help') && toggleHelp(false));

document.addEventListener('keydown', (e) => {
  if (e.target.closest('input, select, textarea')) return;
  if (e.key === '?') return toggleHelp();
  if (e.key === 'Escape' && !$('#help').hidden) return toggleHelp(false);
  if (!view || view.phase === 'lobby' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = controls().find((x) => x.key === key);
  if (!c) return;
  e.preventDefault();
  run(c.action);
});

function renderControls() {
  return h(
    'nav',
    { class: 'controls', 'aria-label': t('controlsLabel') },
    controls().map((c) =>
      h(
        'button',
        { class: `btn ${c.cls}`, type: 'button', onclick: (e) => (e.currentTarget.blur(), run(c.action)) },
        c.label,
        c.key ? h('kbd', {}, keyLabel(c.key)) : null,
      ),
    ),
  );
}

function renderBoard() {
  return h(
    'div',
    {},
    h('p', { class: 'board-hint' }, view.picker ? `${t('picks', { name: teamName(view.picker) })}. ${t('boardHint')}` : t('boardHint')),
    h(
      'div',
      { class: 'host-board' },
      view.set.categories.map((cat, c) =>
        h(
          'div',
          { class: 'col' },
          h('div', { class: 'cat' }, cat.name),
          cat.questions.map((q, i) => {
            const kind = view.used[c][i] ? null : view.specials?.[`${c}-${i}`];
            return h(
              'button',
              { class: 'tile', type: 'button', disabled: view.used[c][i], 'data-special': kind || false, title: kind ? t(`k-${kind}`) : false, onclick: () => cmd({ type: 'pick', c, i }) },
              String(q.value),
              kind ? h('span', { class: 'tile-special' }, ICONS[kind]) : null,
            );
          }),
        ),
      ),
    ),
    Object.keys(view.specials ?? {}).length ? h('p', { class: 'board-hint specials-note' }, t('specialsNote')) : null,
  );
}

// Kaosmodus: the reveal, as the host sees it (the freeze choice is made here).
function renderSpecialHost() {
  const q = view.q;
  const kind = q.special;
  return h(
    'div',
    { class: 'host-q host-special' },
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, String(q.value))),
    h('div', { class: `special-card k-${kind}` }, h('span', { class: 'special-icon' }, ICONS[kind]), h('div', {}, h('h2', {}, t(`k-${kind}`)), h('p', {}, ruleFor(view)))),
    kind === 'freeze'
      ? h(
          'div',
          { class: 'freeze-pick' },
          h('p', {}, t('freezePick')),
          h(
            'div',
            { class: 'row' },
            view.teams
              .filter((tm) => tm.id !== view.picker)
              .map((tm) =>
                h(
                  'button',
                  { class: `btn plate${q.frozen === tm.id ? ' on' : ''}`, style: teamStyle(tm), type: 'button', 'aria-pressed': String(q.frozen === tm.id), onclick: () => cmd({ type: 'freeze', teamId: tm.id }) },
                  `${ICONS.freeze} ${tm.name}`,
                ),
              ),
          ),
        )
      : null,
  );
}

function statusLine() {
  const q = view.q;
  const p = view.phase;
  if (p === 'reading') return h('p', { class: 'host-status' }, q.solo ? t('soloStatus', { name: teamName(q.solo) }) : t('statusReading'));
  if (p === 'armed') {
    const wrongTeam = view.event?.reopened ? view.event.teamId : null;
    return h('p', { class: 'host-status' }, wrongTeam ? t('wrongReopen', { name: teamName(wrongTeam) }) : t('buzzersOn'));
  }
  if (p === 'answering') {
    const team = view.teams.find((tm) => tm.id === q.buzzedTeam);
    return h('p', { class: 'host-status' }, h('span', { class: 'plate', style: teamStyle(team) }, team.name), t('buzzedFirst', { name: '' }).trim());
  }
  if (p === 'revealed') {
    const r = q.result;
    const text =
      r.type === 'boom'
        ? t('boomResult', { name: teamName(r.teamId), n: r.amount })
        : r.type === 'correct' && q.won
          ? t('jackpotWon', { name: teamName(r.teamId), n: q.value, pot: q.won })
          : r.type === 'correct'
            ? t('resultCorrect', { name: teamName(r.teamId), n: q.value })
            : r.type === 'timeout'
              ? t('resultTimeout')
              : t('resultNobody');
    return h('p', { class: 'host-status' }, text);
  }
  return null;
}

// Who buzzed after the winner, and how close it was.
function buzzOrder() {
  const b = view.q.buzzes;
  if (view.phase !== 'answering' || b.length < 2) return null;
  const first = b[0].at;
  return h('p', { class: 'buzz-order' }, `${t('alsoBuzzed')} `, b.slice(1).map((x) => t('lateBy', { name: teamName(x.teamId), ms: x.at - first })).join(', '));
}

const img = (name, cls, label) =>
  name ? h('figure', { class: cls }, h('img', { src: `/files/${encodeURIComponent(name)}`, alt: '' }), label ? h('figcaption', {}, label) : null) : null;

function renderQuestion() {
  const q = view.q;
  const src = view.set.categories[q.c].questions[q.i];
  return h(
    'div',
    { class: 'host-q' },
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, String(q.value)), q.special ? h('span', { class: `special-badge k-${q.special}` }, badgeFor(view)) : null),
    src.image || src.answerImage
      ? h('div', { class: 'host-imgs' }, img(src.image, 'host-img', t('picQuestion')), img(src.answerImage, 'host-img', t('picAnswer')))
      : null,
    src.question ? h('p', { class: 'question' }, src.question) : null,
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    clipLine(src),
    statusLine(),
    countdown(view),
    buzzOrder(),
  );
}

// "Sound clip: playing" / "paused", so the host knows what the room hears.
function clipLine(src) {
  if (!src.audio) return null;
  const on = view.media?.playing;
  return h('p', { class: `clip-line${on ? ' on' : ''}` }, h('span', { class: 'clip-dot' }), on ? t('clipPlaying') : t('clipPaused'), src.audioStart ? ` (${t('clipFrom', { s: src.audioStart })})` : '');
}

// ----- final round -----

function renderFinal() {
  const f = view.final;
  const src = view.set.final;
  const p = view.phase;
  const head = [
    h('p', { class: 'where' }, t('finalRound'), h('b', {}, src.category)),
    p !== 'finalWager' && (src.image || src.answerImage)
      ? h('div', { class: 'host-imgs' }, img(src.image, 'host-img', t('picQuestion')), img(src.answerImage, 'host-img', t('picAnswer')))
      : null,
    h('p', { class: 'question' }, p === 'finalWager' ? t('hostWagerHint') : src.question),
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    p !== 'finalWager' ? clipLine(src) : null,
  ];
  if (p === 'finalQuestion') head.push(countdown(view));
  const rows = view.teams.map((tm) => {
    const wager = f.wagers[tm.id];
    const answer = f.answers[tm.id];
    const verdict = f.judged[tm.id];
    const cells = [h('span', { class: 'who' }, tm.name), h('span', { class: 'bet' }, wager == null ? t('betWaiting') : t('betAmount', { n: wager }))];
    if (p !== 'finalWager') cells.push(h('span', { class: 'said' }, answer == null ? t(p === 'finalJudge' ? 'noAnswer' : 'noAnswerYet') : answer || '—'));
    if (p === 'finalJudge') {
      const judge = (correct) => cmd({ type: 'judgeFinal', teamId: tm.id, correct: verdict === correct ? null : correct });
      cells.push(
        h(
          'span',
          { class: 'verdict' },
          h('button', { class: `btn btn-good${verdict === true ? ' on' : ''}`, type: 'button', onclick: () => judge(true), 'aria-pressed': String(verdict === true) }, t('correctBtn')),
          h('button', { class: `btn btn-bad${verdict === false ? ' on' : ''}`, type: 'button', onclick: () => judge(false), 'aria-pressed': String(verdict === false) }, t('wrongBtn')),
        ),
      );
    }
    return h('li', { class: `final-row${verdict === undefined ? '' : ' judged'}`, style: teamStyle(tm) }, cells);
  });
  return h('div', { class: 'host-q host-final' }, head, h('ul', { class: 'final-rows' }, rows));
}

function renderOver() {
  const ranked = ranking(view.teams);
  const tie = ranked.length > 1 && ranked[0].score === ranked[1].score;
  return h(
    'div',
    { class: 'host-over' },
    h('h2', {}, ranked.length ? (tie ? t('tie') : t('winner', { name: ranked[0].name })) : t('gameOver')),
    h('ol', { class: 'rank-list' }, ranked.map((tm) => h('li', { class: 'plate', style: teamStyle(tm) }, h('span', {}, tm.name), h('span', {}, String(tm.score))))),
  );
}

function renderScores() {
  const q = view.q;
  return h(
    'aside',
    { class: 'host-side' },
    h('h2', {}, t('teams')),
    view.teams.map((team) =>
      h(
        'div',
        {
          class: `score-row plate${q?.buzzedTeam === team.id ? ' buzzed' : ''}${q?.lockedOut.includes(team.id) ? ' out' : ''}`,
          style: teamStyle(team),
        },
        h(
          'span',
          { class: 'name' },
          h('span', { class: `dot${connected.has(team.id) ? ' on' : ''}`, title: connected.has(team.id) ? t('online') : t('offline') }),
          team.name,
        ),
        h('span', { class: 'pts' }, String(team.score)),
        h(
          'span',
          { class: 'tools' },
          view.picker === team.id
            ? h('span', { class: 'picker-tag' }, t('picksShort'))
            : h('button', { type: 'button', onclick: () => cmd({ type: 'setPicker', teamId: team.id }) }, t('makePicker')),
          h('button', { type: 'button', onclick: () => adjust(team) }, t('adjustBtn')),
        ),
      ),
    ),
  );
}

function adjust(team) {
  const answer = prompt(t('adjustPrompt', { name: team.name }));
  const delta = Math.round(Number(String(answer ?? '').replace(/\s/g, '').replace('−', '-')));
  if (answer && Number.isFinite(delta) && delta !== 0) cmd({ type: 'adjust', teamId: team.id, delta });
}

function renderGame() {
  const p = view.phase;
  let main;
  if (p === 'board') main = renderBoard();
  else if (p === 'special') main = renderSpecialHost();
  else if (view.q) main = renderQuestion();
  else if (p === 'over') main = renderOver();
  else main = renderFinal();
  $('#game').replaceChildren(h('div', { class: 'host-game' }, h('main', { class: 'host-main' }, main), renderScores(), renderControls()));
}

// ----- everything -----

function render() {
  document.body.dataset.phase = view.phase; // handy for the browser test
  setLang(view.settings.lang);
  translatePage();
  renderQr();
  showError('');
  $('#set-title').textContent = view.set.title;
  const inLobby = view.phase === 'lobby';
  $('#lobby').hidden = !inLobby;
  $('#game').hidden = inLobby;
  if (inLobby) {
    renderResume();
    renderTeams();
    renderSettings();
    renderSetPicker();
  } else {
    renderGame();
  }
  // With no TV screen open, this laptop plays the question's sound clip.
  if (displays === 0) syncClip(view, view.q ? `q${view.q.c}-${view.q.i}` : 'final');
  else stopClip();
  showUnlock();
}
