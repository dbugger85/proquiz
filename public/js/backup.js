// The backup reminder on the website (docs/dev/web-plan.md §2, the owner's decision 9): the host's quizzes live only
// in this browser, so the editor and the host lobby show a banner (`#backup`) when there is at least one own quiz
// and nothing was exported for 30 days (or ever), or the browser won't promise to keep the storage. Its button is
// "Export all quizzes" (every export counts as a backup); "Not now" hides it for this visit. Nothing on the laptop.
import { t } from './i18n.js';
import { $ } from './ui.js';
import { api, store } from './quizapi.js';

const LATER = 'proquiz.backupLater'; // sessionStorage: "Not now" was pressed
let wired = false;

export async function refreshBackup() {
  const el = $('#backup');
  if (!el || !store) return;
  if (!wired) {
    wired = true;
    $('#backup-export').addEventListener('click', async () => {
      try {
        await api.exportDownload(null);
      } catch {
        // nothing to export, or the browser refused the download
      }
      refreshBackup();
    });
    $('#backup-close').addEventListener('click', () => {
      try {
        sessionStorage.setItem(LATER, '1');
      } catch {
        // no storage: hidden until the next load
      }
      el.hidden = true;
    });
  }
  let status;
  try {
    status = await store.backupStatus();
  } catch {
    return;
  }
  let later = false;
  try {
    later = sessionStorage.getItem(LATER) === '1';
  } catch {
    later = false;
  }
  el.hidden = !status.remind || later;
  if (el.hidden) return;
  $('#backup-title').textContent = t(status.due ? 'backupTitle' : 'backupKeepTitle');
  const lines = [];
  if (status.due) lines.push(status.lastExport ? t('backupOld', { days: status.days }) : t('backupNever'));
  if (!status.persisted) lines.push(t('storageNotKept'));
  if (status.safari) lines.push(t('backupSafari'));
  $('#backup-note').textContent = lines.join(' ');
}
