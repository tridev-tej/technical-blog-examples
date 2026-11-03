import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile, rename } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import assert from 'node:assert/strict';

assert.equal(process.version, 'v26.3.0');
const inputs = ['red jam', 'green apple', 'blue berry'];
const assets = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/frutjam.css', ['vendor/frutjam-2.3.0.components.css', 'text/css']],
  ['/htmx.js', ['vendor/htmx-2.0.8.min.js', 'text/javascript']],
]);
const bodies = new Map();
for (const [route, [file, type]] of assets) {
  bodies.set(route, [await readFile(new URL(file, import.meta.url)), type]);
}
await mkdir(new URL('run/', import.meta.url), { recursive: true });
let job;

function log(event, detail = {}) {
  console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));
}

function resultPath(id, suffix = '.json') {
  return new URL('run/' + id + suffix, import.meta.url);
}

async function confirmedResult(current) {
  const result = JSON.parse(await readFile(resultPath(current.jobID), 'utf8'));
  assert.deepEqual(result, { jobID: current.jobID, counts: [2, 2, 2], total: 6 });
  return result;
}

async function worker(current) {
  await pause(2000);
  current.state = 'running';
  log('worker-start', { jobID: current.jobID });
  for (const input of inputs) {
    await pause(2000);
    current.counts.push(input.split(' ').length);
    log('step', { jobID: current.jobID, count: current.counts.length });
  }
  await pause(2000);
  const total = current.counts.reduce((sum, count) => sum + count, 0);
  const result = { jobID: current.jobID, counts: current.counts, total };
  await writeFile(resultPath(current.jobID, '.tmp'), JSON.stringify(result));
  await rename(resultPath(current.jobID, '.tmp'), resultPath(current.jobID));
  await confirmedResult(current);
  current.state = 'completed';
  log('result-confirmed', { jobID: current.jobID });
}

function createJob() {
  job = { jobID: randomUUID(), state: 'queued', counts: [] };
  log('created', { jobID: job.jobID });
  worker(job).catch(error => {
    job.state = 'error';
    log('worker-error', { jobID: job.jobID, error: error.message });
  });
}

async function snapshot(current) {
  if (current.state === 'error') throw new Error('Worker failed; inspect server events');
  const colors = { queued: 'neutral', running: 'info', completed: 'success' };
  const count = current.counts.length;
  let summary = `${current.state}: ${count} of 3 inputs counted.`;
  let resultText = 'Result not confirmed.';
  if (current.state === 'completed') {
    const result = await confirmedResult(current);
    summary = 'Completed: confirmed total ' + result.total + ' words.';
    resultText = `Counts: ${result.counts.join(', ')}. Total: ${result.total}.`;
  } else if (count === 3) {
    summary = 'Running: 3 of 3 inputs counted; confirming result.';
  }
  return `<div data-job-id="${current.jobID}" data-state="${current.state}" data-count="${count}">
  <p><span class="badge badge-${colors[current.state]}">${current.state}</span></p>
  <p>Job ID: <code>${current.jobID}</code></p>
  <p data-summary>${summary}</p>
  <label for="input-progress">Inputs counted</label>
  <progress id="input-progress" class="progress progress-primary" value="${count}" max="3">${count} of 3</progress>
  <p>${count} of 3 inputs counted. ${resultText}</p>
</div>`;
}

function send(response, status, body, type = 'text/plain; charset=utf-8') {
  response.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  response.end(body);
}

async function start(response) {
  const status = job ? 200 : 202;
  if (!job) createJob();
  send(response, status, await snapshot(job), 'text/html; charset=utf-8');
}

async function status(url, response) {
  if (!job) return send(response, 404, 'No job exists in this server process.');
  const requestedID = url.searchParams.get('jobID');
  if (requestedID !== null && requestedID !== job.jobID) {
    return send(response, 404, 'Unknown job ID in this server process.');
  }
  if (url.searchParams.get('unavailable') === '1') {
    return send(response, 503, 'Demo observation unavailable. Worker unchanged.');
  }
  send(response, 200, await snapshot(job), 'text/html; charset=utf-8');
}

async function route(request, response) {
  const url = new URL(request.url, 'http://127.0.0.1:8787');
  log('request', { method: request.method, path: url.pathname, query: url.search });
  if (bodies.has(url.pathname)) {
    if (request.method !== 'GET') return send(response, 405, 'Use GET.');
    const [body, type] = bodies.get(url.pathname);
    return send(response, 200, body, type);
  }
  if (url.pathname === '/jobs/demo') {
    if (request.method !== 'POST') return send(response, 405, 'Use POST.');
    return start(response);
  }
  if (url.pathname === '/jobs/demo/status') {
    if (request.method !== 'GET') return send(response, 405, 'Use GET.');
    return status(url, response);
  }
  send(response, 404, 'Unknown route.');
}

const server = createServer((request, response) => {
  route(request, response).catch(error => {
    log('request-error', { error: error.message });
    send(response, 500, 'Server cannot confirm this job. Inspect server events.');
  });
});
server.on('error', error => { throw error; });
server.listen(8787, '127.0.0.1', () => { log('listening', { port: 8787 }); });
