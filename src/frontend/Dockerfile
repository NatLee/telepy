# syntax=docker/dockerfile:1
FROM node:20-alpine AS builder

WORKDIR /app
COPY package*.json ./
# npm 的下載快取放在 BuildKit cache mount（#54），不進 layer；npm ci 依 lockfile 安裝（可重現）。
# The npm download cache lives in a BuildKit cache mount (#54); npm ci installs exactly the lockfile.
RUN --mount=type=cache,id=telepy-npm,target=/root/.npm \
    npm ci --no-audit --no-fund

COPY . .
# Next.js bakes NEXT_PUBLIC_* at build time; pass via: docker compose build --build-arg NEXT_PUBLIC_GOOGLE_CLIENT_ID=your-client-id
ARG NEXT_PUBLIC_GOOGLE_CLIENT_ID
ENV NEXT_PUBLIC_GOOGLE_CLIENT_ID=${NEXT_PUBLIC_GOOGLE_CLIENT_ID}
# Next.js 的增量編譯快取（.next/cache）也跨 build 保留。/ Next's incremental build cache survives too.
RUN --mount=type=cache,id=telepy-next-cache,target=/app/.next/cache \
    npm run build

# Production image
FROM node:20-alpine AS runner

WORKDIR /app

ENV NODE_ENV=production

# Copy necessary standalone files
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
COPY --from=builder /app/public ./public

EXPOSE 3000

CMD ["node", "server.js"]
