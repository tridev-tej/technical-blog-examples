const http = require('node:http');
const { once } = require('node:events');

const scripts = {
  success: `document.querySelector('[data-approve]').addEventListener('click', () => {
    document.querySelector('[data-status]').textContent = 'Approved';
    const confirmation = document.createElement('p');
    confirmation.dataset.confirmation = '';
    confirmation.textContent = 'Order 1001 approved';
    document.querySelector('main').append(confirmation);
    document.querySelector('[data-approve]').disabled = true;
  });`,
  'missing-element': '',
  'unexpected-navigation': `document.querySelector('[data-approve]').addEventListener('click', () => {
    window.location.assign('/session-expired');
  });`,
};

function page(content) {
  return `<!doctype html><html lang="en"><meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <title>Deterministic order lab</title><body><main>${content}</main></body></html>`;
}

function orderPage(mode) {
  const button = mode === 'missing-element' ? '' : '<button data-approve>Approve order</button>';
  return page(`<h1>Order <span data-order-id>1001</span></h1>
    <p>Status: <span data-status>Pending</span></p>${button}
    <script>${scripts[mode]}</script>`);
}

function serve(request, response) {
  const route = new URL(request.url, 'http://127.0.0.1').pathname;
  response.setHeader('Content-Type', 'text/html; charset=utf-8');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET') {
    response.writeHead(405).end(page('<h1>Method not allowed</h1>'));
    return;
  }
  if (route === '/session-expired') {
    response.end(page('<h1>Session expired</h1><p>Order 1001 approved</p>'));
    return;
  }
  const mode = route.slice('/orders/1001/'.length);
  if (!route.startsWith('/orders/1001/') || !Object.hasOwn(scripts, mode)) {
    response.writeHead(404).end(page('<h1>Not found</h1>'));
    return;
  }
  response.end(orderPage(mode));
}

async function startSite() {
  const server = http.createServer(serve);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}

async function stopSite(server) {
  await new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

module.exports = { startSite, stopSite };
