import { StatusCodes } from 'http-status-codes';
import ApiError from '../../Error/error';
import prisma from '../../shared/prisma';

const getAdminDashboardStats = async () => {
  const [
    totalUsers,
    totalSalons,
    totalAppointments,
    totalRevenue,
    recentAppointments,
    salonsByStatus,
  ] = await Promise.all([
    prisma.user.count({ where: { isDeleted: false } }),
    prisma.salon.count({ where: { isDeleted: false } }),
    prisma.appointment.count(),
    prisma.payment.aggregate({
      where: { status: 'COMPLETED' },
      _sum: { amount: true },
    }),
    prisma.appointment.findMany({
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: {
          select: { name: true, email: true },
        },
        salon: {
          select: { name: true },
        },
        service: {
          select: { name: true, price: true },
        },
      },
    }),
    prisma.salon.groupBy({
      by: ['status'],
      _count: true,
      where: { isDeleted: false },
    }),
  ]);

  return {
    totalUsers,
    totalSalons,
    totalAppointments,
    totalRevenue: totalRevenue._sum.amount || 0,
    recentAppointments,
    salonsByStatus,
  };
};

const getSalonOwnerDashboardStats = async (userId: string) => {
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
    include: { salons: { select: { id: true } } },
  });

  if (!salonOwner) {
    throw new ApiError(StatusCodes.FORBIDDEN, 'Only salon owners can access this route');
  }

  const salonIds = salonOwner.salons.map((s) => s.id);

  const [
    totalSalons,
    totalServices,
    totalStaff,
    totalAppointments,
    totalRevenue,
    recentAppointments,
    appointmentsByStatus,
  ] = await Promise.all([
    prisma.salon.count({
      where: { ownerId: salonOwner.id, isDeleted: false },
    }),
    prisma.service.count({
      where: { salonId: { in: salonIds }, isDeleted: false },
    }),
    prisma.staff.count({
      where: { salonId: { in: salonIds }, isDeleted: false },
    }),
    prisma.appointment.count({
      where: { salonId: { in: salonIds } },
    }),
    prisma.payment.aggregate({
      where: {
        status: 'COMPLETED',
        appointment: { salonId: { in: salonIds } },
      },
      _sum: { amount: true },
    }),
    prisma.appointment.findMany({
      where: { salonId: { in: salonIds } },
      take: 10,
      orderBy: { createdAt: 'desc' },
      include: {
        customer: {
          select: { name: true, email: true, phone: true },
        },
        service: {
          select: { name: true, price: true },
        },
        staff: {
          include: {
            user: {
              select: { name: true },
            },
          },
        },
      },
    }),
    prisma.appointment.groupBy({
      by: ['status'],
      _count: true,
      where: { salonId: { in: salonIds } },
    }),
  ]);

  return {
    totalSalons,
    totalServices,
    totalStaff,
    totalAppointments,
    totalRevenue: totalRevenue._sum.amount || 0,
    recentAppointments,
    appointmentsByStatus,
  };
};

const getCustomerDashboardStats = async (userId: string) => {
  const [
    totalAppointments,
    completedAppointments,
    upcomingAppointments,
    totalSpent,
    recentAppointments,
  ] = await Promise.all([
    prisma.appointment.count({
      where: { customerId: userId },
    }),
    prisma.appointment.count({
      where: { customerId: userId, status: 'COMPLETED' },
    }),
    prisma.appointment.count({
      where: {
        customerId: userId,
        status: { in: ['PENDING', 'CONFIRMED'] },
        appointmentDate: { gte: new Date() },
      },
    }),
    prisma.payment.aggregate({
      where: {
        status: 'COMPLETED',
        appointment: { customerId: userId },
      },
      _sum: { amount: true },
    }),
    prisma.appointment.findMany({
      where: { customerId: userId },
      take: 5,
      orderBy: { appointmentDate: 'desc' },
      include: {
        salon: {
          select: { name: true, address: true },
        },
        service: {
          select: { name: true, price: true, category: true },
        },
        staff: {
          include: {
            user: {
              select: { name: true },
            },
          },
        },
      },
    }),
  ]);

  return {
    totalAppointments,
    completedAppointments,
    upcomingAppointments,
    totalSpent: totalSpent._sum.amount || 0,
    recentAppointments,
  };
};

export const DashboardStatsService = {
  getAdminDashboardStats,
  getSalonOwnerDashboardStats,
  getCustomerDashboardStats,
};
