import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFile, rename, writeFile, access, mkdir, rmdir } from 'node:fs/promises';
import { setTimeout as pause } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';

assert.equal(process.version, 'v26.3.0');
const base = 'http://127.0.0.1:8787';
let events = [];
let streamError;
let interrupted = false;
const owned = new Set();

function interrupt() {
  interrupted = true;
  for (const child of owned) child.kill('SIGTERM');
}

process.on('SIGINT', interrupt);
process.on('SIGTERM', interrupt);

async function request(path, method = 'GET') {
  const response = await fetch(base + path, { method, signal: AbortSignal.timeout(3000) });
  assert.equal(response.headers.get('cache-control'), 'no-store');
  return { status: response.status, body: await response.text() };
}

function jobID(response) {
  const match = response.body.match(/data-job-id="([a-f0-9-]{36})"/);
  assert.ok(match, response.body);
  return match[1];
}

function eventCount(name) {
  if (streamError) throw streamError;
  assert.equal(interrupted, false, 'verification interrupted');
  return events.filter(event => event.event === name).length;
}

async function boot() {
  events = [];
  streamError = undefined;
  const child = spawn(process.execPath, ['server.mjs'], { stdio: ['ignore', 'pipe', 'inherit'] });
  owned.add(child);
  try {
    attachEvents(child);
    await waitForStartup(child);
    return child;
  } catch (error) {
    await stop(child);
    throw error;
  }
}

function attachEvents(child) {
  let pending = '';
  child.stdout.on('data', chunk => {
    try {
      pending += chunk;
      const lines = pending.split('\n');
      pending = lines.pop();
      for (const line of lines) events.push(JSON.parse(line));
    } catch (error) {
      streamError = error;
    }
  });
  child.on('error', error => { streamError = error; });
}

async function waitForStartup(child) {
  const deadline = performance.now() + 5000;
  while (eventCount('listening') === 0) {
    assert.equal(child.exitCode, null, 'server exited before listening');
    assert.equal(child.signalCode, null, 'server signaled before listening');
    assert.ok(performance.now() < deadline, 'startup deadline');
    await pause(25);
  }
}

async function stop(child) {
  if (child.exitCode === null && child.signalCode === null) child.kill('SIGTERM');
  const deadline = performance.now() + 3000;
  while (child.exitCode === null && child.signalCode === null) {
    assert.ok(performance.now() < deadline, 'shutdown deadline');
    await pause(25);
  }
  owned.delete(child);
}

async function untilBody(path, text) {
  const deadline = performance.now() + 15000;
  while (performance.now() < deadline) {
    const response = await request(path);
    assert.equal(response.status, 200);
    if (response.body.includes(text)) return response;
    await pause(75);
  }
  throw new Error('state deadline: ' + text);
}

async function checkEmpty() {
  for (let i = 0; i < 2; i += 1) {
    assert.equal((await request('/')).status, 200);
    assert.equal((await request('/jobs/demo/status')).status, 404);
  }
  assert.equal(eventCount('created'), 0);
  assert.equal(eventCount('worker-start'), 0);
  assert.equal((await request('/unknown')).status, 404);
  assert.equal((await request('/jobs/demo', 'PUT')).status, 405);
}

async function checkResult(id, path) {
  await untilBody(path, 'data-state="running" data-count="3"');
  await assert.rejects(access(`run/${id}.json`));
  const deadline = performance.now() + 5000;
  while (eventCount('result-confirmed') === 0) {
    assert.ok(performance.now() < deadline, 'independent result deadline');
    await pause(25);
  }
  const complete = await untilBody(path, 'data-state="completed"');
  assert.equal(jobID(complete), id);
  const raw = await readFile(`run/${id}.json`, 'utf8');
  assert.deepEqual(JSON.parse(raw), { jobID: id, counts: [2, 2, 2], total: 6 });
  await rename(`run/${id}.json`, `run/${id}.held`);
  assert.equal((await request(path)).status, 500);
  await assert.rejects(access(`run/${id}.json`));
  await writeFile(`run/${id}.json`, '{}');
  assert.equal((await request(path)).status, 500);
  await rename(`run/${id}.held`, `run/${id}.json`);
  assert.equal((await request(path)).status, 200);
}

async function checkJob() {
  const starts = await Promise.all([request('/jobs/demo', 'POST'), request('/jobs/demo', 'POST')]);
  assert.deepEqual(starts.map(item => item.status).sort(), [200, 202]);
  const id = jobID(starts[0]);
  assert.equal(jobID(starts[1]), id);
  assert.ok(starts[0].body.includes('data-state="queued"'));
  const path = '/jobs/demo/status?jobID=' + id;
  assert.equal((await request('/jobs/demo/status?jobID=unknown')).status, 404);
  assert.equal((await request(path + '&unavailable=1')).status, 503);
  assert.equal(jobID(await request(path)), id);
  await untilBody(path, 'data-state="running"');
  assert.equal(jobID(await request(path)), id);
  await checkResult(id, path);
  await pause(50);
  assert.equal(eventCount('created'), 1);
  assert.equal(eventCount('worker-start'), 1);
  assert.equal(eventCount('result-confirmed'), 1);
  return id;
}

async function checkWorkerFailure() {
  const created = await request('/jobs/demo', 'POST');
  assert.equal(created.status, 202);
  const id = jobID(created);
  await mkdir(`run/${id}.tmp`);
  const deadline = performance.now() + 15000;
  while (eventCount('worker-error') === 0) {
    assert.ok(performance.now() < deadline, 'worker error deadline');
    await pause(25);
  }
  assert.equal((await request('/jobs/demo/status?jobID=' + id)).status, 500);
  await assert.rejects(access(`run/${id}.json`));
  await rmdir(`run/${id}.tmp`);
  assert.equal(eventCount('created'), 1);
  assert.equal(eventCount('worker-start'), 1);
  assert.equal(eventCount('result-confirmed'), 0);
}

let child;
try {
  child = await boot();
  await checkEmpty();
  const id = await checkJob();
  const firstEvents = events;
  await stop(child);
  child = await boot();
  await checkEmpty();
  assert.equal((await request('/jobs/demo/status?jobID=' + id)).status, 404);
  const restartEvents = [...events];
  await checkWorkerFailure();
  console.log(JSON.stringify({ checks: 'PASS', jobID: id, firstEvents, restartEvents, failureEvents: events }));
} finally {
  if (child) await stop(child);
  process.removeListener('SIGINT', interrupt);
  process.removeListener('SIGTERM', interrupt);
}
