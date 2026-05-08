# Multi-stage simples e correto pra Node + Prisma + TS.
#
# Builder: instala TUDO (deps + devDeps), gera Prisma client em
# node_modules/.prisma + node_modules/@prisma/client, compila TS pra dist/.
#
# Prod: copia node_modules e dist do builder em vez de reinstalar.
# Mantem devDeps (tsx) pra rodar prisma/seed.ts no boot.

FROM node:22-alpine AS builder
WORKDIR /app

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./
RUN npm ci

RUN npx prisma generate

COPY tsconfig.json ./
COPY src ./src/
RUN npm run build

# --- Production ---
FROM node:22-alpine
WORKDIR /app

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY --from=builder /app/prisma ./prisma
COPY --from=builder /app/prisma.config.ts ./
COPY --from=builder /app/package.json ./

EXPOSE 3001

# Boot: aplica schema (drop+create) → cria SEED_OWNER → starta servidor.
# --accept-data-loss e necessario em container nao-tty pra prisma push
# nao parar pedindo confirmacao quando schema mudou.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npx tsx prisma/seed.ts && node dist/server.js"]
