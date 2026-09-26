// The host laptop: lobby with settings, then the game controls.
import { connect } from './net.js';
import { t, setLang, translatePage } from './i18n.js';
import { $, h, inkFor, qrSvg, shortUrl } from './ui.js';

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

const cmd = (action) => net.send({ type: 'cmd', action });

function showError(text) {
  const el = $('#host-error');
  el.textContent = text;
  el.hidden = !text;
}

function renderQr() {
  if (!info) return;
  if (info.phoneUrl) {
    $('#qr').replaceChildren(qrSvg(info.phoneUrl));
    $('#url').textContent = shortUrl(info.phoneUrl);
  } else {
    $('#qr').replaceChildren();
    $('#url').textContent = t('noNetwork');
  }
}

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
        { class: 'plate', style: `--team: ${team.color}; --team-ink: ${inkFor(team.color)}` },
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

// ----- everything -----

function render() {
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
    // The board and question controls arrive in the next build step.
    $('#game').replaceChildren(h('p', { style: 'padding: 2rem' }, `Phase: ${view.phase}`));
  }
}
