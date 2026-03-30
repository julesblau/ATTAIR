# ATTAIRE Discord Bot — Production Dockerfile
# Runs the Discord bot with Anthropic SDK, git, and Node.js
# No Claude CLI dependency — uses API directly

FROM node:20-slim

# Install git and basic tools needed for agent operations
RUN apt-get update && apt-get install -y --no-install-recommends \
    git \
    curl \
    ca-certificates \
    openssh-client \
    && rm -rf /var/lib/apt/lists/*

# Install Playwright Chromium (needed for screenshot capture during builds)
RUN npx playwright install --with-deps chromium

# Configure git for commits inside the container
RUN git config --global user.email "bot@attaire.app" && \
    git config --global user.name "ATTAIRE Bot" && \
    git config --global init.defaultBranch main

# Set working directory
WORKDIR /app

# Copy package files first for better layer caching
COPY agents/package.json agents/package-lock.json* ./agents/

# Install bot dependencies
WORKDIR /app/agents
RUN npm install --production

# Copy the full repo (bot needs access to the codebase for builds)
WORKDIR /app
COPY . .

# Install backend dependencies (needed for npm test during builds)
WORKDIR /app/attair-backend
RUN npm install --production 2>/dev/null || true

# Back to app root
WORKDIR /app

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=10s --retries=3 \
    CMD curl -f http://localhost:${HEALTH_PORT:-8081}/health || exit 1

# Expose health check port
EXPOSE ${HEALTH_PORT:-8081}

# Environment
ENV NODE_ENV=production
ENV HOSTED=true
ENV REPO_ROOT=/app

# Start the bot
CMD ["node", "agents/discord-bot.js"]
