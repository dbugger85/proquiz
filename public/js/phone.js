// A team's phone: join with a name and colour, then act as the buzzer.
import { COLORS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, guessLang, translatePage } from './i18n.js';
import { $, h, inkFor, countdown, runCountdowns } from './ui.js';
import { keepAwake } from './wake.js';

const KEY = 'proquiz.team'; // { id, name, color } — survives reloads, so a phone re-joins as the same team

function loadSaved() {
  try {
    return JSON.parse(localStorage.getItem(KEY)) || {};
  } catch {
    return {};
  }
}
function save(data) {
  try {
    localStorage.setItem(KEY, JSON.stringify({ ...loadSaved(), ...data }));
  } catch {}
}

let saved = loadSaved();
let view = null; // latest phoneView from the server
let welcomed = false; // the server has told us whether our saved team still exists
let editing = false; // the team is changing its name or colour
let pendingJoin = false;

setLang(guessLang());
translatePage();

const net = connect({
  role: 'phone',
  teamId: () => saved.id ?? null,
  onStatus: (up) => ($('#offline').hidden = up),
  onMessage(msg) {
    if (msg.type === 'welcome') {
      welcomed = true;
      if (!msg.teamId) editing = false;
    } else if (msg.type === 'joined') {
      pendingJoin = false;
      editing = false;
      saved = { ...saved, id: msg.teamId };
      save(saved);
    } else if (msg.type === 'error') {
      pendingJoin = false;
      $('#join-error').textContent = t(`err-${msg.code}`);
    } else if (msg.type === 'state') {
      view = msg.view;
    }
    render();
  },
});

runCountdowns(net.now);

// Any tap keeps the screen on from then on (browsers need a tap before they allow it).
document.addEventListener('pointerdown', keepAwake);

// ----- join form -----

function renderSwatches() {
  const taken = new Set((view?.teams ?? []).filter((tm) => tm.id !== saved.id).map((tm) => tm.color));
  const box = $('#swatches');
  const current = box.querySelector('input:checked')?.value ?? saved.color;
  box.replaceChildren(
    ...COLORS.map((color, n) =>
      h(
        'label',
        {
          class: `swatch${taken.has(color) ? ' taken' : ''}`,
          style: `--team: ${color}; --team-ink: ${inkFor(color)}`,
          'data-taken': t('colorTaken'),
        },
        h('input', {
          type: 'radio',
          name: 'color',
          value: color,
          'aria-label': `${t('pickColor')} ${n + 1}`,
          disabled: taken.has(color),
          checked: color === current && !taken.has(color),
        }),
      ),
    ),
  );
}

$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name').value.trim();
  const color = $('#swatches input:checked')?.value;
  if (!name) return ($('#join-error').textContent = t('err-bad-name'));
  if (!color) return ($('#join-error').textContent = t('err-bad-color'));
  $('#join-error').textContent = '';
  saved = { ...saved, name, color };
  save(saved);
  pendingJoin = net.send({ type: 'join', name, color, teamId: saved.id });
  render();
});

$('#swatches').addEventListener('change', () => ($('#join-error').textContent = ''));

// ----- the team screen -----

let lastSeq = 0; // last event we reacted to

function buzz(e) {
  e.preventDefault();
  if (net.send({ type: 'buzz' })) {
    e.currentTarget.classList.add('pressed');
  }
}

function buzzer(live, size = '') {
  return h(
    'button',
    { class: `buzzer${live ? ' live' : ''}${size ? ` ${size}` : ''}`, type: 'button', onpointerdown: buzz, 'aria-label': t('buzz') },
    h('span', { class: 'label' }, t('buzz')),
  );
}

const nameOf = (id) => view.teams.find((tm) => tm.id === id)?.name ?? '';

