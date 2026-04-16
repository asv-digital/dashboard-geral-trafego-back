import "dotenv/config";
import prisma from "../src/prisma";
import { hashPassword } from "../src/auth/session";

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
    const passwordHash = await hashPassword(u.password);
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
