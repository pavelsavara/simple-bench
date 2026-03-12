#!/bin/sh
# Populate /bench/node_modules and /bench/bench/node_modules with symlinks to
# the image's pre-installed packages. When --via-docker mounts the host repo
# at /bench, --tmpfs masks the host's node_modules (which may contain
# Windows-only binaries). ESM import() doesn't honour NODE_PATH, so we create
# symlinks so that standard node_modules resolution finds the packages.

# Root dependencies (playwright etc.)
if [ -d /opt/bench-deps/node_modules ]; then
    mkdir -p /bench/node_modules
    for p in /opt/bench-deps/node_modules/* /opt/bench-deps/node_modules/.??*; do
        [ -e "$p" ] && ln -s "$p" /bench/node_modules/ 2>/dev/null
    done
fi

# Bench CLI dependencies (tsx, typescript etc.)
if [ -d /opt/bench-cli-deps/node_modules ]; then
    mkdir -p /bench/bench/node_modules
    for p in /opt/bench-cli-deps/node_modules/* /opt/bench-cli-deps/node_modules/.??*; do
        [ -e "$p" ] && ln -s "$p" /bench/bench/node_modules/ 2>/dev/null
    done
fi

exec "$@"
