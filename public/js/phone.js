// A team's phone: join with a name and colour, then act as the buzzer.
import { COLORS, newColor, SHAPES, OPTION_COLORS, REACTIONS } from '/lib/game.js';
import { connect } from './net.js';
import { t, pts, setLang, guessLang, translatePage, secondsText } from './i18n.js';
import { $, h, fill, inkFor, countdown, runCountdowns, setGlass, shapeSvg, optionStyle, setBrand, longWord } from './ui.js';
import { keepAwake } from './wake.js';
import { countTo, shownCount } from './rankanim.js';
import { AVATAR_PARTS, AVATAR_KEYS, isValidAvatar, randomAvatar } from '/lib/avatar.js';
import { avatarEl, avatarHtml, HAIR_COLORS } from './avatar.js';
import { languageName, flagUrl, browserLang, isLanguage } from '/lib/languages.js';

const KEY = 'proquiz.team'; // { id, name, color, avatar } — survives reloads, so a phone re-joins as the same team
const LANG_KEY = 'proquiz.team.lang'; // the language this phone reads the questions in (a quiz with extra languages)

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

// ----- the language this phone reads the questions in (lib/languages.js) -----
// Only when the quiz has extra languages and the host's switch is on (`view.languages` = { main, extra }). The choice is
// remembered on the phone. The phone's own buttons follow it only when it is English or Norwegian.
function savedLang() {
  try {
    const v = localStorage.getItem(LANG_KEY);
    return isLanguage(v) ? v : null;
  } catch {
    return null;
  }
}
function saveLang(code) {
  try {
    if (code) localStorage.setItem(LANG_KEY, code);
    else localStorage.removeItem(LANG_KEY);
  } catch {}
}
const offeredLangs = () => (view?.languages ? [view.languages.main, ...view.languages.extra] : []);
// What this phone has chosen (or would choose): the remembered one if the quiz has it, else the phone's own language
// if the quiz has it, else the main language. Null when there is no choice to make.
function chosenLang() {
  const offered = offeredLangs();
  if (!offered.length) return null;
  const mine = view?.you?.lang;
  for (const code of [mine, savedLang(), browserLang(navigator.language)]) if (code && offered.includes(code)) return code;
  return offered[0];
}
// The language of the phone's own buttons and messages: the host's setting, unless this phone reads the quiz in
// another language than the main one and that language is one of ours (English or Norwegian).
function uiLang() {
  const chosen = chosenLang();
  return chosen && chosen !== view.languages?.main && ['en', 'no'].includes(chosen) ? chosen : view.lang;
}
const flagImg = (code, cls = 'flag') => h('img', { class: cls, src: flagUrl(code), alt: '', 'aria-hidden': 'true' });
// A pill per offered language, with its flag. `onPick(code)` when one is chosen.
function langPills(name, current, onPick) {
  return offeredLangs().map((code) =>
    h(
      'label',
      {},
      h('input', { type: 'radio', name, value: code, checked: code === current, onchange: () => onPick(code) }),
      h('span', { lang: code }, flagImg(code), languageName(code)),
    ),
  );
}

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
    } else if (msg.type === 'bye') {
      // The host quit ProQuiz: one plain message, and net.js never connects again.
      $('#stopped').hidden = false;
      translatePage();
      return;
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
  // The quiz's language this phone reads in (only when the form offered the choice).
  const lang = $('#lang-field').hidden ? null : ($('#lang-pills input:checked')?.value ?? null);
  if (lang) saveLang(lang);
  pendingJoin = net.send({ type: 'join', name, color, avatar, teamId: saved.id, ...(lang && { lang }), ...(needPin && { pin }) });
  render();
});

// The join form's "Read questions in:" pills (only when the quiz offers a choice).
function renderLangField() {
  const field = $('#lang-field');
  const offered = offeredLangs();
  field.hidden = offered.length === 0;
  if (field.hidden) return;
  const current = $('#lang-pills input:checked')?.value;
  const key = `${offered.join(',')}|${current ?? chosenLang()}|${view.lang}`;
  if (field.dataset.key === key) return;
  field.dataset.key = key;
  fill($('#lang-pills'), langPills('quizLang', offered.includes(current) ? current : chosenLang(), () => {}));
}

