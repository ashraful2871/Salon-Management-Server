import { PrismaClient } from '@prisma/client';
const prisma = new PrismaClient();

async function main() {
  const service = await prisma.service.findFirst();
  if(!service) return;
  const slot = await prisma.slot.create({ 
    data: { 
      salonId: service.salonId, 
      serviceId: service.id, 
      date: new Date('2026-09-15'), 
      startTime: '09:00', 
      endTime: '09:30' 
    } 
  });
  console.log(JSON.stringify(slot)); 
}

main().catch(console.error).finally(() => prisma.$disconnect());
