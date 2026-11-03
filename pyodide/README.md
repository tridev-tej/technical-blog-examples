# Python execution comparison lab

Use a fresh user-owned directory on Linux x86_64 with CPython 3.13.14, pip, curl and sha256sum. Browser cases need module workers. Assertions must stay enabled. The selected Monty metapackage, client and runtime are 1.3.0. Selected browser assets are Pyodide 314.0.7, reporting Python 3.14.2, and NumPy 2.4.6.

From this companion's root:

```sh
sha256sum -c MANIFEST.sha256
python3.13 --version
sh commands/01-setup.sh
cd lab
sh ../commands/08-run-native.sh
sh ../commands/09-stage-assets.sh
sh ../commands/13-serve.sh
```

Require `Python 3.13.14` before setup. Each command file exits on its own install, download, checksum or lab failure. Stop on failure and fix its cause. The setup script runs in a subshell, so the explicit `cd lab` above is required. Keep `.venv` beside `lab`, outside the served directory.

Check loopback port 43126 is free before the final command. Open `http://127.0.0.1:43126/`, click **Run fixed cases**, and retain the seven rows and any browser errors. The server exposes only `lab/`. Stop it with Ctrl-C.

Native and Monty sequences each contain five cases: fixture, default file read, supplied read, loop, fresh fixture. Both fixture results must be count 3/sum 10. Native default and supplied reads use ordinary host permissions. Monty's default read must return `MontyRuntimeError` wrapping built-in `PermissionError` in `feed_run`; its loop must wrap built-in `TimeoutError` at that phase. An outer timeout is not that Monty result. Browser cases add the JavaScript bridge and NumPy. Its default read returns the caught `FileNotFoundError` string; copying bytes to MEMFS supplies the file. Compare `marker.txt` with the marker in `fixture.json` after execution.

This packaged copy has not been executed as a new installation. Those results do not establish a fresh pip install, package parity, performance, language-model reliability or containment of arbitrary code.

The 30-second native ready-line clock begins after process creation and input write/close. Browser fixture fetch/body parsing has a separate 29-second abort deadline. Monty's feed clock excludes host suspension and fed-source compilation; host callback work needs its own deadline policy. The article explains the remaining lifecycle and memory limits.
