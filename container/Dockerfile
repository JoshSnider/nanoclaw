# NanoClaw Agent Container
# Runs Claude Agent SDK in isolated Linux VM with browser automation

FROM node:22-slim

# Install system dependencies for Chromium
RUN apt-get update && apt-get install -y \
    chromium \
    fonts-liberation \
    fonts-noto-cjk \
    fonts-noto-color-emoji \
    libgbm1 \
    libnss3 \
    libatk-bridge2.0-0 \
    libgtk-3-0 \
    libx11-xcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxrandr2 \
    libasound2 \
    libpangocairo-1.0-0 \
    libcups2 \
    libdrm2 \
    libxshmfence1 \
    curl \
    git \
    && rm -rf /var/lib/apt/lists/*

# Set Chromium path for agent-browser
ENV AGENT_BROWSER_EXECUTABLE_PATH=/usr/bin/chromium
ENV PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH=/usr/bin/chromium

# Install agent-browser and claude-code globally
RUN npm install -g agent-browser @anthropic-ai/claude-code

# Create app directory
WORKDIR /app

# Copy package files first for better caching
COPY agent-runner/package*.json ./

# Install dependencies
RUN npm install

# Copy source code
COPY agent-runner/ ./

# Build TypeScript
RUN npm run build

# Create workspace directories
RUN mkdir -p /workspace/group /workspace/shared /workspace/extra /workspace/ipc/messages /workspace/ipc/tasks /workspace/ipc/input

# Precompile agent-runner so containers start without a tsc step
RUN npx tsc --outDir /app/prebuilt 2>&1 >&2 && \
    ln -s /app/node_modules /app/prebuilt/node_modules && \
    # Store a checksum of the source so the entrypoint can detect modifications
    find /app/src -type f -name '*.ts' -exec md5sum {} + | sort | md5sum | cut -d' ' -f1 > /app/prebuilt/.src-checksum

# Create entrypoint script
# Uses prebuilt output unless the mounted /app/src has been modified
# Secrets are passed via stdin JSON — temp file is deleted immediately after Node reads it
# Follow-up messages arrive via IPC files in /workspace/ipc/input/
RUN printf '#!/bin/bash\nset -e\nPREBUILT_SUM=$(cat /app/prebuilt/.src-checksum 2>/dev/null || echo none)\nCURRENT_SUM=$(find /app/src -type f -name "*.ts" -exec md5sum {} + | sort | md5sum | cut -d" " -f1)\nif [ "$PREBUILT_SUM" = "$CURRENT_SUM" ]; then\n  DIST=/app/prebuilt\nelse\n  cd /app && npx tsc --outDir /tmp/dist 2>&1 >&2\n  ln -s /app/node_modules /tmp/dist/node_modules\n  DIST=/tmp/dist\nfi\ncat > /tmp/input.json\nnode $DIST/index.js < /tmp/input.json\n' > /app/entrypoint.sh && chmod +x /app/entrypoint.sh

# Set ownership to node user (non-root) for writable directories
RUN chown -R node:node /workspace && chmod 777 /home/node

# Switch to non-root user (required for --dangerously-skip-permissions)
USER node

# Set working directory to group workspace
WORKDIR /workspace/group

# Entry point reads JSON from stdin, outputs JSON to stdout
ENTRYPOINT ["/app/entrypoint.sh"]
