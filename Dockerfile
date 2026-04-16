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

RUN npm ci --omit=dev

COPY --from=builder /app/generated ./generated/
COPY --from=builder /app/node_modules/.prisma ./node_modules/.prisma/
COPY --from=builder /app/dist ./dist/

EXPOSE 3001

CMD ["sh", "-c", "npx prisma db push && node dist/server.js"]
