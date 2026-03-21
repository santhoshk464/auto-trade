/* eslint-disable no-console */

const { PrismaClient } = require('@prisma/client');
const { PrismaBetterSqlite3 } = require('@prisma/adapter-better-sqlite3');

async function main() {
  const email = process.argv[2];
  const role = process.argv[3] || 'ADMIN';

  if (!email) {
    console.error('Usage: node scripts/set-user-role.js <email> [ROLE]');
    process.exitCode = 1;
    return;
  }

  // Prisma CLI loads env via prisma.config.ts, but plain node scripts do not.
  // Default to the local dev DB if DATABASE_URL isn't set.
  if (!process.env.DATABASE_URL) {
    process.env.DATABASE_URL = 'file:./dev.db';
  }

  const prisma = new PrismaClient({
    adapter: new PrismaBetterSqlite3({
      url: process.env.DATABASE_URL,
    }),
  });

  try {
    const user = await prisma.user.update({
      where: { email },
      data: { role },
      select: { id: true, email: true, role: true },
    });

    console.log('Updated user role:', user);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
