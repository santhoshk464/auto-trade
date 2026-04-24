const { PrismaClient } = require('@prisma/client');
const p = new PrismaClient({
  datasources: { db: { url: 'file:./prisma/dev.db' } },
});
p.liveTrade
  .findMany({
    where: { createdAt: { gte: new Date('2026-04-10') } },
    orderBy: { createdAt: 'desc' },
    take: 20,
    select: {
      id: true,
      optionSymbol: true,
      status: true,
      entryFilledPrice: true,
      targetPrice: true,
      targetOrderId: true,
      slOrderId: true,
      entryOrderId: true,
      hedgeOrderId: true,
      errorMessage: true,
      createdAt: true,
      pnl: true,
    },
  })
  .then((r) => {
    console.log(JSON.stringify(r, null, 2));
    p.$disconnect();
  })
  .catch((e) => {
    console.error(e.message);
    p.$disconnect();
  });
