import {loadPyodide} from "./vendor/pyodide/314.0.7/pyodide.mjs";

const runId = new URL(self.location.href).searchParams.get("run_id");
let pyodide;
let source;
let numpyVersion;

async function initialize() {
  const response = await fetch("./task.py");
  if (!response.ok) throw new Error("task source missing");
  source = await response.text();
  pyodide = await loadPyodide({indexURL: new URL("./vendor/pyodide/314.0.7/", import.meta.url).href});
  if (pyodide.version !== "314.0.7") throw new Error("Pyodide version mismatch");
  self.postMessage({run_id: runId, status: "ready", pyodide: pyodide.version,
                    python: pyodide.runPython("import sys\nsys.version")});
}

function fixture(message) {
  const values = pyodide.toPy(message.values);
  pyodide.globals.set("values", values);
  try {
    return JSON.parse(pyodide.runPython("import json\njson.dumps(" + source.trim() + ")"));
  } finally {
    pyodide.globals.delete("values");
    values.destroy();
  }
}

function markerDefault(message) {
  pyodide.globals.set("host_path", message.host_path);
  return pyodide.runPython("try:\n    open(host_path).read()\nexcept FileNotFoundError:\n    result = 'FileNotFoundError'\nelse:\n    result = 'unexpected_read'\nresult");
}

function markerGrant(message) {
  pyodide.FS.writeFile("/marker.txt", message.marker);
  return pyodide.runPython("open('/marker.txt').read()");
}

function bridge(message) {
  globalThis.labMarker = message.marker;
  return pyodide.runPython("from js import labMarker\nstr(labMarker)");
}

async function numpy() {
  await pyodide.loadPackage("numpy");
  numpyVersion = pyodide.runPython("import numpy\nnumpy.__version__");
  if (numpyVersion !== "2.4.6") throw new Error("NumPy version mismatch");
  return pyodide.runPython("int(numpy.array([2, 3, 5]).sum())");
}

function loop() {
  return pyodide.runPython("while True:\n    pass");
}

const scenarios = {fixture, marker_default: markerDefault, marker_grant: markerGrant, bridge, numpy, loop};
self.onmessage = async function execute(event) {
  try {
    const message = event.data;
    if (message.run_id !== runId) throw new Error("wrong run ID");
    const value = await scenarios[message.scenario](message);
    const reply = {run_id: runId, status: "result", value};
    if (message.scenario === "numpy") reply.package_version = numpyVersion;
    self.postMessage(reply);
  } catch (error) {
    self.postMessage({run_id: runId, status: "error", detail: String(error)});
  }
};
initialize().catch(function setupError(error) {
  self.postMessage({run_id: runId, status: "setup_error", detail: String(error)});
});
