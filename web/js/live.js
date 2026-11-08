// One SSE connection per browser, however many tabs are open.
// A Web Lock elects a leader tab per country; the leader owns the EventSource and relays
// events to the other tabs over a BroadcastChannel. When the leader closes, another tab
// acquires the lock and reconnects. Falls back to a plain EventSource per tab.

const EVENTS = ['hello', 'tracker_score', 'top_play', 'rankings'];
const listeners = new Map(); // country -> Set<fn>
const conns = new Map(); // country -> { close }

export function subscribe(country, fn) {
  if (!listeners.has(country)) listeners.set(country, new Set());
  listeners.get(country).add(fn);
  if (!conns.has(country)) conns.set(country, connect(country));
  return () => {
    const set = listeners.get(country);
    set?.delete(fn);
    if (set && set.size === 0) {
      conns.get(country)?.close();
      conns.delete(country);
      listeners.delete(country);
    }
  };
}

function dispatch(country, type, data) {
  for (const fn of listeners.get(country) || []) {
    try { fn(type, data); } catch (e) { console.error(e); }
  }
}

function openSource(country, onEvent) {
  const es = new EventSource(`/api/live?country=${encodeURIComponent(country)}`);
  for (const type of EVENTS) {
    es.addEventListener(type, (e) => {
      let data = null;
      try { data = JSON.parse(e.data); } catch {}
      onEvent(type, data);
    });
  }
  es.onerror = () => onEvent('status', { connected: es.readyState === EventSource.OPEN });
  es.onopen = () => onEvent('status', { connected: true });
  return es;
}

function connect(country) {
  const canShare = typeof navigator !== 'undefined' && navigator.locks?.request && typeof BroadcastChannel !== 'undefined';
  if (!canShare) {
    const es = openSource(country, (t, d) => dispatch(country, t, d));
    return { close: () => es.close() };
  }

  const name = `keyfeed-sse:${country}`;
  const channel = new BroadcastChannel(name);
  const abort = new AbortController();
  let es = null;

  // Followers: receive relayed events.
  channel.onmessage = (e) => dispatch(country, e.data.type, e.data.data);

  // Leader: holds the lock for as long as this tab keeps the subscription.
  navigator.locks
    .request(name, { signal: abort.signal }, () => new Promise((release) => {
      es = openSource(country, (type, data) => {
        dispatch(country, type, data);
        channel.postMessage({ type, data });
      });
      abort.signal.addEventListener('abort', () => { es?.close(); release(); });
    }))
    .catch(() => {}); // AbortError when we unsubscribe while still waiting

  // A follower can't know the connection state, so assume connected once someone leads.
  navigator.locks.query?.().then((s) => {
    if (s.held?.some((l) => l.name === name)) dispatch(country, 'status', { connected: true });
  });

  return {
    close: () => {
      abort.abort();
      es?.close();
      channel.close();
    },
  };
}
