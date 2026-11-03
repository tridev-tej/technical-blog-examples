import {acceptFixture} from "./contract.mjs";

class Deadline extends Error {}

function check(condition, message) {
  if (!condition) throw new Error(message);
}

function read(worker, milliseconds) {
  return new Promise(function exchange(resolve, reject) {
    let active = true;
    function finish(value, error) {
      if (!active) return;
      active = false;
      clearTimeout(timer);
      worker.onmessage = null;
      worker.onerror = null;
      worker.onmessageerror = null;
      if (error) reject(error);
      else resolve(value);
    }
    const timer = setTimeout(() => finish(null, new Deadline()), milliseconds);
    worker.onmessage = event => finish(event.data);
    worker.onerror = event => finish(null, new Error(event.message));
    worker.onmessageerror = () => finish(null, new Error("message decoding failed"));
  });
}

async function runOne(request) {
  const url = new URL("./worker.mjs", import.meta.url);
  url.searchParams.set("run_id", request.run_id);
  const worker = new Worker(url, {type: "module"});
  try {
    const ready = await read(worker, 30000);
    check(ready.status === "ready" && ready.run_id === request.run_id, "worker setup failed");
    const pending = read(worker, request.scenario === "loop" ? 250 : 5000);
    worker.postMessage(request);
    try {
      return {request, ready, reply: await pending};
    } catch (error) {
      if (!(error instanceof Deadline)) throw error;
      return {request, ready, reply: {status: "outer_timeout"}};
    }
  } finally {
    worker.terminate();
  }
}

function verify(row, fixture) {
  const {request, reply} = row;
  if (request.scenario === "loop") {
    check(reply.status === "outer_timeout", "loop returned");
    return;
  }
  check(reply.run_id === request.run_id, "stale ID");
  if (request.scenario === "fixture") {
    check(acceptFixture(reply, request.run_id, true), "fixture oracle");
    return;
  }
  const expected = {marker_default: "FileNotFoundError", marker_grant: fixture.marker,
                    bridge: fixture.marker, numpy: 10};
  check(reply.status === "result" && reply.value === expected[request.scenario], "wrong result");
  if (request.scenario === "numpy") check(reply.package_version === "2.4.6", "NumPy version");
}

async function loadFixture() {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Deadline("fixture deadline")), 29000);
  try {
    const response = await fetch("./fixture.json", {signal: controller.signal});
    check(response.ok, "prepare fixture first");
    return await response.json();
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
}

async function runLab() {
  check(window.labStatus !== "running", "already running");
  window.labRows = [];
  window.labStatus = "running";
  window.labError = null;
  try {
    const fixture = await loadFixture();
    for (const scenario of ["fixture", "marker_default", "marker_grant", "bridge", "numpy", "loop", "fixture"]) {
      const row = await runOne({...fixture, scenario, run_id: crypto.randomUUID()});
      window.labRows.push(row);
      document.querySelector("#output").textContent = JSON.stringify(window.labRows, null, 2);
      verify(row, fixture);
    }
    window.labStatus = "passed";
    return window.labRows;
  } catch (error) {
    window.labStatus = "failed";
    window.labError = String(error);
    throw error;
  }
}

window.runLab = runLab;
document.querySelector("#run").addEventListener("click", runLab);