// The flag pill in the header (once in the game): tap for the list, pick one and the server sends the texts in it.
function renderLangPill() {
  const pill = $('#lang-pill');
  const menu = $('#lang-menu');
  const offered = offeredLangs();
  pill.hidden = offered.length === 0;
  if (pill.hidden) {
    menu.hidden = true;
    pill.setAttribute('aria-expanded', 'false');
    return;
  }
  const chosen = chosenLang();
  const key = `${offered.join(',')}|${chosen}|${view.lang}`;
  if (pill.dataset.key === key) return;
  pill.dataset.key = key;
  pill.setAttribute('aria-label', t('readInNow', { lang: languageName(chosen) }));
  pill.title = t('readInNow', { lang: languageName(chosen) });
  fill(pill, flagImg(chosen), h('span', { class: 'lang-code' }, chosen.toUpperCase()));
  fill(
    menu.querySelector('.pills'),
    langPills('quizLangNow', chosen, (code) => {
      saveLang(code);
      net.send({ type: 'language', lang: code });
      menu.hidden = true;
      pill.setAttribute('aria-expanded', 'false');
      pill.dataset.key = ''; // redraw with the new flag as soon as the server answers
    }),
  );
}
$('#lang-pill').addEventListener('click', () => {
  const menu = $('#lang-menu');
  menu.hidden = !menu.hidden;
  $('#lang-pill').setAttribute('aria-expanded', String(!menu.hidden));
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

// A phone that reads the quiz in another language (view.textLang, see wantsText() in game.js): the question while
// the TV shows it, and the answer once it is revealed. Translated text may run right to left, so dir="auto".
function textBlock() {
  const x = view.text;
  if (!x?.question && !x?.answer) return null;
  return h(
    'div',
    { class: 'phone-text', lang: view.textLang },
    x.question ? h('p', { class: 'phone-question', dir: 'auto' }, x.question) : null,
    x.answer ? h('p', { class: 'phone-answer', dir: 'auto' }, h('span', {}, `${t('answerLabel')}:`), ' ', x.answer) : null,
  );
}

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
    return [h('div', { class: 'big' }, '💥'), h('div', { class: 'big' }, t('boomYou', { n: pts(ev.amount ?? 0) }))];
  }
  // Fair buzzing can find that a press came before the buzzers were on: too early, like while the host reads.
  if (s === 'armed') return [textBlock(), buzzer(true), ev?.type === 'early' && ev.teamId === me.id ? h('div', { class: 'big' }, t('tooEarly')) : null];
  if (s === 'first') return [textBlock(), h('div', { class: 'big' }, t('youreFirst')), h('p', { class: 'small' }, t('answerNow')), countdown(view)];
  if (s === 'other') return [textBlock(), h('div', { class: 'big' }, t('otherFirst', { name: nameOf(view.buzzedTeam) }))];
  if (s === 'locked') return [textBlock(), h('p', { class: 'small' }, t('lockedOut'))];
  if (s === 'over') {
    const ranked = [...view.teams].sort((a, b) => b.score - a.score);
    const place = ranked.findIndex((tm) => tm.score === me.score) + 1;
    return [h('div', { class: 'big' }, t('gameOver')), h('p', { class: 'result' }, t('place', { n: place, total: ranked.length }))];
  }
  if (s === 'wager') return wagerStage();
  if (s === 'finalAnswer') return answerStage();
  if (s === 'finalWait') {
    const f = view.final;
    // In another language: the final's question, and its answer once the TV shows it.
    const finalText = f.question || f.rightAnswer ? h('div', { class: 'phone-text', lang: view.textLang }, f.question ? h('p', { class: 'phone-question', dir: 'auto' }, f.question) : null, f.rightAnswer ? h('p', { class: 'phone-answer', dir: 'auto' }, h('span', {}, `${t('answerLabel')}:`), ' ', f.rightAnswer) : null) : null;
    if (f.judged === null) return [finalText, h('div', { class: 'big' }, t('waitJudging')), f.answer ? h('p', { class: 'small' }, t('youAnswered', { text: f.answer })) : null];
    return [finalText, h('div', { class: 'big' }, f.judged ? t('finalRight', { n: pts(f.wager ?? 0) }) : t('finalWrong', { n: pts(f.wager ?? 0) }))];
  }
  // waiting: board, reading or revealed. While the host reads, the (dim) buzzer is there, but pressing it is too early.
  if (view.phase === 'reading') {
    const early = ev?.type === 'early' && ev.teamId === me.id;
    return [textBlock(), buzzer(false), early ? h('div', { class: 'big' }, t('tooEarly')) : h('p', { class: 'small' }, t('getReady'))];
  }
  if (view.phase === 'revealed' && ev?.type === 'correct' && ev.teamId === me.id) {
    return [h('div', { class: 'big' }, t('gotIt')), textBlock()];
  }
  if (view.phase === 'revealed' && view.text) return [textBlock(), h('p', { class: 'small' }, t('waitNext'))];
  if (view.phase === 'board' && view.canPick) return pickStage();
  if (view.phase === 'board' && view.settings.phonePick && view.picker && view.picker !== me.id) {
    return [h('p', { class: 'small' }, t('otherPicks', { name: nameOf(view.picker) }))];
  }
  return [h('p', { class: 'small' }, t('waitNext'))];
}

