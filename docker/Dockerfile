# Licensed to the .NET Foundation under one or more agreements.
# The .NET Foundation licenses this file to you under the MIT license.

# ═══════════════════════════════════════════════════════════════════════════════
# Stage: base — shared foundation for both build and measure images
# ═══════════════════════════════════════════════════════════════════════════════
FROM ubuntu:24.04 AS base

# Avoid interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# Common system packages (curl, git, tar, unzip, jq used by both workloads)
RUN apt-get update && apt-get install -y \
    curl git tar unzip jq python3 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24.x (Current) — pinned major; patch comes from NodeSource repo snapshot
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Common environment
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV ARTIFACTS_DIR=/bench/artifacts

# Create working directories
RUN mkdir -p $ARTIFACTS_DIR/sdk $ARTIFACTS_DIR/publish $ARTIFACTS_DIR/results $ARTIFACTS_DIR/logs

WORKDIR /bench

# ═══════════════════════════════════════════════════════════════════════════════
# Stage: browser-bench-build — .NET SDK prerequisites for building WASM apps
# ═══════════════════════════════════════════════════════════════════════════════
FROM base AS browser-bench-build

# .NET SDK native dependencies
RUN apt-get update && apt-get install -y \
    libicu-dev libssl-dev zlib1g-dev \
    # Emscripten / wasm-tools workload dependencies
    libatomic1 \
    && rm -rf /var/lib/apt/lists/*

ENV DOTNET_ROOT=/opt/dotnet
ENV PATH="${DOTNET_ROOT}:${PATH}"

# Pre-install npm dependencies so CI and local-docker-bench don't need npm ci
COPY package.json package-lock.json ./
RUN npm ci && rm -rf /root/.npm

# ═══════════════════════════════════════════════════════════════════════════════
# Stage: browser-bench-measure — JS engines + browsers for running benchmarks
# ═══════════════════════════════════════════════════════════════════════════════
FROM base AS browser-bench-measure

# Playwright system dependencies (browsers need these libs)
RUN apt-get update && apt-get install -y \
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Non-root user for running benchmarks.
# Firefox refuses to launch as root when $HOME is owned by another uid — which
# is exactly what GitHub Actions does (HOME=/github/home, owned by uid 1001).
# Running as a regular user side-steps the check entirely.
RUN useradd -u 1001 -m -s /bin/bash benchuser

# V8 d8 via jsvu — install then relocate to /opt/jsvu so any user can access it
RUN npm install -g jsvu@3.0.3 \
    && jsvu --os=linux64 --engines=v8 \
    && mkdir -p /opt/jsvu \
    && cp -a /root/.jsvu/. /opt/jsvu/ \
    && rm -rf /root/.jsvu \
    && ln -sf /opt/jsvu/bin/v8 /usr/local/bin/d8 \
    && chmod -R a+rX /opt/jsvu

# Pre-install npm dependencies (playwright is the key dependency)
COPY package.json package-lock.json ./
RUN npm ci && rm -rf /root/.npm \
    && chmod -R a+rX /bench/node_modules

# Playwright browsers — install to /opt/pw-browsers so any user can access them
ENV PLAYWRIGHT_BROWSERS_PATH=/opt/pw-browsers
RUN npx playwright install --with-deps chromium firefox \
    && chmod -R a+rX /opt/pw-browsers

USER benchuser
