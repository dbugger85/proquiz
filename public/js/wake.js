// Keeps a phone's screen on during the game.
// The proper Wake Lock API only works on https or localhost, and phones reach the game over plain
// http on the Wi-Fi. So when it isn't there, a tiny silent looping video does the same job.

let lock = null;
let video = null;

async function request() {
  if ('wakeLock' in navigator && window.isSecureContext) {
    try {
      lock = await navigator.wakeLock.request('screen');
      return;
    } catch {}
  }
  if (!video) {
    video = document.createElement('video');
    video.setAttribute('playsinline', '');
    video.setAttribute('muted', '');
    video.muted = true;
    video.loop = true;
    video.style.cssText = 'position:fixed;width:1px;height:1px;opacity:0;pointer-events:none;left:0;top:0';
    for (const [src, type] of [['/media/keepawake.webm', 'video/webm'], ['/media/keepawake.mp4', 'video/mp4']]) {
      const s = document.createElement('source');
      s.src = src;
      s.type = type;
      video.append(s);
    }
    document.body.append(video);
  }
  video.play().catch(() => {});
}

// Call from a tap (browsers only start the video after one). Re-applied when the page is shown again.
export function keepAwake() {
  if (lock && !lock.released) return;
  request();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && (video || lock)) request();
});
