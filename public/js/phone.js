// A team's phone: join with a name and colour, then act as the buzzer.
import { COLORS } from '/lib/game.js';
import { connect } from './net.js';
import { t, setLang, guessLang, translatePage } from './i18n.js';
import { $, h, inkFor } from './ui.js';

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

function stage() {
  const s = view.status;
  if (s === 'lobby') {
    return [
      h('div', { class: 'big' }, t('youreIn')),
      h('p', { class: 'small' }, t('waitStart')),
      h('button', { class: 'btn btn-quiet', type: 'button', onclick: () => ((editing = true), render()) }, t('changeTeam')),
    ];
  }
  // The buzzer and the other states arrive in the next build steps.
  return [h('p', { class: 'small' }, t('waitStart'))];
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
}
