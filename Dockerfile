# AI Sales OS — production imajı (Coolify / herhangi bir Docker sunucusu)
FROM node:22-bookworm-slim AS base
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates && rm -rf /var/lib/apt/lists/*
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

# ── Bağımlılıklar ─────────────────────────────────────────────
FROM base AS deps
COPY package.json package-lock.json ./
COPY prisma ./prisma
RUN npm ci

# ── Build ────────────────────────────────────────────────────
FROM base AS build
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# Build sırasında veritabanına bağlanılmaz; Prisma istemcisi için geçici adres yeterli
ENV DATABASE_URL="postgresql://build:build@localhost:5432/build"
RUN npx prisma generate && npm run build

# ── Çalıştırma ───────────────────────────────────────────────
FROM base AS runner
ENV NODE_ENV=production
ENV PORT=3000
COPY --from=build /app ./
RUN mkdir -p /app/storage && chmod +x /app/docker/start.sh
EXPOSE 3000
HEALTHCHECK --interval=15s --timeout=5s --start-period=60s --retries=5 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"
CMD ["/app/docker/start.sh"]
