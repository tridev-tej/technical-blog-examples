
import json
import os
import select
import signal
import subprocess
import sys
import time
import uuid
from pathlib import Path
from contract import accept_fixture, check


def ready_line(process):
    deadline = time.monotonic() + 30
    data = bytearray()
    while not data.endswith(b"\n"):
        remaining = deadline - time.monotonic()
        check(remaining > 0, "startup deadline")
        check(select.select([process.stdout], [], [], remaining)[0], "startup deadline")
        part = os.read(process.stdout.fileno(), 1)
        check(bool(part), "child exited before ready")
        data.extend(part)
        check(len(data) < 4096, "oversized ready line")
    return json.loads(data)


def stop_group(process):
    if getattr(process, "group_closed", False):
        return
    if process.returncode is None:
        os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT)
        if not getattr(process, "group_signalled", False):
            process.group_signalled = True
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait(timeout=5)
    process.group_closed = True
    try:
        os.killpg(process.pid, 0)
    except ProcessLookupError:
        return
    raise AssertionError("owned process group survived")


def child_exited(process):
    if process.returncode is not None:
        return True
    return os.waitid(os.P_PID, process.pid, os.WEXITED | os.WNOHANG | os.WNOWAIT) is not None


def collect_output(process, seconds):
    buffers = {process.stdout: bytearray(), process.stderr: bytearray()}
    active = list(buffers)
    deadline = time.monotonic() + seconds
    while active or not child_exited(process):
        remaining = deadline - time.monotonic()
        if remaining <= 0:
            return bytes(buffers[process.stdout]), bytes(buffers[process.stderr]), True
        for pipe in select.select(active, [], [], min(remaining, 0.05))[0]:
            data = os.read(pipe.fileno(), 65536)
            if data:
                buffers[pipe].extend(data)
            else:
                active.remove(pipe)
    return bytes(buffers[process.stdout]), bytes(buffers[process.stderr]), False


def run_case(engine, request):
    process = subprocess.Popen([sys.executable, engine + "_guest.py"],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
    output = errors = b""
    try:
        process.stdin.write(json.dumps(request).encode() + b"\n")
        process.stdin.close()
        process.stdin = None
        ready = ready_line(process)
        check(ready == {"run_id": request["run_id"], "status": "ready"}, "readiness")
        started = time.monotonic()
        seconds = 2 if engine == "monty" else 0.25
        output, errors, timed_out = collect_output(process, seconds)
        stop_group(process)
        reply = {"status": "outer_timeout"} if timed_out else json.loads(output)
        return {"request": request, "reply": reply, "exit": process.returncode,
                "ready": ready, "stdout": output.decode(), "stderr": errors.decode(),
                "elapsed": time.monotonic() - started}
    except Exception:
        stop_group(process)
        tail, diagnostic, _ = collect_output(process, 1)
        print(json.dumps({"request": request, "stdout": (output + tail).decode(),
                          "stderr": (errors + diagnostic).decode(), "exit": process.returncode}), file=sys.stderr)
        raise
    finally:
        try:
            stop_group(process)
        finally:
            process.stdout.close()
            process.stderr.close()


def verify_error(reply, category):
    fields = {"status", "phase", "wrapper_module", "wrapper_type", "error_module", "error_type"}
    check(fields.issubset(reply), "malformed error envelope")
    check(reply["status"] == "error", "expected guest error")
    check(reply["phase"] == "feed_run", "wrong error phase")
    check(reply["wrapper_module"] == "pydantic_monty", "wrong wrapper module")
    check(reply["wrapper_type"] == "MontyRuntimeError", "wrong wrapper type")
    check(reply["error_module"] == "builtins", "wrong inner module")
    check(reply["error_type"] == category, "wrong inner category")


def verify(row, engine):
    request, reply = row["request"], row["reply"]
    scenario = request["scenario"]
    if scenario == "loop" and engine == "native":
        check(reply["status"] == "outer_timeout", "native loop")
        return
    check(row["exit"] == 0, "guest exit")
    check(reply["run_id"] == request["run_id"], "run ID")
    if scenario == "fixture":
        check(accept_fixture(reply, request["run_id"], True), "fixture oracle")
    elif scenario == "loop":
        verify_error(reply, "TimeoutError")
    elif scenario == "marker_default" and engine == "monty":
        verify_error(reply, "PermissionError")
    else:
        check("value" in reply, "missing marker value")
        check(reply["status"] == "result" and reply["value"] == request["marker"], "marker")


def main():
    engine = sys.argv[1]
    if engine == "prepare":
        marker = "fixture-" + str(uuid.uuid4())
        Path("marker.txt").write_text(marker)
        Path("fixture.json").write_text(json.dumps({"marker": marker,
            "host_path": str(Path("marker.txt").resolve()), "values": [2, 3, 5]}))
        return
    check(sys.platform == "linux" and engine in ("native", "monty"), "Linux engine")
    fixture = json.loads(Path("fixture.json").read_text())
    for scenario in ("fixture", "marker_default", "marker_grant", "loop", "fixture"):
        request = {**fixture, "scenario": scenario, "run_id": str(uuid.uuid4())}
        row = run_case(engine, request)
        print(json.dumps(row), flush=True)
        verify(row, engine)
        check(Path(fixture["host_path"]).read_text() == fixture["marker"], "host marker changed")


if __name__ == "__main__":
    main()
