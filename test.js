const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
async function run() {
  const salons = await prisma.$queryRaw`SELECT COUNT(*) FROM salons WHERE embedding IS NOT NULL`;
  console.log("Salons with embeddings:", salons);
}
run().catch(console.error).finally(() => prisma.$disconnect());
