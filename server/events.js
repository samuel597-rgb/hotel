// Single-process event bus used by the SQLite demo's SSE connections.
const clients = new Map();

export function subscribe(scope, response) {
  if (!clients.has(scope)) clients.set(scope, new Set());
  clients.get(scope).add(response);
}

export function unsubscribe(scope, response) {
  const subscribers = clients.get(scope);
  if (!subscribers) return;
  subscribers.delete(response);
  if (!subscribers.size) clients.delete(scope);
}

export function publish(scope, event, data) {
  const subscribers = clients.get(scope);
  if (!subscribers) return;
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const response of [...subscribers]) {
    if (response.destroyed || response.writableEnded) {
      unsubscribe(scope, response);
      continue;
    }
    try { response.write(payload); } catch { unsubscribe(scope, response); }
  }
}

export function subscriberCount(scope) { return clients.get(scope)?.size || 0; }
