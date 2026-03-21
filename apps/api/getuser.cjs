const { PrismaClient } = require('../../node_modules/.prisma/client');
const p = new PrismaClient();
async function main() {
  const users = await p.user.findMany({ select: { email: true, id: true } });
  console.log('USERS:', JSON.stringify(users));
  const brokers = await p.broker.findMany({
    select: { id: true, name: true, userId: true },
  });
  console.log('BROKERS:', JSON.stringify(brokers));
}
main().finally(() => p.$disconnect());