function stage() {
  const s = view.status;
  const me = view.you;
  const ev = view.event;
  if (s === 'lobby') {
    return [
      h('div', { class: 'big' }, t('youreIn')),
      h('p', { class: 'small' }, t('waitStart')),
      buzzer(true, 'try'),
      h('p', { class: 'small' }, t('tryBuzzer')),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => ((editing = true), render()) }, t('changeTeam')),
    ];
  }
  // Kaosmodus
  if (s === 'special') return [h('div', { class: 'big' }, '👀'), h('div', { class: 'big' }, t('lookTv'))];
  if (s === 'bet') return doubleStage();
  if (s === 'freezeChoose') return freezeStage();
  if (s === 'frozen') return [h('div', { class: 'big' }, '🧊'), h('div', { class: 'big' }, t('frozenBig')), h('p', { class: 'small' }, t('frozenSmall'))];
  if (s === 'standBack') {
    return [view.turbo ? h('p', { class: 'kicker' }, t('turboOf', { n: view.turbo.n, total: view.turbo.total })) : null, h('div', { class: 'big' }, t('standBack', { name: nameOf(view.solo) }))];
  }
  if (s === 'soloReady') {
    return [view.turbo ? h('p', { class: 'kicker' }, t('turboOf', { n: view.turbo.n, total: view.turbo.total })) : null, h('div', { class: 'big' }, t('soloReady')), h('p', { class: 'small' }, t('soloReadySmall'))];
  }
  if (s === 'solo') return [h('div', { class: 'big' }, t('answerNow')), countdown(view)];
  if (view.phase === 'revealed' && ev?.type === 'boom' && ev.teamId === me.id) {
    return [h('div', { class: 'big' }, '💥'), h('div', { class: 'big' }, t('boomYou', { n: ev.amount ?? 0 }))];
  }
  if (s === 'armed') return [buzzer(true)];
  if (s === 'first') return [h('div', { class: 'big' }, t('youreFirst')), h('p', { class: 'small' }, t('answerNow')), countdown(view)];
  if (s === 'other') return [h('div', { class: 'big' }, t('otherFirst', { name: nameOf(view.buzzedTeam) }))];
  if (s === 'locked') return [h('p', { class: 'small' }, t('lockedOut'))];
  if (s === 'over') {
    const ranked = [...view.teams].sort((a, b) => b.score - a.score);
    const place = ranked.findIndex((tm) => tm.score === me.score) + 1;
    return [h('div', { class: 'big' }, t('gameOver')), h('p', { class: 'result' }, t('place', { n: place, total: ranked.length }))];
  }
  if (s === 'wager') return wagerStage();
  if (s === 'finalAnswer') return answerStage();
  if (s === 'finalWait') {
    const f = view.final;
    if (f.judged === null) return [h('div', { class: 'big' }, t('waitJudging')), f.answer ? h('p', { class: 'small' }, t('youAnswered', { text: f.answer })) : null];
    return [h('div', { class: 'big' }, f.judged ? t('finalRight', { n: f.wager ?? 0 }) : t('finalWrong', { n: f.wager ?? 0 }))];
  }
  // waiting: board, reading or revealed. While the host reads, the (dim) buzzer is there, but pressing it is too early.
  if (view.phase === 'reading') {
    const early = ev?.type === 'early' && ev.teamId === me.id;
    return [buzzer(false), early ? h('div', { class: 'big' }, t('tooEarly')) : h('p', { class: 'small' }, t('getReady'))];
  }
  if (view.phase === 'revealed' && ev?.type === 'correct' && ev.teamId === me.id) {
    return [h('div', { class: 'big' }, t('gotIt'))];
  }
  if (view.phase === 'board' && view.canPick) return pickStage();
  if (view.phase === 'board' && view.settings.phonePick && view.picker && view.picker !== me.id) {
    return [h('p', { class: 'small' }, t('otherPicks', { name: nameOf(view.picker) }))];
  }
  return [h('p', { class: 'small' }, t('waitNext'))];
}

// ----- picking the next question (only the picking team, only while the board shows) -----

let pickCat = null; // the category tapped first, then its points are shown

function pickStage() {
  const board = view.board;
  const cat = board[pickCat];
  if (!cat || cat.used.every(Boolean)) {
    pickCat = null;
    return [
      h('div', { class: 'big' }, t('yourPick')),
      h('p', { class: 'small' }, t('pickCategory')),
      h(
        'div',
        { class: 'pick-board' },
        board.map((cat, c) => {
          const left = cat.used.filter((u) => !u).length;
          return h(
            'button',
            { class: 'pick-cat', type: 'button', disabled: left === 0, onclick: () => ((pickCat = c), render()) },
            h('span', { class: 'pick-name' }, cat.name),
            h('small', {}, t('tilesLeft', { n: left })),
          );
        }),
      ),
    ];
  }
  return [
    h('p', { class: 'kicker' }, cat.name),
    h('p', { class: 'small' }, t('pickValue')),
    h(
      'div',
      { class: 'pick-values' },
      cat.values.map((value, i) =>
        h(
          'button',
          { class: `pick-tile${cat.used[i] ? ' used' : ''}`, type: 'button', disabled: cat.used[i], onclick: () => net.send({ type: 'pick', c: pickCat, i }) },
          String(value),
        ),
      ),
    ),
    h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => ((pickCat = null), render()) }, t('pickBack')),
  ];
}

