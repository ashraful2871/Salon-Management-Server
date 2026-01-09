import bcrypt from 'bcryptjs';
import prisma from '../shared/prisma';

export const seedAdmin = async () => {
  try {
    // Check if admin already exists
    const adminExists = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
    });

    if (!adminExists) {
      console.log('Seeding admin user...');

      const hashedPassword = await bcrypt.hash('admin123456', 12);

      await prisma.$transaction(async (tx: any) => {
        const admin = await tx.user.create({
          data: {
            email: 'admin@salon.com',
            password: hashedPassword,
            name: 'System Admin',
            role: 'ADMIN',
            status: 'ACTIVE',
          },
        });

        await tx.admin.create({
          data: {
            userId: admin.id,
            canManageUsers: true,
            canManageSalons: true,
            canManageServices: true,
            canViewReports: true,
          },
        });
      });

      console.log('Admin user seeded successfully!');
      console.log('Email: admin@salon.com');
      console.log('Password: admin123456');
    }
  } catch (error) {
    console.error('Error seeding admin:', error);
  }
};
