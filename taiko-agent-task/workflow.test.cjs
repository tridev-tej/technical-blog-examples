const assert = require('node:assert/strict');
const { test, before, after } = require('node:test');
const { mkdtemp, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const path = require('node:path');
const { startSite, stopSite } = require('./site.cjs');
const { runOwnedProcess } = require('./owned-process.cjs');
let taiko;

const task = { orderId: '1001' };
const missingError = { name: 'Error', message: 'Button with label Approve order  not found' };
const cases = [
  { mode: 'success', buttons: 1, completed: true },
  { mode: 'missing-element', buttons: 0, completed: false },
  { mode: 'unexpected-navigation', buttons: 1, completed: false },
];

function assertMisleadingPage(observed, expectedURL) {
  assert.equal(isCompleted(observed, expectedURL, task), false);
  assert.equal(textOnlyCompleted(observed, task), true);
  assert.deepEqual(observed.order, []);
  assert.deepEqual(observed.status, []);
  assert.deepEqual(observed.confirmation, []);
}

function assertPending(observed, expectedURL, buttons) {
  assert.equal(observed.url, expectedURL);
  assert.deepEqual(observed.order, [{ text: task.orderId, visible: true }]);
  assert.deepEqual(observed.status, [{ text: 'Pending', visible: true }]);
  assert.deepEqual(observed.confirmation, []);
  assert.equal(observed.buttons, buttons);
  assert.equal(isCompleted(observed, expectedURL, task), false);
}

function assertOutcome(scenario, evidence, expectedURL, origin) {
  assert.equal(evidence.agent.report, 'completed');
  assert.equal(evidence.completed, scenario.completed);
  if (scenario.mode === 'missing-element') {
    assert.equal(evidence.agent.actionResolved, false);
    assert.equal(evidence.agent.error.name, missingError.name);
    assert.equal(evidence.agent.error.message, missingError.message);
    assertPending(evidence.final, expectedURL, 0);
    return;
  }
  assert.equal(evidence.agent.actionResolved, true);
  assert.equal(evidence.agent.error, null);
  if (scenario.mode === 'unexpected-navigation') {
    assert.equal(evidence.final.url, `${origin}/session-expired`);
    assertMisleadingPage(evidence.final, expectedURL);
    return;
  }
  assert.equal(evidence.final.url, expectedURL);
  assert.deepEqual(evidence.final.order, [{ text: task.orderId, visible: true }]);
  assert.deepEqual(evidence.final.status, [{ text: 'Approved', visible: true }]);
  assert.deepEqual(evidence.final.confirmation, [
    { text: `Order ${task.orderId} approved`, visible: true },
  ]);
}

function oneVisibleValue(values, expected) {
  return values.length === 1 && values[0].visible && values[0].text === expected;
}

function isCompleted(observed, expectedURL, input) {
  return observed.url === expectedURL &&
    oneVisibleValue(observed.order, input.orderId) &&
    oneVisibleValue(observed.status, 'Approved') &&
    oneVisibleValue(observed.confirmation, `Order ${input.orderId} approved`);
}

function textOnlyCompleted(observed, input) {
  return observed.bodyText.includes(`Order ${input.orderId} approved`);
}

function readPage() {
  function visible(element) {
    const rectangle = element.getBoundingClientRect();
    if (rectangle.width <= 0 || rectangle.height <= 0) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = getComputedStyle(ancestor);
      if (style.visibility !== 'visible' || Number(style.opacity) === 0) return false;
    }
    return rectangle.bottom > 0 && rectangle.right > 0 &&
      rectangle.top < window.innerHeight && rectangle.left < window.innerWidth;
  }
  function values(selector) {
    return Array.from(document.querySelectorAll(selector), (element) => ({
      text: element.innerText.trim(), visible: visible(element),
    }));
  }
  return {
    order: values('[data-order-id]'),
    status: values('[data-status]'),
    confirmation: values('[data-confirmation]'),
    bodyText: document.body.innerText,
  };
}

async function observe() {
  const url = await taiko.currentURL();
  const dom = await taiko.evaluate(readPage, { navigationTimeout: 30000 });
  const buttons = (await taiko.button('Approve order').elements(0, 0)).length;
  return { url, ...dom, buttons };
}

async function optimisticAgent() {
  try {
    await taiko.click(taiko.button('Approve order'), { navigationTimeout: 30000 });
    return { report: 'completed', actionResolved: true, error: null };
  } catch (error) {
    return {
      report: 'completed', actionResolved: false,
      error: { name: error.name, message: error.message, stack: error.stack },
    };
  }
}

