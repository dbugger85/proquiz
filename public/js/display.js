// The TV screen. Shows the game to the room; never gets an answer before the host reveals it.
import { connect } from './net.js';
import { t, setLang, translatePage } from './i18n.js';
import { $, h, inkFor, qrSvg, shortUrl } from './ui.js';

let view = null;
let connected = new Set();
let info = null;
const seen = new Set(); // teams already on screen, so only new ones pop in

connect({
  role: 'display',
  onMessage(msg) {
    if (msg.type === 'welcome') info = msg.info;
    if (msg.type === 'state') {
      view = msg.view;
      connected = new Set(msg.connected);
    }
    if (view) render();
  },
});

// F for full screen (the TV window has no controls).
document.addEventListener('keydown', (e) => {
  if (e.key === 'f' || e.key === 'F') {
    if (document.fullscreenElement) document.exitFullscreen();
    else document.documentElement.requestFullscreen().catch(() => {});
  }
});

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
      return h(
        'li',
        {
          class: `plate${isNew ? ' new' : ''}${connected.has(team.id) ? '' : ' away'}`,
          style: `--team: ${team.color}; --team-ink: ${inkFor(team.color)}`,
        },
        team.name,
      );
    }),
  );
}

function render() {
  setLang(view.settings.lang);
  translatePage();
  const inLobby = view.phase === 'lobby';
  $('#lobby').hidden = !inLobby;
  $('#game').hidden = inLobby;
  if (inLobby) renderLobby();
  else $('#game').replaceChildren(h('p', { class: 'tv-note' }, view.set.title));
}
