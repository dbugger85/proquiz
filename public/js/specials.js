// Kaosmodus: how each special looks and what its rule says (shared by the TV, host and phones).
import { lastPlace, TURBO_COUNT } from '/lib/crazy.js';
import { t } from './i18n.js';

export const ICONS = { triple: '×3', bomb: '💣', hotseat: '🔥', rescue: '🛟', turbo: '⚡', jackpot: '💰', freeze: '🧊', double: '🎲' };

const nameOf = (view, id) => view.teams.find((tm) => tm.id === id)?.name ?? '';

// The one-line rule for the special of the open question.
export function ruleFor(view) {
  const q = view.q;
  const kind = q.special;
  const picker = nameOf(view, view.picker);
  switch (kind) {
    case 'triple':
      return t('r-triple');
    case 'bomb':
      return t('r-bomb', { name: picker, n: q.value });
    case 'hotseat':
      return t('r-hotseat', { name: picker });
    case 'rescue':
      return t('r-rescue', { name: q.solo ? nameOf(view, q.solo) : lastPlace(view.teams)?.name ?? '' });
    case 'turbo':
      return t('r-turbo', { name: picker, n: TURBO_COUNT });
    case 'jackpot':
      return t('r-jackpot', { n: q.pot ?? 0 });
    case 'freeze':
      return q.frozen ? t('frozenTeam', { name: nameOf(view, q.frozen) }) : t('r-freeze', { name: picker });
    case 'double':
      return q.bet != null ? t('r-double-bet', { name: picker, n: q.bet }) : t('r-double', { name: picker });
    default:
      return '';
  }
}

// A short badge for the question screen while a special is on ("×3", "🔥 Red", "⚡ 2/3", …).
export function badgeFor(view) {
  const q = view.q;
  if (!q?.special) return null;
  if (view.turbo) return `${ICONS.turbo} ${view.turbo.n}/${view.turbo.total}`;
  if (q.special === 'triple') return `${q.baseValue ?? q.value} ×3`;
  if (q.solo) return `${ICONS[q.special]} ${nameOf(view, q.solo)}`;
  if (q.special === 'jackpot') return `${ICONS.jackpot} +${q.pot ?? 0}`;
  if (q.special === 'freeze' && q.frozen) return `${ICONS.freeze} ${nameOf(view, q.frozen)}`;
  return ICONS[q.special];
}
