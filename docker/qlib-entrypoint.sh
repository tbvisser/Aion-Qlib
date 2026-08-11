#!/usr/bin/env bash
# Entrypoint for the Dockerfile.dev image.
#
# docker-compose.yml bind-mounts the host checkout over /qlib so edits take
# effect immediately. That mount also hides the Linux extensions the image
# built, and qlib/data/ops.py re-raises ImportError when they are missing --
# there is no pure-Python fallback. So rebuild them into the mount once.
#
# The macOS .so files in the same directory are named *-darwin.so and are left
# alone; both platforms' binaries coexist. All *.so are gitignored.
set -euo pipefail

LIBS_DIR=/qlib/qlib/data/_libs

if ! compgen -G "${LIBS_DIR}/rolling.cpython-*-linux-gnu.so" > /dev/null; then
    echo "[entrypoint] Linux Cython extensions not found in the mounted tree; building (~30s)..."
    cd /qlib
    python -c "from setuptools import setup, Extension; from Cython.Build import cythonize; import numpy; extensions = [Extension('qlib.data._libs.rolling', ['qlib/data/_libs/rolling.pyx'], language='c++', include_dirs=[numpy.get_include()]), Extension('qlib.data._libs.expanding', ['qlib/data/_libs/expanding.pyx'], language='c++', include_dirs=[numpy.get_include()])]; setup(ext_modules=cythonize(extensions, language_level='3'), script_args=['build_ext', '--inplace'])" > /tmp/build_ext.log 2>&1 \
        || { echo "[entrypoint] extension build FAILED:"; cat /tmp/build_ext.log; exit 1; }
    echo "[entrypoint] extensions built."
fi

exec "$@"