async function runScenario(scenario, origin, directory) {
  const expectedURL = `${origin}/orders/${task.orderId}/${scenario.mode}`;
  await taiko.goto(expectedURL, { navigationTimeout: 30000 });
  const initial = await observe();
  assertPending(initial, expectedURL, scenario.buttons);
  const agent = await optimisticAgent();
  const final = await observe();
  const evidence = {
    mode: scenario.mode, initial, agent, final,
    completed: isCompleted(final, expectedURL, task),
  };
  await writeFile(path.join(directory, `${scenario.mode}.json`), JSON.stringify(evidence, null, 2));
  await taiko.screenshot({ path: path.join(directory, `${scenario.mode}.png`) });
  assertOutcome(scenario, evidence, expectedURL, origin);
  return evidence;
}

async function misleadingControl(origin, directory) {
  const expectedURL = `${origin}/orders/${task.orderId}/success`;
  await taiko.goto(`${origin}/session-expired`, { navigationTimeout: 30000 });
  const observed = await observe();
  assertMisleadingPage(observed, expectedURL);
  let failure;
  try {
    assert.equal(textOnlyCompleted(observed, task), false);
  } catch (error) {
    failure = { name: error.name, message: error.message, stack: error.stack };
  }
  assert.ok(failure, 'Text-only checker must produce the demonstrated false positive');
  assert.equal(failure.name, 'AssertionError');
  await writeFile(path.join(directory, 'text-only-control.json'), JSON.stringify({
    observed, insufficientCheckerFailure: failure,
    completeOracle: isCompleted(observed, expectedURL, task),
  }, null, 2));
}

function rejectRuntimeOverrides() {
  for (const key of Object.keys(process.env)) {
    if (key.startsWith('TAIKO_') || ['LOCAL_PROTOCOL', 'NODE_OPTIONS', 'NODE_PATH'].includes(key)) {
      throw new Error(`Conflicting runtime override: ${key}`);
    }
  }
}

function registerReaderTests() {
  let site;
  let directory;
  before(async () => {
    assert.equal(process.platform, 'linux', 'This example requires the Linux process-group lifecycle');
    rejectRuntimeOverrides();
    assert.equal(require('taiko/package.json').version, '1.5.0');
    directory = await mkdtemp(path.join(__dirname, 'evidence-'));
    site = await startSite();
    await writeFile(path.join(directory, 'environment.json'), JSON.stringify({
      node: process.version, platform: process.platform, arch: process.arch,
      taiko: require('taiko/package.json').version, path: 'linux-owned-incognito-process-group',
    }, null, 2));
  });
  after(async () => {
    if (site) await stopSite(site.server);
  });
  test('misleading text is insufficient evidence', { timeout: 65000 }, async () => {
    await ownedCase('control', site.origin, directory);
  });
  for (const scenario of cases) {
    test(scenario.mode, { timeout: 65000 }, async () => {
      await ownedCase(scenario.mode, site.origin, directory);
    });
  }
}

async function ownedCase(mode, origin, directory) {
  const profile = await mkdtemp(path.join(tmpdir(), 'taiko-order-'));
  const outcome = await runOwnedProcess(__filename,
    ['--worker', mode, origin, directory, profile], 55000);
  try {
    await rm(profile, { recursive: true });
  } catch (error) {
    if (outcome.error) throw new AggregateError([outcome.error, error], 'Worker and profile removal failed');
    throw error;
  }
  if (outcome.error) throw outcome.error;
  return outcome.value;
}

async function worker() {
  const [, , , mode, origin, directory, profile] = process.argv;
  taiko = require('taiko');
  await taiko.openBrowser({ args: ['--incognito', `--user-data-dir=${profile}`] });
  const scenario = cases.find((item) => item.mode === mode);
  let value;
  if (mode === 'control') value = await misleadingControl(origin, directory);
  else value = await runScenario(scenario, origin, directory);
  process.send({ type: 'result', value });
}

function reportWorkerFailure(error) {
  process.send({ type: 'failure', error: { name: error.name, message: error.message, stack: error.stack } });
}

module.exports = { cases, runScenario, misleadingControl };
if (require.main === module) {
  if (process.argv[2] === '--worker') worker().catch(reportWorkerFailure);
  else registerReaderTests();
}