// ----- Quick quiz (multiple choice): big coloured shapes to press -----
// Three kinds of question (`q.type`): 'choice' (press one shape and it's sent), 'multi' (tick every right one,
// then Submit) and 'order' (tap the shapes in order, each gets its number, then Submit). The ticks and numbers
// live in `draft` until the server confirms the answer, so a redraw of the stage doesn't lose them.

let draft = { picks: [], sent: false }; // this phone's ticks (or tap order) for the question showing

// The moment the finger touched the screen, on this phone's stopwatch (for timing the answer fairly), as for a buzz.
function pressAt(e) {
  const now = net.stamp();
  return e.timeStamp > 0 && Math.abs(now - e.timeStamp) < 1000 ? e.timeStamp : now;
}

// Sends the answer once: `{ option }`, `{ options }` or `{ order }`.
function sendAnswer(e, payload) {
  if (draft.sent) return false;
  if (!net.send({ type: 'answer', ...payload, at: pressAt(e) })) return false;
  draft.sent = true;
  navigator.vibrate?.(30);
  return true;
}

function answer(e, option) {
  e.preventDefault();
  if (!sendAnswer(e, { option })) return;
  const grid = e.currentTarget.parentElement;
  for (const b of grid.children) b.classList.toggle(b === e.currentTarget ? 'chosen' : 'faded', true);
}

const optionText = (i) => view.q?.options?.[i] ?? null;

// A "tick all" or "put in order" question: a tap ticks a shape (or gives it the next number; tapping a numbered
// one takes its number and every later one away), and Submit sends them all.
function togglePick(i, grid, bar) {
  if (draft.sent) return;
  const type = view.q.type;
  const k = draft.picks.indexOf(i);
  if (k < 0) draft.picks = [...draft.picks, i];
  else draft.picks = type === 'order' ? draft.picks.slice(0, k) : draft.picks.filter((p) => p !== i);
  navigator.vibrate?.(15);
  showPicks(grid, bar);
}

// Puts the ticks or numbers from `draft` on the tiles, and lets Submit go once the answer is complete.
function showPicks(grid, bar) {
  const q = view.q;
  [...grid.children].forEach((b, i) => {
    const k = draft.picks.indexOf(i);
    b.classList.toggle('ticked', k >= 0);
    b.setAttribute('aria-pressed', k >= 0 ? 'true' : 'false');
    b.querySelector('.pick-badge').textContent = k < 0 ? '' : q.type === 'order' ? String(k + 1) : '✓';
  });
  const complete = q.type === 'order' ? draft.picks.length === q.n : draft.picks.length > 0;
  bar.querySelector('#submit-answers').disabled = !complete || draft.sent;
  const clear = bar.querySelector('#clear-picks');
  if (clear) clear.disabled = draft.picks.length === 0 || draft.sent;
}

