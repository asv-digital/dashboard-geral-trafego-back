// Seed self-contained: nao importa de src/ pra rodar sem precisar do
// codigo-fonte da aplicacao em runtime de prod (Dockerfile copia so dist).
// Roda no boot via Dockerfile CMD: npx tsx prisma/seed.ts
//
// Cria users a partir de SEED_*_EMAIL + SEED_*_PASSWORD envs. Idempotente —
// pula user que ja existe.

import "dotenv/config";
import bcrypt from "bcryptjs";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const adapter = new PrismaPg(pool);
const prisma = new PrismaClient({ adapter });

interface SeedUser {
  email: string;
  password: string;
  name: string;
  role: string;
}

function readSeedUsers(): SeedUser[] {
  const users: SeedUser[] = [];
  if (process.env.SEED_OWNER_EMAIL && process.env.SEED_OWNER_PASSWORD) {
    users.push({
      email: process.env.SEED_OWNER_EMAIL,
      password: process.env.SEED_OWNER_PASSWORD,
      name: "Bravy",
      role: "owner",
    });
  }
  if (process.env.SEED_CEO_EMAIL && process.env.SEED_CEO_PASSWORD) {
    users.push({
      email: process.env.SEED_CEO_EMAIL,
      password: process.env.SEED_CEO_PASSWORD,
      name: "CEO",
      role: "editor",
    });
  }
  if (process.env.SEED_COO_EMAIL && process.env.SEED_COO_PASSWORD) {
    users.push({
      email: process.env.SEED_COO_EMAIL,
      password: process.env.SEED_COO_PASSWORD,
      name: "COO",
      role: "editor",
    });
  }
  return users;
}

async function main() {
  const users = readSeedUsers();
  if (users.length === 0) {
    console.log("[seed] no SEED_*_EMAIL env vars set, skipping user seed");
    return;
  }

  for (const u of users) {
    const existing = await prisma.user.findUnique({ where: { email: u.email } });
    if (existing) {
      console.log(`[seed] user ${u.email} already exists, skipping`);
      continue;
    }
    const passwordHash = await bcrypt.hash(u.password, 10);
    await prisma.user.create({
      data: { email: u.email, name: u.name, role: u.role, passwordHash },
    });
    console.log(`[seed] created user ${u.email} (${u.role})`);
  }
}

main()
  .catch(err => {
    console.error(err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
