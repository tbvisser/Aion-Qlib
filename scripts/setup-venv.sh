#!/usr/bin/env bash
# Create the .venv that webapp/dev.sh expects. This is the "see the repo setup"
# that dev.sh's error message points at.
#
#   ./scripts/setup-venv.sh
#
# Only needed for the bare-metal path. The Docker path (ONBOARDING.md) does all of
# this inside the image and needs no venv on the host.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

PYTHON_VERSION=3.11
VENV="$REPO_ROOT/.venv"

if command -v uv >/dev/null 2>&1; then
  echo "==> Creating $VENV (uv, python $PYTHON_VERSION)"
  uv venv --python "$PYTHON_VERSION" "$VENV"
  PIP_INSTALL=(uv pip install --python "$VENV/bin/python")
else
  echo "==> uv not found, falling back to python$PYTHON_VERSION -m venv"
  echo "    (uv is much faster: https://docs.astral.sh/uv/)"
  "python$PYTHON_VERSION" -m venv "$VENV"
  "$VENV/bin/python" -m pip install --upgrade pip setuptools wheel
  PIP_INSTALL=("$VENV/bin/python" -m pip install)
fi

# qlib's rolling/expanding operators are Cython. qlib/data/ops.py re-raises the
# ImportError with no pure-Python fallback, so this is mandatory, not an
# optimisation -- skip it and every expression-based feature fails at import.
echo "==> Building the Cython extensions (make prerequisite)"
"${PIP_INSTALL[@]}" cython numpy
PATH="$VENV/bin:$PATH" make prerequisite

echo "==> Installing qlib (editable) and the webapp dependencies"
"${PIP_INSTALL[@]}" -e ".[dev,test,analysis]" "pandas>=2.2,<3" numba
"${PIP_INSTALL[@]}" -r webapp/requirements.txt -r webapp/requirements-dev.txt

# mlflow >= 3.14 refuses to open a filesystem backend unless this is set, and the
# webapp's tracking store is a file store at examples/mlruns. runner.py sets it for
# the qrun subprocesses it spawns and Dockerfile.dev sets it image-wide, but a bare
# `qrun`, a notebook, or R.start() in this venv would still fail without it. A .pth
# is the only hook that runs early enough to beat mlflow's import-time check.
SITE_PACKAGES="$("$VENV/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["purelib"])')"
cat > "$SITE_PACKAGES/qlib_mlflow_file_store.pth" <<'PTH'
import os; os.environ.setdefault("MLFLOW_ALLOW_FILE_STORE", "true")
PTH
echo "==> Wrote $SITE_PACKAGES/qlib_mlflow_file_store.pth"

cat <<'DONE'

Done. Next:

  cp webapp/.env.example webapp/.env   # then add your EODHD + OpenRouter keys
  ./webapp/dev.sh both                 # API on :8770, UI on :5274

If ~/.qlib/qlib_data is empty the API answers 503 until you run the ingest --
see ONBOARDING.md.
DONE
