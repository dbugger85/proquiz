// A team's phone: join with a name and colour, then act as the buzzer.
import { COLORS, newColor, SHAPES, OPTION_COLORS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, guessLang, translatePage, secondsText } from './i18n.js';
import { $, h, inkFor, countdown, runCountdowns, setGlass, shapeSvg, optionStyle, setBrand } from './ui.js';
import { keepAwake } from './wake.js';
import { countTo, shownCount } from './rankanim.js';
import { AVATAR_PARTS, AVATAR_KEYS, isValidAvatar, randomAvatar } from '/lib/avatar.js';
import { avatarEl, avatarHtml, HAIR_COLORS } from './avatar.js';

const KEY = 'proquiz.team'; // { id, name, color, avatar } — survives reloads, so a phone re-joins as the same team

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
// Everyone has an avatar from the start: a random one on the first visit, remembered from then on.
if (!isValidAvatar(saved.avatar)) {
  saved = { ...saved, avatar: randomAvatar() };
  save(saved);
}
let view = null; // latest phoneView from the server
let welcomed = false; // the server has told us whether our saved team still exists
let editing = false; // the team is changing its name or colour
let pendingJoin = false;
let needPin = false; // joining over the internet, and the host has set a PIN
let brand = null; // the host's logo, event name and accent colour (brand.js)
let editingSeen = false; // the join form is showing (so the team's avatar was already put in it)
let shownScore = null; // { id, score } the header last showed, so new points can count up

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
      needPin = Boolean(msg.needPin);
      brand = msg.brand ?? null;
    }
    render();
  },
});

runCountdowns(net.now);

// Any tap keeps the screen on from then on (browsers need a tap before they allow it).
document.addEventListener('pointerdown', keepAwake);

// ----- join form -----

