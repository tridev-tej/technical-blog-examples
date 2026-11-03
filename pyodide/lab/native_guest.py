
import json
import sys
from pathlib import Path


def execute(request):
    scenario = request["scenario"]
    if scenario == "fixture":
        source = Path(__file__).with_name("task.py").read_text()
        return eval(compile(source, "task.py", "eval"), {"values": request["values"]})
    if scenario in ("marker_default", "marker_grant"):
        return Path(request["host_path"]).read_text()
    if scenario == "loop":
        while True:
            pass
    raise ValueError("unknown scenario")


def main():
    request = json.loads(sys.stdin.readline())
    envelope = {"run_id": request["run_id"], "status": "ready"}
    print(json.dumps(envelope), flush=True)
    value = execute(request)
    print(json.dumps({"run_id": request["run_id"], "status": "result", "value": value}), flush=True)


if __name__ == "__main__":
    main()
