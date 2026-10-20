# ==========================================
# Stage 1: Build TypeScript source code
# ==========================================
FROM node:22-alpine AS builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ==========================================
# Stage 2: Minimal Production Image (<120MB)
# ==========================================
FROM node:22-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production
ENV PORT=3000
ENV HOST=0.0.0.0
ENV SESSIONS_DIR=/app/.sessions
ENV MEDIA_DIR=/app/.media

# Copy package manifests and install only production dependencies
COPY package*.json ./
RUN npm ci --omit=dev && npm cache clean --force

# Copy compiled JavaScript output
COPY --from=builder /app/dist ./dist

# Create persistent storage directories
RUN mkdir -p /app/.sessions /app/.media && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/ping || exit 1

CMD ["node", "dist/index.js"]
