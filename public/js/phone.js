// A team's phone: join with a name and colour, then act as the buzzer.
import { COLORS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, guessLang, translatePage } from './i18n.js';
import { $, h, inkFor, countdown, runCountdowns } from './ui.js';

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

function buzzer(live) {
  return h(
    'button',
    { class: `buzzer${live ? ' live' : ''}`, type: 'button', onpointerdown: buzz, 'aria-label': t('buzz') },
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
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => ((editing = true), render()) }, t('changeTeam')),
    ];
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
  if (s === 'wager' || s === 'finalAnswer' || s === 'finalWait') {
    return [h('div', { class: 'big' }, t('finalComing'))]; // the final round screens arrive in a later step
  }
  // waiting: board, reading or revealed. While the host reads, the (dim) buzzer is there, but pressing it is too early.
  if (view.phase === 'reading') {
    const early = ev?.type === 'early' && ev.teamId === me.id;
    return [buzzer(false), early ? h('div', { class: 'big' }, t('tooEarly')) : h('p', { class: 'small' }, t('getReady'))];
  }
  if (view.phase === 'revealed' && ev?.type === 'correct' && ev.teamId === me.id) {
    return [h('div', { class: 'big' }, t('gotIt'))];
  }
  return [h('p', { class: 'small' }, t('waitNext'))];
}

// One-off reactions to what just happened: shake for "too early" or "wrong", flash and buzz for "you're first".
function react() {
  const ev = view.event;
  if (!ev || ev.seq === lastSeq || !view.you) return;
  const first = lastSeq === 0;
  lastSeq = ev.seq;
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
  $('#stage').replaceChildren(...stage());
  react();
}