// The answer buttons (and, for the kinds with a Submit button, the bar under them), as a list of elements.
function choiceButtons() {
  const q = view.q;
  const picking = q.type === 'multi' || q.type === 'order';
  const grid = h(
    'div',
    { class: `choices n${q.n}${q.options ? ' with-text' : ''}${picking ? ' picking' : ''}` },
    Array.from({ length: q.n }, (_, i) =>
      h(
        'button',
        {
          class: 'choice',
          type: 'button',
          style: optionStyle(OPTION_COLORS[i]),
          'aria-label': optionText(i) ?? t('quickOption', { n: i + 1 }),
          ...(picking ? { onclick: () => togglePick(i, grid, bar) } : { onpointerdown: (e) => answer(e, i) }),
        },
        picking ? h('span', { class: 'pick-badge', 'aria-hidden': 'true' }) : null,
        shapeSvg(SHAPES[i]),
        optionText(i) ? h('span', { class: `choice-text${longWord(optionText(i))}`, dir: 'auto' }, optionText(i)) : null,
      ),
    ),
  );
  if (!picking) return [grid];
  const submit = (e) => {
    const payload = q.type === 'order' ? { order: draft.picks } : { options: draft.picks };
    if (sendAnswer(e, payload)) showPicks(grid, bar);
  };
  const bar = h(
    'div',
    { class: 'answer-bar' },
    h('p', { class: 'small' }, t(q.type === 'order' ? 'quickOrderHint' : 'quickTickHint')),
    h(
      'div',
      { class: 'answer-bar-btns' },
      q.type === 'order' ? h('button', { class: 'btn btn-quiet', type: 'button', id: 'clear-picks', onclick: () => ((draft.picks = []), showPicks(grid, bar)) }, t('quickClear')) : null,
      h('button', { class: 'btn btn-ink', type: 'button', id: 'submit-answers', onpointerdown: submit }, t('quickSubmit')),
    ),
  );
  showPicks(grid, bar);
  return [grid, bar];
}

// One option as a coloured chip: its shape (and its text when the phones get the text). `n` puts a number in
// front (a place in an order).
function optionChip(i, big = false, n = null) {
  return h(
    'span',
    { class: `opt-chip${big ? ' big' : ''}${n ? ' numbered' : ''}`, style: optionStyle(OPTION_COLORS[i]) },
    n ? h('b', { class: 'chip-n' }, String(n)) : null,
    shapeSvg(SHAPES[i]),
    optionText(i) && !big ? h('span', { dir: 'auto' }, optionText(i)) : null,
  );
}

// The chips for an answer: ticks as a row, an order as a numbered list.
const answerChips = (q, a) => (q.type === 'order' ? a.order.map((p, k) => optionChip(p, false, k + 1)) : q.type === 'multi' ? a.options.map((p) => optionChip(p)) : [optionChip(a.option)]);

// Is my own answer right? (`correct` is the right options, or for "put in order" the right order.)
function mineRight(q) {
  const rights = [].concat(q?.correct ?? []);
  const m = q?.mine;
  if (!m) return false;
  const same = (list) => Array.isArray(list) && list.length === rights.length && list.every((x, k) => x === rights[k]);
  if (q.type === 'multi') return same(m.options);
  if (q.type === 'order') return same(m.order);
  return rights.includes(m.option);
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
  const [before, after] = t(key, { n: pts(other.gap), name: '\u0000' }).split('\u0000');
  return h('p', { class: 'gap-line' }, before, h('span', { class: 'gap-name', style: `--team: ${other.color}; --team-ink: ${inkFor(other.color)}` }, avatarEl(other.avatar), other.name), after);
}

