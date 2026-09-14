import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  await prisma.slot.deleteMany({ where: { serviceId: null } });
  console.log('Cleaned up null slots');
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
