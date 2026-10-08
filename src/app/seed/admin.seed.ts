import { Prisma } from '@prisma/client';
import bcrypt from 'bcryptjs';
import prisma from '../shared/prisma';

/**
 * Development convenience only: a well-known admin login on an empty database.
 * In production the first admin comes from `npm run admin:create`, which sets
 * no password and emails a set-password link instead.
 */
export const seedAdmin = async () => {
  if (
    process.env.NODE_ENV === 'production' &&
    process.env.ALLOW_DEFAULT_ADMIN !== 'true'
  ) {
    return;
  }

  try {
    // Check if admin already exists
    const adminExists = await prisma.user.findFirst({
      where: { role: 'ADMIN' },
    });

    if (!adminExists) {
      const hashedPassword = await bcrypt.hash('admin123456', 12);

      await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const admin = await tx.user.create({
          data: {
            email: 'admin@salon.com',
            password: hashedPassword,
            name: 'System Admin',
            role: 'ADMIN',
            status: 'ACTIVE',
            emailVerified: true,
            emailVerifiedAt: new Date(),
          },
        });

        await tx.admin.create({
          data: {
            userId: admin.id,
            canManageUsers: true,
            canManageSalons: true,
            canManageServices: true,
            canViewReports: true,
            adminRole: "SUPER_ADMIN",
          },
        });
      });

      console.log(
        '[seed] dev admin admin@salon.com created — change its password',
      );
    }
  } catch (error) {
    console.error('Error seeding admin:', error);
  }
};