// Emoji reactions after a question (lobby setting `quickReactions`): a tap sends the emoji's index, and the TV
// shows it with the player's name. One a second (the server drops extra ones too); the tapped one bounces.
let reactedAt = 0;
function reactionRow() {
  if (!view.settings.quickReactions) return null;
  return h(
    'div',
    { class: 'reactions', role: 'group', 'aria-label': t('sendReaction') },
    REACTIONS.map((emoji, i) =>
      h(
        'button',
        {
          class: 'reaction-btn',
          type: 'button',
          'aria-label': `${t('sendReaction')}: ${emoji}`,
          onclick: (e) => {
            const now = Date.now();
            if (now - reactedAt < 1000 || !net.send({ type: 'react', emoji: i })) return;
            reactedAt = now;
            const btn = e.currentTarget;
            btn.classList.remove('sent');
            void btn.offsetWidth; // restart the bounce
            btn.classList.add('sent');
            navigator.vibrate?.(30);
          },
        },
        emoji,
      ),
    ),
  );
}

function quickStage() {
  const s = view.status;
  const q = view.q;
  if (s !== 'answer') draft = { picks: [], sent: false };
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
      h('div', { class: 'big', dir: 'auto' }, sec?.name ?? ''),
      h('p', { class: 'small' }, t('quickNQuestions', { n: sec?.n ?? 0 })),
      scored ? h('p', { class: 'result' }, t('place', { n: view.rank, total: view.total })) : h('p', { class: 'small' }, t('lookTv')),
      scored ? gapLine() : null,
    ];
  }
  if (s === 'ready') {
    return [
      h('p', { class: 'kicker' }, whereText()),
      q?.question ? h('p', { class: 'phone-question', dir: 'auto' }, q.question) : h('div', { class: 'big' }, t('quickGetReady')),
      h('div', { class: 'ready-dots', 'aria-hidden': 'true' }, h('span'), h('span'), h('span')),
      h('p', { class: 'small' }, q?.question ? t('quickGetReady') : t('quickReadTv')),
      countdown(view),
    ];
  }
  if (s === 'answer') {
    return [q.question ? h('p', { class: 'phone-question', dir: 'auto' }, q.question) : null, ...choiceButtons(), countdown(view)];
  }
  if (s === 'answered') {
    const one = q.type !== 'multi' && q.type !== 'order';
    return [
      one ? h('div', { class: 'locked-shape', style: optionStyle(OPTION_COLORS[q.mine.option]) }, shapeSvg(SHAPES[q.mine.option])) : null,
      h('div', { class: 'big' }, t('quickLocked')),
      one ? (optionText(q.mine.option) ? h('p', { class: 'small', dir: 'auto' }, optionText(q.mine.option)) : null) : h('div', { class: `right-chips${q.type === 'order' ? ' as-list' : ''}` }, answerChips(q, q.mine)),
      h('p', { class: 'small' }, t('quickLockedSmall')),
      countdown(view),
    ];
  }
  if (s === 'result' || s === 'ranks') {
    const rights = [].concat(q?.correct ?? []); // the right options (any of them counts for 'choice'), or the right order
    const right = mineRight(q);
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
        right && q.points ? h('p', { class: 'result' }, t('quickPlus', { n: pts(q.gained) })) : null,
        !q.points ? h('p', { class: 'small' }, t('quickNoPointsQ')) : null,
        right && view.you.streak >= 2 && q.points ? h('p', { class: 'streak' }, `🔥 ${t('quickStreakN', { n: view.you.streak })}`) : null,
        !right && q.type === 'order'
          ? h('div', { class: 'right-was' }, h('span', {}, t('quickRightOrder')), h('div', { class: 'right-chips as-list' }, rights.map((p, k) => optionChip(p, false, k + 1))))
          : !right
            ? h('div', { class: 'right-was' }, h('span', {}, t(rights.length > 1 ? 'quickRightWere' : 'quickRightWas')), h('div', { class: 'right-chips' }, rights.map((i) => optionChip(i))))
            : null,
        q.points ? h('p', { class: 'small' }, t('place', { n: view.rank, total: view.total })) : null,
        q.points ? gapLine() : null,
        reactionRow(),
      ];
    }
    return [
      h('div', { class: 'big' }, view.rank === 1 && view.you.score > 0 ? t('quickLeading') : t('place', { n: view.rank, total: view.total })),
      view.rank === 1 && view.you.score > 0 ? h('p', { class: 'small' }, t('place', { n: view.rank, total: view.total })) : null,
      moved(),
      gapLine(),
      reactionRow(),
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
          pts(value),
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
      h('label', { for: 'double-bet' }, t('doubleAsk'), ' ', h('span', { class: 'muted' }, t('doubleUpTo', { n: pts(b.max) }))),
      input,
      h('div', { class: 'chips' }, quick(t('doubleTile', { n: pts(b.value) }), b.value), quick(t('betHalf'), Math.floor(b.max / 2)), quick(t('betAll'), b.max)),
      h('p', { id: 'final-error', class: 'error', role: 'alert' }),
      h('button', { class: 'btn btn-ink', type: 'submit' }, t('placeBet')),
    ),
    b.bet != null ? h('p', { class: 'small' }, t('doubleBetPlaced', { n: pts(b.bet) })) : null,
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
      h('label', { for: 'bet' }, t('yourBet'), ' ', h('span', { class: 'muted' }, t('youHave', { n: pts(f.maxWager) }))),
      input,
      h('div', { class: 'chips' }, quick(t('betNothing'), 0), quick(t('betHalf'), Math.floor(f.maxWager / 2)), quick(t('betAll'), f.maxWager)),
      h('p', { id: 'final-error', class: 'error', role: 'alert' }),
      h('button', { class: 'btn btn-ink', type: 'submit' }, t('placeBet')),
    ),
    f.wager != null ? h('p', { class: 'small' }, t('betPlaced', { n: pts(f.wager) })) : null,
  ];
}

