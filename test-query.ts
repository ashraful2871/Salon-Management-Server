import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const slots = await prisma.slot.findMany({ 
    include: { service: true }
  });
  console.log(JSON.stringify(slots.slice(0, 5), null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
