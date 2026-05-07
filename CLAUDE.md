# Dashboard Geral Tráfego — Backend

Backend do agente de tráfego multi-produto.

## Stack

- Express 5 + TypeScript (CommonJS, tsx em dev)
- Prisma 7 + `@prisma/adapter-pg` (Postgres)
- S3 (`@aws-sdk/client-s3`) + multer pra uploads
- Anthropic SDK
- Auth: bcryptjs

## Comandos

```bash
npm run dev           # tsx watch src/server.ts
npm run build         # tsc
npm test              # tsx --test tests/*.test.ts
npm run db:migrate
npm run db:seed
npm run db:studio
```

## Convenções

- Front correspondente: `../dashboard-geral-trafego-front`. Mudanças de contrato precisam ser refletidas lá.
- Testes via `node --test` nativo (`tsx --test`), não Jest/Vitest.
- Pasta `var/` é runtime/scratch — não versionar conteúdo.
