const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

async function main() {
  const apps = await prisma.appointment.findMany({
    take: 5,
    orderBy: { createdAt: 'desc' },
    include: { service: true, salon: true }
  });
  console.log(JSON.stringify(apps, null, 2));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
