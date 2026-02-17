# ── Stage 1: Builder ────────────────────────────────────────────────────────
FROM node:20-alpine AS builder

WORKDIR /app

# Install dependencies (separate layer for caching)
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

# Copy source and compile TypeScript
COPY tsconfig.json ./
COPY src/ ./src/
RUN npm run build

# Prune dev dependencies
RUN npm prune --production

# ── Stage 2: Production ──────────────────────────────────────────────────────
FROM node:20-alpine AS production

# Create non-root user
RUN addgroup -g 1001 router && \
    adduser -u 1001 -G router -s /bin/sh -D router

WORKDIR /app

# Copy built artifacts and production deps
COPY --from=builder --chown=router:router /app/dist ./dist
COPY --from=builder --chown=router:router /app/node_modules ./node_modules
COPY --from=builder --chown=router:router /app/package.json ./package.json

# Switch to non-root user
USER router

# Expose port
EXPOSE 3000

# Health check
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
    CMD wget -qO- http://localhost:3000/health || exit 1

# Start the server
CMD ["node", "dist/server.js"]
