#!/bin/sh
# Populate /bench/node_modules with symlinks to the image's pre-installed
# packages. When --via-docker mounts the host repo at /bench, --tmpfs masks
# the host's node_modules (which may contain Windows-only binaries).
# ESM import() doesn't honour NODE_PATH, so we create symlinks so that
# standard node_modules resolution finds the packages.

if [ -d /opt/bench-deps/node_modules ]; then
    for p in /opt/bench-deps/node_modules/* /opt/bench-deps/node_modules/.??*; do
        [ -e "$p" ] && ln -s "$p" /bench/node_modules/ 2>/dev/null
    done
fi

exec "$@"
