command -v curl >/dev/null || exit 1
command -v sha256sum >/dev/null || exit 1
mkdir -p vendor/pyodide/314.0.7 || exit 1
cd vendor/pyodide/314.0.7 || exit 1
for asset in pyodide.mjs pyodide.asm.mjs pyodide.asm.wasm python_stdlib.zip pyodide-lock.json numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl; do
  curl --fail --max-time 60 -O "https://cdn.jsdelivr.net/pyodide/v314.0.7/full/$asset" || exit 1
done
printf 'a292c1f5d7d8a2208cd5e94fc467604c131cabcd2fc14fed6eefde121e7fabdf  numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl\n' | sha256sum -c - || exit 1
cd ../../.. || exit 1