// ----- Kaosmodus: the picking team's choices -----

// Daily Double: bet up to your score (or the board's top value), before the question shows.
function doubleStage() {
  const b = view.betting;
  const input = h('input', { id: 'double-bet', type: 'number', inputmode: 'numeric', min: 0, max: b.max, step: 1, value: b.bet ?? '', 'aria-label': t('yourBet') });
  const quick = (label, amount) => h('button', { class: 'chip', type: 'button', onclick: () => ((input.value = amount), input.focus()) }, label);
  return [
    h('p', { class: 'kicker' }, `🎲 ${t('doubleTitle')}`),
    h(
      'form',
      {
        class: 'final-form',
        onsubmit: (e) => {
          e.preventDefault();
          const amount = Math.round(Number(input.value));
          if (input.value === '' || !Number.isFinite(amount) || amount < 0 || amount > b.max) return ($('#final-error').textContent = t('err-bad-wager'));
          net.send({ type: 'bet', amount });
          input.blur();
        },
      },
      h('label', { for: 'double-bet' }, t('doubleAsk'), ' ', h('span', { class: 'muted' }, t('doubleUpTo', { n: b.max }))),
      input,
      h('div', { class: 'chips' }, quick(t('doubleTile', { n: b.value }), b.value), quick(t('betHalf'), Math.floor(b.max / 2)), quick(t('betAll'), b.max)),
      h('p', { id: 'final-error', class: 'error', role: 'alert' }),
      h('button', { class: 'btn btn-ink', type: 'submit' }, t('placeBet')),
    ),
    b.bet != null ? h('p', { class: 'small' }, t('doubleBetPlaced', { n: b.bet })) : null,
  ];
}

// Freeze: tap the team whose buzzer is off for this question (tap it again to take it back).
function freezeStage() {
  return [
    h('div', { class: 'big' }, `🧊 ${t('freezeChoose')}`),
    h('p', { class: 'small' }, view.frozen ? t('freezeChosen', { name: nameOf(view.frozen) }) : t('freezeChooseSmall')),
    h(
      'div',
      { class: 'freeze-teams' },
      view.teams
        .filter((tm) => tm.id !== view.you.id)
        .map((tm) =>
          h(
            'button',
            {
              class: `freeze-team${view.frozen === tm.id ? ' on' : ''}`,
              type: 'button',
              style: `--team: ${tm.color}; --team-ink: ${inkFor(tm.color)}`,
              'aria-pressed': String(view.frozen === tm.id),
              onclick: () => net.send({ type: 'freezePick', target: tm.id }),
            },
            view.frozen === tm.id ? `🧊 ${tm.name}` : tm.name,
          ),
        ),
    ),
  ];
}

// ----- final round -----

function wagerStage() {
  const f = view.final;
  const head = [h('p', { class: 'kicker' }, t('finalRound')), h('div', { class: 'big' }, f.category)];
  if (f.maxWager === 0) {
    if (f.wager == null) net.send({ type: 'wager', amount: 0 });
    return [...head, h('p', { class: 'small' }, t('noPointsToBet'))];
  }
  const input = h('input', { id: 'bet', type: 'number', inputmode: 'numeric', min: 0, max: f.maxWager, step: 1, value: f.wager ?? '', 'aria-label': t('yourBet') });
  const quick = (label, amount) => h('button', { class: 'chip', type: 'button', onclick: () => ((input.value = amount), input.focus()) }, label);
  return [
    ...head,
    h(
      'form',
      {
        class: 'final-form',
        onsubmit: (e) => {
          e.preventDefault();
          const amount = Math.round(Number(input.value));
          if (!Number.isFinite(amount) || amount < 0 || amount > f.maxWager) return ($('#final-error').textContent = t('err-bad-wager'));
          net.send({ type: 'wager', amount });
          input.blur();
        },
      },
      h('label', { for: 'bet' }, t('yourBet'), ' ', h('span', { class: 'muted' }, t('youHave', { n: f.maxWager }))),
      input,
      h('div', { class: 'chips' }, quick(t('betNothing'), 0), quick(t('betHalf'), Math.floor(f.maxWager / 2)), quick(t('betAll'), f.maxWager)),
      h('p', { id: 'final-error', class: 'error', role: 'alert' }),
      h('button', { class: 'btn btn-ink', type: 'submit' }, t('placeBet')),
    ),
    f.wager != null ? h('p', { class: 'small' }, t('betPlaced', { n: f.wager })) : null,
  ];
}