function answerStage() {
  const f = view.final;
  const input = h('input', { id: 'final-answer', type: 'text', maxlength: 100, autocomplete: 'off', enterkeyhint: 'send', value: f.answer ?? '', 'aria-label': t('yourAnswer') });
  return [
    h('p', { class: 'kicker' }, `${t('finalRound')}: ${f.category}`),
    f.question ? h('p', { class: 'phone-question', dir: 'auto', lang: view.textLang }, f.question) : null, // in another language (wantsText)
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
  if (quick()) return JSON.stringify([uiLang(), view.textLang, view.status, view.pos, view.q, view.rank, view.rankBefore, view.total, view.you, view.deadline, view.sections, view.behind, view.ahead, view.settings.quickReactions, view.status === 'section' ? view.teams.some((tm) => tm.score > 0) : null]);
  const f = view.final;
  if (!view.canPick) pickCat = null;
  return JSON.stringify([
    uiLang(), view.textLang, view.text, view.status, view.phase, view.buzzedTeam, view.event?.seq, view.you.score, view.deadline, f?.wager, f?.answer, f?.judged, f?.maxWager, f?.question, f?.rightAnswer, f?.category,
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
    if (mineRight(view.q)) {
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

// The name in the header wraps between words only (style.css). A word too wide for the room beside the score pill
// gets smaller text in two steps, and as a last resort the name ends in a … (never broken in the middle).
function fitName() {
  const name = $('#me .me-name');
  if (!name) return;
  name.classList.remove('smaller', 'smallest', 'cut');
  for (const step of ['smaller', 'smallest', 'cut']) {
    if (name.scrollWidth <= name.clientWidth + 1) return;
    name.classList.add(step);
  }
}
// The room for the name changes without a redraw too: the score pill widens while new points count up, the font
// arrives, or the phone turns.
new ResizeObserver(fitName).observe($('#me'));
addEventListener('resize', fitName);
document.fonts?.ready.then(fitName);

function render() {
  if (view) setLang(uiLang());
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
    renderLangField();
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
  renderLangPill();
  // New points count up (or down) to the new score.
  if (shownScore?.id === me.id && shownScore.score !== me.score) countTo('score', shownCount('score', shownScore.score), me.score, { ms: 600, tick: false, format: (n) => t('points', { n: pts(n) }) });
  shownScore = { id: me.id, score: me.score };
  $('#score').textContent = t('points', { n: pts(shownCount('score', me.score)) });
  fitName();
  const key = stageKeyFor();
  if (key !== stageKey) {
    stageKey = key;
    $('#stage').replaceChildren(...stage().filter(Boolean));
  }
  react();
}
