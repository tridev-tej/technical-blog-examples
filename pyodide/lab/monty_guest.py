
import json
import sys
from importlib.metadata import version
from pathlib import Path
from pydantic_monty import Monty, MontyRuntimeError


def read_marker():
    return Path(request["host_path"]).read_text()


def execute(session):
    scenario = request["scenario"]
    if scenario == "fixture":
        return session.feed_run(Path("task.py").read_text(), inputs={"values": [2, 3, 5]})
    if scenario == "marker_grant":
        return session.feed_run("read_marker()", external_lookup={"read_marker": read_marker})
    if scenario == "loop":
        return session.feed_run("while True:\n    pass")
    assert scenario == "marker_default"
    return session.feed_run("open(" + repr(request["host_path"]) + ").read()")


for name in ("pydantic-monty", "pydantic-monty-client", "pydantic-monty-runtime"):
    assert version(name) == "1.3.0", name
request = json.loads(sys.stdin.readline())
with Monty(max_processes=1, request_timeout=2, feed_duration_limit_grace=0.1) as pool:
    with pool.checkout(limits={"max_feed_duration_secs": 0.1}) as session:
        print(json.dumps({"run_id": request["run_id"], "status": "ready"}), flush=True)
        try:
            reply = {"status": "result", "value": execute(session)}
        except MontyRuntimeError as error:
            inner = error.exception()
            reply = {"status": "error", "phase": "feed_run", "detail": str(inner),
                     "wrapper_module": type(error).__module__, "wrapper_type": type(error).__name__,
                     "error_module": type(inner).__module__, "error_type": type(inner).__name__}
print(json.dumps({"run_id": request["run_id"], **reply}), flush=True)
