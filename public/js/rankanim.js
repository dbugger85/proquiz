// Numbers that count up, and the Quick quiz's top 5 shuffling into place (TV and phones).
// Only transform and opacity move and the numbers are plain text, so it stays cheap on a TV's browser.
// It follows the system's "reduce motion" setting: then everything shows its end state at once.
import { pts } from './i18n.js';

// The top 5 (ms): the old list settles in, the points count up, then the rows glide to their new places.
export const RANK_TIMES = { settle: 600, count: 900, move: 550, gap: 150 };
const MOVE_EASE = 'cubic-bezier(0.2, 1, 0.3, 1)';

export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (p) => 1 - (1 - p) ** 3;

// Runs frame(eased, p) on every animation frame for `ms` (after `delay`); returns a function that stops it.
export function tween(ms, frame, { delay = 0, done } = {}) {
  let raf = 0;
  let start = null;
  let stopped = false;
  const step = (now) => {
    if (stopped) return;
    start ??= now;
    const p = Math.min(1, (now - start) / ms);
    frame(easeOut(p), p);
    if (p < 1) raf = requestAnimationFrame(step);
    else done?.();
  };
  const timer = setTimeout(() => (raf = requestAnimationFrame(step)), delay);
  return () => {
    stopped = true;
    clearTimeout(timer);
    cancelAnimationFrame(raf);
  };
}

// ----- one soft tick for everything that is counting (not one per number) -----

let tickSound = null; // (progress 0–1) → plays a tick; set by the page that plays sounds
export const setTickSound = (fn) => (tickSound = fn);
const ticking = new Set(); // { p } of each count that ticks
let tickTimer = null;
function tickWhile(entry) {
  ticking.add(entry);
  tickTimer ??= setInterval(() => {
    if (!ticking.size) {
      clearInterval(tickTimer);
      tickTimer = null;
      return;
    }
    tickSound?.(Math.max(...[...ticking].map((e) => e.p)));
  }, 70);
}

// ----- numbers on screens that are redrawn often (the TV's score strip, the end screens, the phone's score) -----
// A count writes into whatever element has data-count="<key>" right now, so a redraw in the middle doesn't stop it.

const counts = new Map(); // key → { value, p, stop }

// What a number should show now: the running count's value, or the real one.
export const shownCount = (key, value) => counts.get(key)?.value ?? value;

export function countTo(key, from, to, { ms = 500, delay = 0, tick = true, format = pts } = {}) {
  counts.get(key)?.stop();
  if (from === to || reducedMotion()) return;
  const entry = { value: from, p: 0 };
  const write = () => {
    const el = document.querySelector(`[data-count="${CSS.escape(key)}"]`);
    if (el) el.textContent = format(entry.value);
  };
  const end = () => {
    ticking.delete(entry);
    if (counts.get(key) === entry) counts.delete(key);
  };
  const stop = tween(
    ms,
    (e, p) => {
      entry.value = Math.round(from + (to - from) * e);
      entry.p = p;
      write();
      if (tick && p < 1 && !ticking.has(entry)) tickWhile(entry);
    },
    { delay, done: end },
  );
  entry.stop = () => {
    stop();
    end();
  };
  counts.set(key, entry);
}

// ----- the top 5 -----

let running = null; // the top 5 animation on screen, so a redraw can stop it

export function cancelRanks() {
  running?.stop();
  running = null;
}

