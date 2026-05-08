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

COPY package*.json ./
COPY prisma ./prisma/
COPY prisma.config.ts ./

# Mantem devDependencies em prod pra que tsx esteja disponivel no seed runtime
# (prisma/seed.ts e .ts, precisa de tsx). Custo ~50MB extra de imagem,
# benefício é poder rodar seed e qualquer one-off via tsx sem rebuild.
RUN npm ci

COPY --from=builder /app/generated ./generated/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma/
COPY --from=builder /app/dist ./dist/
COPY tsconfig.json ./
COPY src ./src/

EXPOSE 3001

# Boot: aplica schema (drop+create se mudou), roda seed (cria SEED_OWNER se
# nao existe), starta servidor compilado. --accept-data-loss e necessario
# pra prisma push nao parar pedindo confirmacao em container nao-tty.
CMD ["sh", "-c", "npx prisma db push --accept-data-loss && npx tsx prisma/seed.ts && node dist/server.js"]