function answerStage() {
  const f = view.final;
  const input = h('input', { id: 'final-answer', type: 'text', maxlength: 100, autocomplete: 'off', enterkeyhint: 'send', value: f.answer ?? '', 'aria-label': t('yourAnswer') });
  return [
    h('p', { class: 'kicker' }, `${t('finalRound')}: ${f.category}`),
    h(
      'form',
      {
        class: 'final-form',
        onsubmit: (e) => {
          e.preventDefault();
          net.send({ type: 'finalAnswer', text: input.value });
          input.blur();
        },
      },
      h('label', { for: 'final-answer' }, t('yourAnswer')),
      input,
      h('button', { class: 'btn btn-ink', type: 'submit' }, t('sendAnswer')),
    ),
    f.answer != null ? h('p', { class: 'small' }, t('answerSent')) : null,
    countdown(view),
  ];
}

// The stage is only rebuilt when something this team sees has changed. Other teams' bets and answers
// don't change it, so typing is never wiped out.
let stageKey = '';
function stageKeyFor() {
  const f = view.final;
  if (!view.canPick) pickCat = null;
  return JSON.stringify([
    view.lang, view.status, view.phase, view.buzzedTeam, view.event?.seq, view.you.score, view.deadline, f?.wager, f?.answer, f?.judged, f?.maxWager,
    view.picker, view.settings.phonePick, view.board, pickCat, view.betting, view.frozen,
    view.status === 'freezeChoose' ? view.teams.map((tm) => [tm.id, tm.name, tm.color]) : null,
  ]);
}

// One-off reactions to what just happened: shake for "too early" or "wrong", flash and buzz for "you're first".
function react() {
  const ev = view.event;
  if (!ev || ev.seq === lastSeq || !view.you) return;
  const first = lastSeq === 0;
  lastSeq = ev.seq;
  if (!first && ev.type === 'special') navigator.vibrate?.([80, 60, 80, 60, 250]);
  if (first || ev.teamId !== view.you.id) return;
  const team = $('#team');
  const again = (cls) => {
    team.classList.remove(cls);
    void team.offsetWidth; // restart the animation
    team.classList.add(cls);
  };
  if (ev.type === 'buzz') {
    again('first');
    navigator.vibrate?.(200);
  } else if (ev.type === 'boom') {
    again('shake');
    navigator.vibrate?.([600, 100, 300]);
  } else if (ev.type === 'early' || ev.type === 'wrong' || ev.type === 'timeup') {
    again('shake');
    navigator.vibrate?.([60, 60, 60]);
  }
}

function render() {
  if (view) setLang(view.lang);
  translatePage();
  const me = view?.you;
  const showJoin = welcomed && (!me || editing);

  $('#join').hidden = !showJoin;
  $('#team').hidden = showJoin || !me;
  document.body.style.background = me && !showJoin ? me.color : '';

  if (showJoin) {
    if (!$('#name').value && (me?.name || saved.name)) $('#name').value = me?.name ?? saved.name;
    renderSwatches();
    $('#join-btn').disabled = pendingJoin;
    $('#join-btn').textContent = pendingJoin ? t('joining') : me ? t('saveTeam') : t('joinButton');
    return;
  }
  if (!me) return;
  const team = $('#team');
  team.style.setProperty('--team', me.color);
  team.style.setProperty('--team-ink', inkFor(me.color));
  $('#me').textContent = me.name;
  $('#score').textContent = t('points', { n: me.score });
  const key = stageKeyFor();
  if (key !== stageKey) {
    stageKey = key;
    $('#stage').replaceChildren(...stage().filter(Boolean));
  }
  react();
}
