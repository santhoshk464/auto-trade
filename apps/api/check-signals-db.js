const { PrismaClient } = require('../../node_modules/.prisma/client');
const p = new PrismaClient();

async function main() {
  const signals = await p.signal.findMany({
    take: 10,
    orderBy: { signalDate: 'desc' },
    select: {
      instrumentToken: true,
      symbol: true,
      strategy: true,
      signalDate: true,
      brokerId: true,
    },
  });
  console.log('Recent signals:', JSON.stringify(signals, null, 2));

  if (signals.length > 0) {
    const tokens = [...new Set(signals.map((s) => s.instrumentToken))];
    const insts = await p.instrument.findMany({
      where: { instrumentToken: { in: tokens } },
      select: { instrumentToken: true, tradingsymbol: true, expiry: true },
    });
    console.log('Matching instruments:', JSON.stringify(insts, null, 2));
  }
}

main().finally(() => p.$disconnect());
