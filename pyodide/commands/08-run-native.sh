../.venv/bin/python run_native.py prepare || exit 1
../.venv/bin/python run_native.py native || exit 1
MONTY_BIN="$PWD/../.venv/bin/monty" ../.venv/bin/python run_native.py monty || exit 1