function renderSwatches() {
  // In a Quick quiz each phone is a player and colours may repeat.
  const taken = new Set(quick() ? [] : (view?.teams ?? []).filter((tm) => tm.id !== saved.id).map((tm) => tm.color));
  const box = $('#swatches');
  const current = box.querySelector('input:checked')?.value ?? newColor(saved.color);
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

// ----- the avatar (a player's face, or a team's mascot): a dice for a random one, or tap through the parts -----

let avatar = { ...saved.avatar }; // what the form shows (saved when joining)
let avatarPart = 'hair'; // the open tab
const pickedColor = () => $('#swatches input:checked')?.value ?? newColor(saved.color) ?? COLORS[0];

function setAvatar(a) {
  avatar = a;
  saved = { ...saved, avatar };
  save(saved);
  renderAvatar();
}

// One option tile: the whole avatar with just this part changed, so you see what you get.
// Hair colours are colour dots (they would all look the same on a bald head).
function avatarOption(part, n) {
  const on = avatar[part] === n;
  const label = t('avatarOption', { part: t(`avatar-${part}`), n: n + 1 });
  const tile = h('button', { class: `avatar-opt${on ? ' on' : ''}`, type: 'button', role: 'radio', 'aria-checked': String(on), 'aria-label': label, onclick: () => setAvatar({ ...avatar, [part]: n }) });
  if (part === 'hairColor') tile.append(h('span', { class: 'avatar-dot', style: `--dot: ${HAIR_COLORS[n][0]}` }));
  else tile.append(avatarEl({ ...avatar, [part]: n }));
  return tile;
}

function renderAvatar() {
  const color = pickedColor();
  const board = !quick();
  $('#avatar-title').textContent = t(board ? 'avatarTitleTeam' : 'avatarTitle');
  const preview = $('#avatar-preview');
  preview.style.setProperty('--team', color);
  preview.innerHTML = avatarHtml(avatar);
  const builder = $('#avatar-builder');
  builder.style.setProperty('--team', color);
  const open = !builder.hidden;
  $('#avatar-edit').textContent = t(open ? 'avatarDone' : 'avatarCustomise');
  $('#avatar-edit').setAttribute('aria-expanded', String(open));
  if (!open) return;
  $('#avatar-tabs').replaceChildren(
    ...AVATAR_KEYS.map((part) =>
      h('button', { class: `avatar-tab${part === avatarPart ? ' on' : ''}`, type: 'button', role: 'tab', 'aria-selected': String(part === avatarPart), onclick: () => ((avatarPart = part), renderAvatar()) }, t(`avatar-${part}`)),
    ),
  );
  const opts = $('#avatar-opts');
  opts.setAttribute('aria-label', t(`avatar-${avatarPart}`));
  opts.classList.toggle('dots', avatarPart === 'hairColor');
  opts.replaceChildren(...Array.from({ length: AVATAR_PARTS[avatarPart] }, (_, n) => avatarOption(avatarPart, n)));
}

$('#avatar-random').addEventListener('click', (e) => {
  // Never the same one twice in a row.
  let next;
  do next = randomAvatar();
  while (AVATAR_KEYS.every((k) => next[k] === avatar[k]));
  setAvatar(next);
  const dice = e.currentTarget;
  dice.classList.remove('roll');
  void dice.offsetWidth; // restart the little roll
  dice.classList.add('roll');
});
$('#avatar-edit').addEventListener('click', () => {
  $('#avatar-builder').hidden = !$('#avatar-builder').hidden;
  renderAvatar();
});

$('#join').addEventListener('submit', (e) => {
  e.preventDefault();
  const name = $('#name').value.trim();
  const color = $('#swatches input:checked')?.value;
  if (!name) return ($('#join-error').textContent = t('err-bad-name'));
  if (!color) return ($('#join-error').textContent = t('err-bad-color'));
  const pin = $('#pin').value.trim();
  if (needPin && !/^\d{4}$/.test(pin)) return ($('#join-error').textContent = t('err-bad-pin'));
  $('#join-error').textContent = '';
  saved = { ...saved, name, color, avatar };
  save(saved);
  pendingJoin = net.send({ type: 'join', name, color, avatar, teamId: saved.id, ...(needPin && { pin }) });
  render();
});

$('#swatches').addEventListener('change', () => {
  $('#join-error').textContent = '';
  renderAvatar(); // the avatar's background is the colour
});

// ----- the team screen -----

let lastSeq = 0; // last event we reacted to

function buzz(e) {
  e.preventDefault();
  // When the finger touched the screen, on this phone's stopwatch (for fair buzzing).
  const now = net.stamp();
  const at = e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now;
  if (net.send({ type: 'buzz', at })) {
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
const quick = () => view?.mode === 'quick';

function stage() {
  if (quick()) return quickStage();
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
  if (s === 'round2') {
    const mine = view.picker === me.id;
    return [h('div', { class: 'big' }, t('round2Phone')), h('p', { class: 'small' }, mine ? t('round2YouPick') : t('round2PicksFirst', { name: nameOf(view.picker) }))];
  }
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
  // Fair buzzing can find that a press came before the buzzers were on: too early, like while the host reads.
  if (s === 'armed') return [buzzer(true), ev?.type === 'early' && ev.teamId === me.id ? h('div', { class: 'big' }, t('tooEarly')) : null];
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

// ----- Quick quiz (multiple choice): big coloured shapes to press -----

let pressed = null; // the option pressed on this phone, until the server confirms it

function answer(e, option) {
  e.preventDefault();
  if (pressed !== null) return;
  // When the finger touched the screen, on this phone's stopwatch (for timing the answer fairly), as for a buzz.
  const now = net.stamp();
  const at = e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now;
  if (!net.send({ type: 'answer', option, at })) return;
  pressed = option;
  const grid = e.currentTarget.parentElement;
  for (const b of grid.children) b.classList.toggle(b === e.currentTarget ? 'chosen' : 'faded', true);
  navigator.vibrate?.(30);
}

const optionText = (i) => view.q?.options?.[i] ?? null;

function choiceButtons() {
  const q = view.q;
  return h(
    'div',
    { class: `choices n${q.n}${q.options ? ' with-text' : ''}` },
    Array.from({ length: q.n }, (_, i) =>
      h(
        'button',
        { class: 'choice', type: 'button', style: optionStyle(OPTION_COLORS[i]), 'aria-label': optionText(i) ?? t('quickOption', { n: i + 1 }), onpointerdown: (e) => answer(e, i) },
        shapeSvg(SHAPES[i]),
        optionText(i) ? h('span', { class: 'choice-text' }, optionText(i)) : null,
      ),
    ),
  );
}

// One option as a coloured chip: its shape (and its text when the phones get the text).
function optionChip(i, big = false) {
  return h('span', { class: `opt-chip${big ? ' big' : ''}`, style: optionStyle(OPTION_COLORS[i]) }, shapeSvg(SHAPES[i]), optionText(i) && !big ? h('span', {}, optionText(i)) : null);
}

const whereText = () => {
  const sec = view.sections[view.pos?.s];
  return sec ? t('quickQuestionOf', { n: view.pos.i + 1, total: sec.n }) : '';
};

function moved() {
  const before = view.rankBefore;
  if (!before || before === view.rank) return null;
  const up = view.rank < before;
  return h('p', { class: `moved ${up ? 'up' : 'down'}` }, `${up ? '▲' : '▼'} ${t(up ? 'quickMovedUp' : 'quickMovedDown', { n: Math.abs(before - view.rank) })}`);
}

// How far to the next place: "120 points behind Anna", "Level with Anna", or for the leader "80 points ahead of Ole".
// The other player's name is shown in their colour.
function gapLine() {
  const other = view.behind ?? view.ahead;
  if (!other) return null;
  const key = other.gap === 0 ? 'quickLevel' : view.behind ? 'quickBehind' : 'quickAheadOf';
  const [before, after] = t(key, { n: other.gap, name: '\u0000' }).split('\u0000');
  return h('p', { class: 'gap-line' }, before, h('span', { class: 'gap-name', style: `--team: ${other.color}; --team-ink: ${inkFor(other.color)}` }, avatarEl(other.avatar), other.name), after);
}

function quickStage() {
  const s = view.status;
  const q = view.q;
  if (s !== 'answer') pressed = null;
  if (s === 'lobby') {
    return [
      h('div', { class: 'big' }, t('youreIn')),
      h('p', { class: 'small' }, t('waitStart')),
      h('div', { class: 'shape-row', 'aria-hidden': 'true' }, SHAPES.map((sh, i) => h('span', { style: optionStyle(OPTION_COLORS[i]) }, shapeSvg(sh)))),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => ((editing = true), render()) }, t('changePlayer')),
    ];
  }
  if (s === 'section') {
    const sec = view.sections[view.pos?.s];
    const scored = view.teams.some((tm) => tm.score > 0);
    return [
      h('p', { class: 'kicker' }, t('quickSectionOf', { n: (view.pos?.s ?? 0) + 1, total: view.sections.length })),
      h('div', { class: 'big' }, sec?.name ?? ''),
      h('p', { class: 'small' }, t('quickNQuestions', { n: sec?.n ?? 0 })),
      scored ? h('p', { class: 'result' }, t('place', { n: view.rank, total: view.total })) : h('p', { class: 'small' }, t('lookTv')),
      scored ? gapLine() : null,
    ];
  }
  if (s === 'ready') {
    return [
      h('p', { class: 'kicker' }, whereText()),
      q?.question ? h('p', { class: 'phone-question' }, q.question) : h('div', { class: 'big' }, t('quickGetReady')),
      h('div', { class: 'ready-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('p', { class: 'small' }, q?.question ? t('quickGetReady') : t('quickReadTv')),
      countdown(view),
    ];
  }
  if (s === 'answer') {
    return [q.question ? h('p', { class: 'phone-question' }, q.question) : null, choiceButtons(), countdown(view)];
  }
  if (s === 'answered') {
    return [
      h('div', { class: 'locked-shape', style: optionStyle(OPTION_COLORS[q.mine]) }, shapeSvg(SHAPES[q.mine])),
      h('div', { class: 'big' }, t('quickLocked')),
      optionText(q.mine) ? h('p', { class: 'small' }, optionText(q.mine)) : null,
      h('p', { class: 'small' }, t('quickLockedSmall')),
      countdown(view),
    ];
  }
  if (s === 'result' || s === 'ranks') {
    const rights = [].concat(q?.correct ?? []); // one or more right options; any of them counts
    const right = q && q.mine !== null && rights.includes(q.mine);
    const none = q && q.mine === null;
    const verdict = !q
      ? null
      : h(
          'div',
          { class: `verdict-badge ${right ? 'right' : 'wrong'}` },
          h('span', { class: 'mark' }, right ? '✓' : '✗'),
        );
    if (s === 'result') {
      return [
        verdict,
        q.fastest ? h('p', { class: 'fastest-badge' }, t('quickFastestYou')) : null,
        h('div', { class: 'big' }, right ? t('quickRight') : none ? t('quickTooSlow') : t('quickWrong')),
        right && q.points ? h('p', { class: 'result' }, t('quickPlus', { n: q.gained })) : null,
        !q.points ? h('p', { class: 'small' }, t('quickNoPointsQ')) : null,
        right && view.you.streak >= 2 && q.points ? h('p', { class: 'streak' }, `🔥 ${t('quickStreakN', { n: view.you.streak })}`) : null,
        !right ? h('div', { class: 'right-was' }, h('span', {}, t(rights.length > 1 ? 'quickRightWere' : 'quickRightWas')), h('div', { class: 'right-chips' }, rights.map((i) => optionChip(i)))) : null,
        q.points ? h('p', { class: 'small' }, t('place', { n: view.rank, total: view.total })) : null,
        q.points ? gapLine() : null,
      ];
    }
    return [
      h('div', { class: 'big' }, view.rank === 1 && view.you.score > 0 ? t('quickLeading') : t('place', { n: view.rank, total: view.total })),
      view.rank === 1 && view.you.score > 0 ? h('p', { class: 'small' }, t('place', { n: view.rank, total: view.total })) : null,
      moved(),
      gapLine(),
    ];
  }
  if (s === 'over') {
    const medal = ['🥇', '🥈', '🥉'][view.rank - 1];
    return [medal ? h('div', { class: 'medal' }, medal) : null, h('div', { class: 'big' }, t('gameOver')), h('p', { class: 'result' }, t('place', { n: view.rank, total: view.total }))];
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
  if (quick()) return JSON.stringify([view.lang, view.status, view.pos, view.q, view.rank, view.rankBefore, view.total, view.you, view.deadline, view.sections, view.behind, view.ahead, view.status === 'section' ? view.teams.some((tm) => tm.score > 0) : null]);
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
  const team = $('#team');
  const again = (cls) => {
    team.classList.remove(cls);
    void team.offsetWidth; // restart the animation
    team.classList.add(cls);
  };
  // Quick quiz: the result is the same event for everyone; each phone compares its own answer.
  if (!first && ev.type === 'quickResult' && view.q) {
    const right = view.q.mine !== null && [].concat(view.q.correct ?? []).includes(view.q.mine);
    if (right) {
      again('cheer');
      navigator.vibrate?.([60, 40, 60, 40, 160]);
    } else {
      again('shake');
      navigator.vibrate?.([300]);
    }
    return;
  }
  if (first || ev.teamId !== view.you.id) return;
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
  if (view) setGlass(view.settings.glass);
  setBrand(brand);
  $('#brand-name').textContent = brand?.name ?? '';
  $('#brand-name').hidden = !brand?.name;
  translatePage();
  const me = view?.you;
  const showJoin = welcomed && (!me || editing);

  $('#join').hidden = !showJoin;
  $('#team').hidden = showJoin || !me;
  document.body.dataset.mode = view?.mode ?? 'board';
  document.body.style.background = me && !showJoin ? me.color : '';

  if (showJoin) {
    // A Quick quiz is played one phone per player: "Your name" instead of "Team name".
    $('#name-label').textContent = t(quick() ? 'yourName' : 'teamName');
    $('#name').placeholder = t(quick() ? 'yourNamePlaceholder' : 'teamNamePlaceholder');
    if (!$('#name').value && (me?.name || saved.name)) $('#name').value = me?.name ?? saved.name;
    renderSwatches();
    if (me?.avatar && !editingSeen) avatar = { ...me.avatar }; // changing a team that joined on another phone or before
    editingSeen = true;
    renderAvatar();
    $('#pin-field').hidden = !needPin;
    $('#join-btn').disabled = pendingJoin;
    $('#join-btn').textContent = pendingJoin ? t('joining') : me ? t('saveTeam') : t('joinButton');
    return;
  }
  editingSeen = false;
  if (!me) return;
  const team = $('#team');
  team.style.setProperty('--team', me.color);
  team.style.setProperty('--team-ink', inkFor(me.color));
  const meKey = JSON.stringify([me.name, me.avatar]);
  if ($('#me').dataset.key !== meKey) {
    $('#me').dataset.key = meKey;
    $('#me').replaceChildren(...[avatarEl(me.avatar, 'me-avatar'), h('span', { class: 'me-name' }, me.name)].filter(Boolean));
  }
  // New points count up (or down) to the new score.
  if (shownScore?.id === me.id && shownScore.score !== me.score) countTo('score', shownCount('score', shownScore.score), me.score, { ms: 600, tick: false, format: (n) => t('points', { n }) });
  shownScore = { id: me.id, score: me.score };
  $('#score').textContent = t('points', { n: shownCount('score', me.score) });
  const key = stageKeyFor();
  if (key !== stageKey) {
    stageKey = key;
    $('#stage').replaceChildren(...stage().filter(Boolean));
  }
  react();
}
