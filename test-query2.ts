import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const slots = await prisma.slot.findMany({ 
    where: { date: new Date('2026-09-14') }
  });
  console.log(JSON.stringify(slots, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
