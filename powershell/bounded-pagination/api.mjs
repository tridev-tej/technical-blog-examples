import http from 'node:http';
import { pathToFileURL } from 'node:url';

const page = (ids, nextToken) => ({ items: ids.map(id => ({ id })), nextToken });
const prefix = page([1, 2], 'A');
const normal = { r: prefix, A: page([3, 4], 'B'), B: page([5], null) };
const bad = {
  json: '{', nullRoot: null, scalarRoot: 7, missingItems: { nextToken: null },
  nullItems: { items: null, nextToken: null },
  scalarItems: { items: { id: 3 }, nextToken: null },
  badItem: { items: [{ id: '3' }], nextToken: null },
  nullItem: { items: [null], nextToken: null },
  fractionalId: { items: [{ id: 3.5 }], nextToken: null },
  booleanId: { items: [{ id: true }], nextToken: null },
  missingId: { items: [{}], nextToken: null },
  missingToken: { items: [{ id: 3 }] },
  numberToken: { items: [], nextToken: 3 },
  objectToken: { items: [], nextToken: {} },
  emptyToken: { items: [], nextToken: '' },
  urlToken: { items: [], nextToken: 'http://127.0.0.1/other' },
  newlineToken: { items: [], nextToken: 'A\n' },
  longToken: { items: [], nextToken: 'A'.repeat(65) }
};
const fixtures = {
  normal, empty: { r: page([], null) },
  emptyAfter: { r: prefix, A: page([], null) },
  emptyNext: { r: page([], 'A'), A: page([1], null) },
  oversized: { r: page([1, 2, 3], null) },
  repeat: { r: prefix, A: page([3, 4], 'A') },
  cycle: { ...normal, B: page([5, 6], 'A') },
  caseSensitive: { r: page([1], 'A'), A: page([2], 'a'), a: page([3], null) },
  extraFields: { r: { items: [{ id: -1, label: 'kept' }], nextToken: null } }
};

function sendJson(response, body) {
  response.setHeader('Content-Type', 'application/json');
  response.end(JSON.stringify(body));
}

function sendFault(response, scenario, redirectUrl) {
  if (scenario === 'stall') {
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.write('{"items":');
    return;
  }
  if (scenario === 'redirect') {
    response.writeHead(302, { Location: redirectUrl });
    response.end();
    return;
  }
  response.writeHead(Number(scenario), { 'Retry-After': '0' });
  response.end('synthetic failure');
}

function respond(response, scenario, cursor, redirectUrl) {
  if (scenario === 'firstFailure') {
    sendFault(response, '503', redirectUrl);
    return;
  }
  if (['429', '503', 'redirect', 'stall'].includes(scenario)) {
    if (cursor === 'r') sendJson(response, prefix);
    else sendFault(response, scenario, redirectUrl);
    return;
  }
  if (Object.hasOwn(bad, scenario)) {
    response.setHeader('Content-Type', 'application/json');
    if (cursor === 'r') sendJson(response, prefix);
    else if (scenario === 'json') response.end(bad.json);
    else sendJson(response, bad[scenario]);
    return;
  }
  const body = fixtures[scenario]?.[cursor];
  if (body === undefined) {
    response.writeHead(404);
    response.end('unknown fixture or cursor');
    return;
  }
  sendJson(response, body);
}

function handler(trace, redirectUrl) {
  return (request, response) => {
    trace.push({ method: request.method, url: request.url });
    const url = new URL(request.url, 'http://127.0.0.1');
    const scenario = url.pathname.slice(1);
    const cursor = url.searchParams.get('cursor') ?? 'r';
    respond(response, scenario, cursor, redirectUrl);
  };
}

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
}

function stop(server) {
  server.closeAllConnections();
  return new Promise((resolve, reject) => {
    server.close(error => {
      if (error) reject(error);
      else resolve();
    });
  });
}

export async function startApi() {
  const trace = [];
  const destinationTrace = [];
  const destination = http.createServer((request, response) => {
    destinationTrace.push({ method: request.method, url: request.url });
    sendJson(response, page([999], null));
  });
  await listen(destination);
  const redirectUrl = `http://127.0.0.1:${destination.address().port}/destination`;
  const server = http.createServer(handler(trace, redirectUrl));
  await listen(server);
  return {
    base: `http://127.0.0.1:${server.address().port}`,
    trace, destinationTrace,
    async close() { await stop(server); await stop(destination); }
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const api = await startApi();
  process.stdout.write(`${api.base}\n`);
  process.on('SIGINT', async () => { await api.close(); });
}
