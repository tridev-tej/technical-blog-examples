mkdir -p lab || exit 1
python3.13 -m venv .venv || exit 1
.venv/bin/python -m pip install pydantic-monty==1.3.0 pydantic-monty-client==1.3.0 pydantic-monty-runtime==1.3.0 || exit 1
cd lab || exit 1
