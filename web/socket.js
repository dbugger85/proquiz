// A Cloudflare WebSocket as the hub (lib/hub.js) expects one: send(), readyState === 1, on('message' | 'close' |
// 'pong'), ping() and terminate(). Cloudflare sockets have no ping(), so ping() sends a {"type":"ping"} message and
// the page's {"type":"pong"} answer (net.js) becomes the 'pong' event. The room (web/room.js) feeds incoming
// messages and closes in through receive() and closed(), since with the hibernation API they arrive on the
// Durable Object, not on the socket.

// Strings only, and no bigger than this: a phone or TV may send 64 KB, the host 1 MiB (a whole quiz in `loadSet`).
export const MAX_MESSAGE = 64 * 1024;
export const MAX_HOST_MESSAGE = 1024 * 1024;

// `onClosed(adapter)` runs once when the connection is over (closed by the page, by the hub, or by the room).
export function wrap(ws, { onClosed = () => {} } = {}) {
  const handlers = {};
  let open = true;
  const emit = (ev, ...args) => {
    for (const fn of handlers[ev] ?? []) fn(...args);
  };
  const adapter = {
    raw: ws,
    role: null, // 'host' | 'display' | 'phone' once the hub has welcomed this connection (the room watches for it)
    get readyState() {
      return open && ws.readyState === 1 ? 1 : 3;
    },
    send(text) {
      if (!open) return;
      try {
        ws.send(text);
      } catch {
        adapter.closed();
      }
      // The hub answers a hello with `welcome`: from then on the room knows what this connection is.
      if (adapter.helloRole && text.startsWith('{"type":"welcome"')) {
        adapter.role = adapter.helloRole;
        adapter.helloRole = null;
      }
    },
    on(ev, fn) {
      (handlers[ev] ??= []).push(fn);
    },
    ping() {
      adapter.send('{"type":"ping"}');
    },
    terminate() {
      if (!open) return;
      try {
        ws.close(1011, 'no answer');
      } catch {
        // already gone
      }
      adapter.closed();
    },
    // A message from the page. Returns false (and closes) when it isn't a string or is too big.
    receive(message) {
      if (!open) return false;
      const limit = adapter.role === 'host' ? MAX_HOST_MESSAGE : MAX_MESSAGE;
      if (typeof message !== 'string' || message.length > limit) {
        try {
          ws.close(typeof message === 'string' ? 1009 : 1003, 'bad message');
        } catch {
          // already gone
        }
        adapter.closed();
        return false;
      }
      if (message === '{"type":"pong"}') emit('pong');
      else emit('message', message);
      return true;
    },
    // The page went away (or we closed it): tell the hub once.
    closed() {
      if (!open) return;
      open = false;
      emit('close');
      onClosed(adapter);
    },
  };
  return adapter;
}
