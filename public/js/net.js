// A WebSocket to the server that reconnects by itself (phones sleep, Wi-Fi drops).
// Every (re)connect starts with a hello, so the server knows who this is again.

export function connect({ role, teamId = () => null, onMessage, onStatus = () => {}, extra = {} }) {
  let ws = null;
  let delay = 500;
  let retry = null;
  let clockOffset = 0; // server time − our time, for countdowns

  function open() {
    clearTimeout(retry);
    ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.onopen = () => {
      delay = 500;
      ws.send(JSON.stringify({ type: 'hello', role, teamId: teamId(), ...extra }));
      onStatus(true);
    };
    ws.onmessage = (e) => {
      const msg = JSON.parse(e.data);
      if (msg.serverNow) clockOffset = msg.serverNow - Date.now();
      onMessage(msg);
    };
    ws.onclose = () => {
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
    }
  });

  open();
  return {
    send(msg) {
      if (ws?.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify(msg));
      return true;
    },
    // Server-clock "now", so a deadline from the server counts down correctly here.
    now: () => Date.now() + clockOffset,
  };
}
