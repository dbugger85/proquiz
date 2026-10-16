// A WebSocket to the server that reconnects by itself (phones sleep, Wi-Fi drops).
// Every (re)connect starts with a hello, so the server knows who this is again.

// `path` is the WebSocket's path on the server (`/ws` on the laptop; the website gives a room's path, see env.js).
export function connect({ role, teamId = () => null, onMessage, onStatus = () => {}, extra = {}, path = '/ws' }) {
  let ws = null;
  let delay = 500;
  let retry = null;
  let clockOffset = 0; // server time − our time, for countdowns
  let stopped = false; // the server said goodbye (the host quit ProQuiz): no more reconnecting

  function open() {
    clearTimeout(retry);
    if (stopped) return;
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}${path}`);
    ws.onopen = () => {
      delay = 500;
      ws.send(JSON.stringify({ type: 'hello', role, teamId: teamId(), ...extra }));
      onStatus(true);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      // The website's server has no built-in ping, so it asks in a message; the laptop server never sends this.
      if (msg.type === 'ping') return ws.send('{"type":"pong"}');
      // Fair buzzing: the server measures our clock. Answer at once with a stopwatch that never jumps.
      if (msg.type === 'clock') return ws.send(JSON.stringify({ type: 'clock', id: msg.id, t: performance.now() }));
      if (msg.serverNow) clockOffset = msg.serverNow - Date.now();
      // ProQuiz was quit on the host laptop: the page shows that and never tries to connect again.
      if (msg.type === 'bye') stopped = true;
      onMessage(msg);
    };
    ws.onclose = () => {
      if (stopped) return;
      onStatus(false);
      retry = setTimeout(open, delay);
      delay = Math.min(delay * 2, 5000);
    };
  }

  // Coming back to the page (phone unlocked): reconnect straight away instead of waiting.
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden && ws && ws.readyState === WebSocket.CLOSED) {
      delay = 500;
      open();
    } else if (!document.hidden && ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'resync' })); // the stopwatch may have paused while the page was hidden
    }
  });

  open();
  return {
    send(msg) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    // Our stopwatch, sent with a buzz so the server can tell when the button was really pressed.
    stamp: () => performance.now(),
    // Server-clock "now", so a deadline from the server counts down correctly here.
    now: () => Date.now() + clockOffset,
  };
}
