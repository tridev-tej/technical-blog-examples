const { fork } = require('node:child_process');

function failure(error) {
  return { type: 'failure', error: { name: error.name, message: error.message, stack: error.stack } };
}

async function deadline(promise, milliseconds, label) {
  let timer;
  try {
    const expired = new Promise((resolve, reject) => {
      timer = setTimeout(() => reject(new Error(label)), milliseconds);
    });
    return await Promise.race([promise, expired]);
  } finally {
    clearTimeout(timer);
  }
}

function send(child, message) {
  return new Promise((resolve, reject) => {
    child.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function watch(child) {
  let closed = false;
  let resolveResult;
  let resolveClose;
  let exit;
  const result = new Promise((resolve) => {
    resolveResult = resolve;
  });
  const close = new Promise((resolve) => { resolveClose = resolve; });
  child.once('error', (error) => resolveResult({ error }));
  child.once('close', (code, signal) => {
    closed = true;
    exit = { code, signal };
    resolveClose();
    resolveResult({ error: new Error('Owned guardian ended before a result') });
  });
  child.on('message', (message) => {
    if (message.type === 'result') resolveResult({ value: message.value, error: null });
    else resolveResult({ error: Object.assign(new Error(message.error.message), { cause: message.error }) });
  });
  return { result, close, isClosed: () => closed, exit: () => exit };
}

async function dispose(child, channel) {
  if (channel.isClosed()) throw new Error('Guardian ended before disposal; retain its profile');
  await deadline(Promise.all([send(child, { type: 'dispose' }), channel.close]), 5000,
    'Owned process-group cleanup was not confirmed; retain its profile');
  const exit = channel.exit();
  if (exit.code !== null || exit.signal !== 'SIGKILL') {
    throw new Error('Primary group termination was not confirmed; retain its profile');
  }
}

async function startAndWait(child, command, channel) {
  await send(child, command);
  return channel.result;
}

function releaseReferences(child) {
  child.unref();
  if (child.channel) child.channel.unref();
}

async function supervise(child, command, timeout) {
  const channel = watch(child);
  let outcome;
  try {
    outcome = await deadline(startAndWait(child, command, channel), timeout, 'Owned worker result deadline exceeded');
  } catch (operationError) {
    outcome = { error: operationError };
  }
  try {
    await dispose(child, channel);
  } catch (cleanupError) {
    if (outcome.error) throw new AggregateError([outcome.error, cleanupError], 'Worker and cleanup failed');
    throw cleanupError;
  } finally {
    releaseReferences(child);
  }
  return outcome;
}

function guardian(parent, launch, terminate, timeout) {
  let worker;
  let reported = false;
  let stopped = false;
  const timer = setTimeout(() => {
    report(failure(new Error('Owned worker exceeded its group deadline')));
    stop();
  }, timeout);
  function stop() {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    terminate();
  }
  function report(message) {
    if (reported) return;
    reported = true;
    if (!parent.connected) {
      stop();
      return;
    }
    try {
      parent.send(message, (error) => { if (error) stop(); });
    } catch (error) {
      stop();
    }
  }
  function start(message) {
    if (worker) {
      report(failure(new Error('Only one worker is allowed')));
      stop();
      return;
    }
    try {
      worker = launch(message.file, message.args, {
        detached: false, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      worker.on('message', report);
      worker.once('error', (error) => report(failure(error)));
      worker.once('exit', (code, signal) => report(failure(new Error(`Worker exited: ${code} ${signal}`))));
    } catch (error) {
      report(failure(error));
    }
  }
  parent.on('message', (message) => {
    if (message.type === 'dispose') stop();
    else start(message);
  });
  parent.once('disconnect', stop);
  return { stop };
}

async function runOwnedProcess(file, args, timeout, launch = fork, platform = process.platform) {
  if (platform !== 'linux') throw new Error('This owned process-group lifecycle requires Linux');
  const child = launch(__filename, ['--guardian', String(timeout)], {
    detached: true, execArgv: [], stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  return supervise(child, { type: 'start', file, args }, timeout);
}

module.exports = { supervise, guardian, runOwnedProcess };
if (require.main === module) {
  if (process.argv[2] !== '--guardian') throw new Error('Expected guardian entry point');
  guardian(process, fork, () => process.kill(-process.pid, 'SIGKILL'), Number(process.argv[3]));
}
