# ==========================================
# Stage 1: Build Go VoIP engine binary
# ==========================================
FROM golang:alpine AS go-builder

WORKDIR /build

COPY wacalls-service/go.mod wacalls-service/go.sum ./
RUN go mod download

COPY wacalls-service/ ./
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o /build/wacalls ./cmd/server

# ==========================================
# Stage 2: Build TypeScript source code
# ==========================================
FROM node:22-alpine AS ts-builder

WORKDIR /app

COPY package*.json tsconfig.json ./
RUN npm ci

COPY src/ ./src/
RUN npm run build

# ==========================================
# Stage 3: Minimal Production Image (<150MB)
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
COPY --from=ts-builder /app/dist ./dist
COPY public/ ./public/

# Copy compiled Go VoIP engine binary
COPY --from=go-builder /build/wacalls /usr/local/bin/wacalls
RUN chmod +x /usr/local/bin/wacalls

# Create persistent storage directories
RUN mkdir -p /app/.sessions /app/.media && chown -R node:node /app

USER node

EXPOSE 3000

HEALTHCHECK --interval=30s --timeout=5s --start-period=5s --retries=3 \
  CMD wget --quiet --tries=1 --spider http://127.0.0.1:3000/ping || exit 1

CMD ["node", "dist/index.js"]
