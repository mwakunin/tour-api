# ============================================
# Stage 1: Base - Minimal Alpine setup
# ============================================
FROM node:26-alpine AS base

# Install pnpm directly - bypass corepack network issues
RUN npm install -g pnpm@11.17.0

# Only install essentials (removed curl - use wget for healthcheck)
RUN apk add --no-cache dumb-init

# Create non-root user
RUN addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

# ============================================
# Stage 2: Dependencies
# ============================================
FROM base AS dependencies

# Copy only package files
COPY package.json pnpm-lock.yaml .npmrc ./

ENV HUSKY=0
# Install ALL dependencies for building
RUN pnpm install --frozen-lockfile --ignore-scripts

# ============================================
# Stage 3: Development
# ============================================
FROM base AS development

# Copy dependencies
COPY --from=dependencies /app/node_modules ./node_modules

# Copy all source files
COPY --chown=nodejs:nodejs . .

USER nodejs

EXPOSE 3000

ENV NODE_ENV=development
ENV PORT=3000

ENTRYPOINT ["dumb-init", "--"]
CMD ["pnpm", "dev"]
# ============================================
# Stage 4: Production Dependencies (Minimal)
# ============================================
FROM base AS prod-dependencies

COPY package.json pnpm-lock.yaml ./

# Install ONLY production dependencies
# Add --no-optional to skip optional dependencies
RUN pnpm install --frozen-lockfile --prod --no-optional --ignore-scripts && \
    # Clean pnpm cache
    pnpm store prune && \
    # Remove unnecessary files
    rm -rf /root/.cache /root/.local/share/pnpm
  
# ============================================
# Stage 5: Production (Minimal runtime)
# ============================================
FROM node:26-alpine AS production

# Only install dumb-init (no curl needed)
RUN apk add --no-cache dumb-init && \
    # Create non-root user
    addgroup -g 1001 -S nodejs && \
    adduser -S nodejs -u 1001 -G nodejs

WORKDIR /app

ENV NODE_ENV=production

# Copy only what's needed from prod-dependencies
COPY --chown=nodejs:nodejs --from=prod-dependencies /app/node_modules ./node_modules

# Copy only essential files (no source maps, tests, etc.)
COPY --chown=nodejs:nodejs package.json start.js ./
COPY --chown=nodejs:nodejs drizzle/ ./drizzle/
COPY --chown=nodejs:nodejs src/ ./src/

# Remove any development files that might have been copied
RUN find . -name "*.test.js" -delete && \
    find . -name "*.spec.js" -delete && \
    find . -name "*.map" -delete && \
    find . -name ".git*" -delete && \
    rm -rf ./src/__tests__ ./src/tests

USER nodejs

EXPOSE 3000

# Use wget instead of curl for healthcheck (Alpine has wget by default).
# start-period covers the worst-case boot: 5 database attempts at a 30s
# connect_timeout plus backoff is ~2m42s, so 40s would mark a container
# unhealthy while it was still legitimately retrying.
HEALTHCHECK --interval=30s --timeout=10s --start-period=180s --retries=3 \
    CMD wget --no-verbose --tries=1 --spider http://localhost:3000/api/health || exit 1

ENTRYPOINT ["dumb-init", "--"]
CMD ["node", "--max-old-space-size=1024", "start.js"]