// `ol` holds a row (li[data-id]) for everyone in `before` (in that order, showing the old place in .rank-n and the
// old score in .rank-score) and, hidden with .waiting at the end, everyone who climbed into the top 5.
// Each row already has its new arrow and +points chip, hidden while the list has the class `animating`.
// `after` is the new top 5 ({id, score, rank, delta}). document.body.dataset.rankanim says how far it is.
export function animateRanks(ol, before, after, { swap = () => {}, reduced = reducedMotion() } = {}) {
  cancelRanks();
  const T = RANK_TIMES;
  const flag = (v) => (document.body.dataset.rankanim = v);
  const row = (id) => ol.querySelector(`li[data-id="${CSS.escape(id)}"]`);
  const was = new Set(before.map((e) => e.id));
  const now = new Set(after.map((e) => e.id));
  const timers = [];
  const stops = [];
  const anims = [];
  const tick = { p: 0 };

  // The new places and scores, in the new order; those who fell out are gone.
  const settle = () => {
    // Moving a row in the page would start its slide-in again, so that is switched off first (it has long finished).
    for (const li of ol.children) li.style.animation = 'none';
    for (const e of after) {
      const li = row(e.id);
      if (!li) continue;
      li.querySelector('.rank-n').textContent = String(e.rank);
      li.querySelector('.rank-score').textContent = pts(e.score);
      li.classList.remove('waiting');
      ol.append(li);
    }
    for (const li of [...ol.children]) if (!now.has(li.dataset.id)) li.remove();
  };
  const done = () => {
    ol.classList.remove('animating');
    flag('done');
    running = null;
  };
  running = {
    stop() {
      timers.forEach(clearTimeout);
      stops.forEach((s) => s());
      anims.forEach((a) => a.cancel());
      ticking.delete(tick);
      delete document.body.dataset.rankanim;
    },
  };
  if (reduced) {
    settle();
    done();
    return;
  }
  flag('before');

  // 2. The points count up (rows that are on screen and scored), with a soft tick and the +points chip popping in.
  const counting = after.filter((e) => e.delta > 0 && was.has(e.id));
  timers.push(
    setTimeout(() => {
      flag('count');
      for (const e of counting) {
        const li = row(e.id);
        const score = li.querySelector('.rank-score');
        li.querySelector('.rank-delta')?.classList.add('pop');
        const from = e.score - e.delta;
        stops.push(
          tween(T.count, (k, p) => {
            score.textContent = pts(Math.round(from + e.delta * k));
            tick.p = p;
          }),
        );
      }
      if (counting.length) {
        tickWhile(tick);
        timers.push(setTimeout(() => ticking.delete(tick), T.count - 60));
      }
    }, T.settle + T.gap),
  );

  // 3. The rows glide to their new places (First, Last, Invert, Play): climbers rise in from below, and those who
  // fell out slide away under the list.
  timers.push(
    setTimeout(() => {
      flag('move');
      stops.forEach((s) => s());
      ticking.delete(tick);
      const box = ol.getBoundingClientRect();
      const first = new Map([...ol.children].filter((li) => !li.classList.contains('waiting')).map((li) => [li.dataset.id, li.getBoundingClientRect()]));
      const oldOrder = before.map((e) => e.id).filter((id) => now.has(id));
      const leaving = [...ol.children].filter((li) => !now.has(li.dataset.id));
      settle();
      // The leavers stay where they were (out of the layout) while they slide away.
      for (const li of leaving) {
        const r = first.get(li.dataset.id);
        Object.assign(li.style, { position: 'absolute', left: `${r.left - box.left}px`, top: `${r.top - box.top}px`, width: `${r.width}px`, zIndex: '-1' }); // behind the others
        ol.append(li);
      }
      const newOrder = after.map((e) => e.id).filter((id) => was.has(id));
      const moved = leaving.length > 0 || after.some((e) => !was.has(e.id)) || newOrder.some((id, i) => id !== oldOrder[i]);
      if (moved) swap();
      const bottom = ol.getBoundingClientRect().bottom;
      for (const e of after) {
        const li = row(e.id);
        const last = li.getBoundingClientRect();
        const r = first.get(e.id);
        if (r) {
          const dy = r.top - last.top;
          if (dy > 1) Object.assign(li.style, { position: 'relative', zIndex: '1' }); // who climbs passes in front
          if (Math.abs(dy) > 1) anims.push(li.animate([{ transform: `translateY(${dy}px)` }, { transform: 'none' }], { duration: T.move, easing: MOVE_EASE }));
        } else {
          li.querySelector('.rank-delta')?.classList.add('pop');
          Object.assign(li.style, { position: 'relative', zIndex: '2' });
          const dy = Math.max(bottom - last.top, last.height);
          anims.push(li.animate([{ transform: `translateY(${dy}px)`, opacity: 0 }, { transform: 'none', opacity: 1 }], { duration: T.move + 100, easing: MOVE_EASE }));
        }
      }
      for (const li of leaving) {
        const dy = Math.max(bottom - first.get(li.dataset.id).top, first.get(li.dataset.id).height);
        const a = li.animate([{ transform: 'none', opacity: 1 }, { transform: `translateY(${dy}px)`, opacity: 0 }], { duration: T.move, easing: 'cubic-bezier(0.5, 0, 0.75, 0)', fill: 'forwards' });
        a.onfinish = () => li.remove();
        anims.push(a);
      }
      // 4. Done: the arrows fade in.
      timers.push(
        setTimeout(() => {
          leaving.forEach((li) => li.remove());
          for (const li of ol.children) Object.assign(li.style, { position: '', zIndex: '' });
          done();
        }, T.move + 100),
      );
    }, T.settle + T.gap + T.count + T.gap),
  );
}
