// The host laptop: lobby with settings, then the game controls. The host sees the answers.
//
// Keys: Space = turn buzzers on / back to the board, Y = correct, N = wrong, R = show answer,
// Esc = put the question back, U = undo.
import { ranking } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, translatePage } from './i18n.js';
import { $, h, qrSvg, shortUrl, countdown, runCountdowns, teamStyle } from './ui.js';

let view = null;
let connected = new Set();
let info = null;

const net = connect({
  role: 'host',
  onMessage(msg) {
    if (msg.type === 'welcome') {
      info = msg.info;
      renderQr();
    } else if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
      render();
    } else if (msg.type === 'error') {
      showError(t(`err-${msg.code}`));
    }
  },
});
runCountdowns(net.now);

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
}

$('#settings').addEventListener('change', (e) => {
  const el = e.target;
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

// ----- game -----

// The buttons for the current moment. Each has a key; the same list drives the keyboard.
function controls() {
  const p = view.phase;
  const list = [];
  const add = (key, label, action, cls = '') => list.push({ key, label, action, cls });
  if (p === 'reading') {
    add(' ', t('armBtn'), { type: 'arm' }, 'btn-primary');
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
  } else if (p === 'finalWager' || p === 'finalQuestion' || p === 'finalJudge') {
    add(' ', t('nextBtn'), { type: 'next' }, 'btn-primary'); // the final round screens arrive in a later step
  } else if (p === 'over') {
    add('', t('restartBtn'), () => confirm(t('confirmRestart')) && cmd({ type: 'restart' }));
  }
  if (view.canUndo && p !== 'over') add('u', t('undoBtn'), { type: 'undo' }, 'push');
  return list;
}

const run = (action) => (typeof action === 'function' ? action() : cmd(action));
const keyLabel = (key) => ({ ' ': 'Space', Escape: 'Esc' })[key] ?? key.toUpperCase();

document.addEventListener('keydown', (e) => {
  if (!view || view.phase === 'lobby' || e.ctrlKey || e.metaKey || e.altKey || e.repeat) return;
  if (e.target.closest('input, select, textarea')) return;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const c = controls().find((x) => x.key === key);
  if (!c) return;
  e.preventDefault();
  run(c.action);
});

function renderControls() {
  return h(
    'nav',
    { class: 'controls', 'aria-label': 'Controls' },
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
          cat.questions.map((q, i) =>
            h('button', { class: 'tile', type: 'button', disabled: view.used[c][i], onclick: () => cmd({ type: 'pick', c, i }) }, String(q.value)),
          ),
        ),
      ),
    ),
  );
}

function statusLine() {
  const q = view.q;
  const p = view.phase;
  if (p === 'reading') return h('p', { class: 'host-status' }, t('statusReading'));
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
      r.type === 'correct' ? t('resultCorrect', { name: teamName(r.teamId), n: q.value }) : r.type === 'timeout' ? t('resultTimeout') : t('resultNobody');
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

function renderQuestion() {
  const q = view.q;
  const src = view.set.categories[q.c].questions[q.i];
  return h(
    'div',
    { class: 'host-q' },
    h('p', { class: 'where' }, `${view.set.categories[q.c].name} `, h('b', {}, String(q.value))),
    h('p', { class: 'question' }, src.question),
    h('p', { class: 'answer' }, h('span', {}, `${t('answerLabel')}:`), src.answer),
    statusLine(),
    countdown(view),
    buzzOrder(),
  );
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
  else if (view.q) main = renderQuestion();
  else if (p === 'over') main = renderOver();
  else main = h('div', { class: 'host-q' }, h('p', { class: 'question' }, `${t('finalComing')}: ${view.set.final?.category ?? ''}`));
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
    renderTeams();
    renderSettings();
  } else {
    renderGame();
  }
}
