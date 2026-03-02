FROM ubuntu:24.04@sha256:b59d21599a2b151e7f6a8ac0589693d8af84a0b2a0cab87c2a91b611b917a6d0

# Avoid interactive prompts during package install
ENV DEBIAN_FRONTEND=noninteractive

# System packages
RUN apt-get update && apt-get install -y \
    curl git tar unzip jq python3 \
    libicu-dev libssl-dev zlib1g-dev \
    # Playwright system dependencies
    libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 \
    libxkbcommon0 libxcomposite1 libxdamage1 libxrandr2 libgbm1 \
    libpango-1.0-0 libcairo2 libasound2t64 libxshmfence1 \
    && rm -rf /var/lib/apt/lists/*

# Node.js 24.x (Current) — pinned major; patch comes from NodeSource repo snapshot
RUN curl -fsSL https://deb.nodesource.com/setup_24.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# V8 d8 via jsvu — pinned jsvu version
RUN npm install -g jsvu@2.2.1 \
    && jsvu --os=linux64 --engines=v8 \
    && ln -s /root/.jsvu/bin/v8 /usr/local/bin/d8

# Playwright — pinned to match package.json (exact version controls browser builds)
RUN npm install -g playwright@1.50.0 \
    && npx playwright install --with-deps chromium firefox

# Environment
ENV PLAYWRIGHT_BROWSERS_PATH=/root/.cache/ms-playwright
ENV DOTNET_ROOT=/opt/dotnet
ENV DOTNET_CLI_TELEMETRY_OPTOUT=1
ENV DOTNET_NOLOGO=1
ENV PATH="${DOTNET_ROOT}:${PATH}"
ENV ARTIFACTS_DIR=/bench/artifacts

# Create working directories
RUN mkdir -p $ARTIFACTS_DIR/sdk $ARTIFACTS_DIR/publish $ARTIFACTS_DIR/results $ARTIFACTS_DIR/logs

WORKDIR /bench
