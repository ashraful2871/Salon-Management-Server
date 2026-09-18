import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import {
  getPlatformEarnings,
  getSalonEarnings,
} from "../Settlement/settlement.earnings";
import { WalletService } from "../Wallet/wallet.service";

/**
 * Every money figure on a dashboard comes from `settlement.earnings`, which
 * derives it from the ledger. Nothing here recomputes a total of its own - two
 * definitions of "revenue" in two files is how a dashboard ends up disagreeing
 * with the payout it is sitting next to.
 *
 * Amounts are poisha under `Minor` names; `sendResponse` adds the taka twins.
 */

const dayBounds = () => {
  const start = new Date();
  start.setHours(0, 0, 0, 0);
  const end = new Date();
  end.setHours(23, 59, 59, 999);
  return { start, end };
};

const getAdminDashboardStats = async () => {
  const { start: todayStart, end: todayEnd } = dayBounds();

  const [
    totalUsers,
    totalSalons,
    totalAppointments,
    todayAppointments,
    pendingAppointments,
    usersByRole,
    recentAppointments,
    salonsByStatus,
    appointmentsByStatus,
    earnings,
    recentPayouts,
  ] = await Promise.all([
    prisma.user.count({ where: { isDeleted: false } }),
    prisma.salon.count({ where: { isDeleted: false } }),
    prisma.appointment.count(),
    prisma.appointment.count({
      where: { appointmentDate: { gte: todayStart, lte: todayEnd } },
    }),
    prisma.appointment.count({ where: { status: "PENDING" } }),
    prisma.user.groupBy({
      by: ["role"],
      _count: true,
      where: { isDeleted: false },
    }),
    prisma.appointment.findMany({
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { name: true, email: true } },
        salon: { select: { name: true } },
        service: { select: { name: true, priceMinor: true } },
      },
    }),
    prisma.salon.groupBy({
      by: ["status"],
      _count: true,
      where: { isDeleted: false },
    }),
    prisma.appointment.groupBy({ by: ["status"], _count: true }),
    getPlatformEarnings(),
    prisma.payout.findMany({
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { salon: { select: { id: true, name: true } } },
    }),
  ]);

  const roleCount = (role: string) =>
    usersByRole.find((row) => row.role === role)?._count ?? 0;

  return {
    totalUsers,
    totalCustomers: roleCount("CUSTOMER"),
    totalSalonOwners: roleCount("SALON_OWNER"),
    totalStaff: roleCount("STAFF"),
    totalAgents: roleCount("AGENT"),
    totalSalons,
    activeSalons:
      salonsByStatus.find((row) => row.status === "ACTIVE")?._count ?? 0,
    pendingSalons:
      salonsByStatus.find((row) => row.status === "PENDING_APPROVAL")?._count ??
      0,
    totalAppointments,
    todayAppointments,
    pendingAppointments,
    completedAppointments:
      appointmentsByStatus.find((row) => row.status === "COMPLETED")?._count ??
      0,
    usersByRole,

    // Money. `totalRevenueMinor` is what the platform itself earned - the
    // commission - not the value of everything booked through it. That gross
    // figure is `grossBookingsMinor`, and conflating the two is what made the
    // old card read as though every taka a customer spent was ours.
    totalRevenueMinor: earnings.platformRevenueMinor,
    grossBookingsMinor: earnings.grossBookingsMinor,
    salonEarningsMinor: earnings.salonEarningsMinor,
    monthRevenueMinor: earnings.monthRevenueMinor,
    todayRevenueMinor: earnings.todayRevenueMinor,
    salonPayableMinor: earnings.salonPayableMinor,
    pendingPayoutMinor: earnings.pendingPayoutMinor,
    pendingPayoutCount: earnings.pendingPayoutCount,
    paidOutMinor: earnings.paidOutMinor,
    failedPayoutMinor: earnings.failedPayoutMinor,
    walletFloatMinor: earnings.walletFloatMinor,
    walletHeldMinor: earnings.walletHeldMinor,
    depositsHeldMinor: earnings.depositsHeldMinor,
    forfeitedDepositMinor: earnings.forfeitedDepositMinor,
    topupVolumeMinor: earnings.topupVolumeMinor,
    averageTicketMinor: earnings.averageTicketMinor,
    effectiveCommissionPercent: earnings.effectiveCommissionPercent,
    standardCommissionPercent: earnings.standardCommissionPercent,
    monthlyEarnings: earnings.monthly,

    recentAppointments,
    recentPayouts,
    salonsByStatus,
    appointmentsByStatus,
  };
};

const getSalonOwnerDashboardStats = async (userId: string) => {
  const salonOwner = await prisma.salonOwner.findUnique({
    where: { userId },
    include: { salons: { select: { id: true, name: true } } },
  });

  if (!salonOwner) {
    throw new ApiError(
      StatusCodes.FORBIDDEN,
      "Only salon owners can access this route",
    );
  }

  const salonIds = salonOwner.salons.map((salon) => salon.id);
  const { start: todayStart, end: todayEnd } = dayBounds();

  const [
    totalSalons,
    totalServices,
    totalStaff,
    totalAppointments,
    todayAppointments,
    pendingAppointments,
    uniqueCustomers,
    recentAppointments,
    appointmentsByStatus,
    earnings,
    wallet,
    recentPayouts,
  ] = await Promise.all([
    prisma.salon.count({ where: { ownerId: salonOwner.id, isDeleted: false } }),
    prisma.service.count({
      where: { salonId: { in: salonIds }, isDeleted: false },
    }),
    prisma.staff.count({
      where: { salonId: { in: salonIds }, isDeleted: false },
    }),
    prisma.appointment.count({ where: { salonId: { in: salonIds } } }),
    prisma.appointment.count({
      where: {
        salonId: { in: salonIds },
        appointmentDate: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.appointment.count({
      where: { salonId: { in: salonIds }, status: "PENDING" },
    }),
    prisma.appointment
      .groupBy({
        by: ["customerId"],
        where: { salonId: { in: salonIds } },
      })
      .then((rows) => rows.length),
    prisma.appointment.findMany({
      where: { salonId: { in: salonIds } },
      take: 10,
      orderBy: { createdAt: "desc" },
      include: {
        customer: { select: { name: true, email: true, phone: true } },
        salon: { select: { name: true } },
        service: { select: { name: true, priceMinor: true } },
        staff: { include: { user: { select: { name: true } } } },
      },
    }),
    prisma.appointment.groupBy({
      by: ["status"],
      _count: true,
      where: { salonId: { in: salonIds } },
    }),
    getSalonEarnings(salonIds),
    // The owner's own wallet, so the dashboard can show balance and payouts
    // side by side instead of sending them to a second screen to find out.
    WalletService.getWalletSummary(userId),
    prisma.payout.findMany({
      where: { salonId: { in: salonIds } },
      take: 5,
      orderBy: { createdAt: "desc" },
      include: { salon: { select: { id: true, name: true } } },
    }),
  ]);

  return {
    totalSalons,
    totalServices,
    totalStaff,
    totalAppointments,
    todayAppointments,
    pendingAppointments,
    totalCustomers: uniqueCustomers,
    completedAppointments:
      appointmentsByStatus.find((row) => row.status === "COMPLETED")?._count ??
      0,
    cancelledAppointments:
      appointmentsByStatus.find((row) => row.status === "CANCELLED")?._count ??
      0,
    noShowAppointments:
      appointmentsByStatus.find((row) => row.status === "NO_SHOW")?._count ?? 0,

    // Money. `totalRevenueMinor` is what the salon billed on bookings that
    // actually happened; `netEarningsMinor` is that less our commission.
    totalRevenueMinor: earnings.grossBookingsMinor,
    grossBookingsMinor: earnings.grossBookingsMinor,
    commissionMinor: earnings.commissionMinor,
    netEarningsMinor: earnings.netEarningsMinor,
    todayRevenueMinor: earnings.todayGrossMinor,
    monthRevenueMinor: earnings.monthGrossMinor,
    monthCommissionMinor: earnings.monthCommissionMinor,
    monthNetMinor: earnings.monthNetMinor,
    depositsCollectedMinor: earnings.depositsCollectedMinor,
    counterCollectedMinor: earnings.counterCollectedMinor,
    depositsHeldMinor: earnings.depositsHeldMinor,
    payableMinor: earnings.payableMinor,
    processingPayoutMinor: earnings.processingPayoutMinor,
    paidOutMinor: earnings.paidOutMinor,
    failedPayoutMinor: earnings.failedPayoutMinor,
    averageTicketMinor: earnings.averageTicketMinor,
    effectiveCommissionPercent: earnings.effectiveCommissionPercent,
    standardCommissionPercent: earnings.standardCommissionPercent,
    monthlyEarnings: earnings.monthly,

    walletBalanceMinor: wallet.balanceMinor,
    walletAvailableMinor: wallet.availableMinor,
    walletHeldMinor: wallet.heldBalanceMinor,
    walletFrozen: wallet.isFrozen,

    salons: salonOwner.salons,
    recentAppointments,
    recentPayouts,
    appointmentsByStatus,
  };
};

const getCustomerDashboardStats = async (userId: string) => {
  const { start: todayStart, end: todayEnd } = dayBounds();

  const [
    totalAppointments,
    completedAppointments,
    upcomingAppointments,
    todayAppointments,
    cancelledAppointments,
    spent,
    depositsHeld,
    wallet,
    recentAppointments,
    appointmentsByStatus,
  ] = await Promise.all([
    prisma.appointment.count({ where: { customerId: userId } }),
    prisma.appointment.count({
      where: { customerId: userId, status: "COMPLETED" },
    }),
    prisma.appointment.count({
      where: {
        customerId: userId,
        status: { in: ["PENDING", "CONFIRMED"] },
        appointmentDate: { gte: new Date() },
      },
    }),
    prisma.appointment.count({
      where: {
        customerId: userId,
        appointmentDate: { gte: todayStart, lte: todayEnd },
      },
    }),
    prisma.appointment.count({
      where: { customerId: userId, status: "CANCELLED" },
    }),
    // What the customer was actually billed, from the bookings themselves. The
    // `payments` table only ever held gateway rows, so it undercounted every
    // booking settled from the wallet.
    prisma.appointment.aggregate({
      where: { customerId: userId, status: "COMPLETED" },
      _sum: { totalMinor: true, depositMinor: true },
    }),
    prisma.appointment.aggregate({
      where: { customerId: userId, depositStatus: "HELD" },
      _sum: { depositMinor: true },
    }),
    WalletService.getWalletSummary(userId),
    prisma.appointment.findMany({
      where: { customerId: userId },
      take: 5,
      orderBy: { appointmentDate: "desc" },
      include: {
        salon: { select: { name: true, address: true } },
        service: { select: { name: true, priceMinor: true, category: true } },
        staff: { include: { user: { select: { name: true } } } },
      },
    }),
    prisma.appointment.groupBy({
      by: ["status"],
      _count: true,
      where: { customerId: userId },
    }),
  ]);

  const totalSpentMinor = spent._sum.totalMinor ?? 0;
  const completedCount = completedAppointments;

  return {
    totalAppointments,
    completedAppointments,
    upcomingAppointments,
    todayAppointments,
    cancelledAppointments,
    totalSpentMinor,
    depositsPaidMinor: spent._sum.depositMinor ?? 0,
    depositsHeldMinor: depositsHeld._sum.depositMinor ?? 0,
    averageSpendMinor:
      completedCount > 0 ? Math.round(totalSpentMinor / completedCount) : 0,
    walletBalanceMinor: wallet.balanceMinor,
    walletAvailableMinor: wallet.availableMinor,
    walletHeldMinor: wallet.heldBalanceMinor,
    walletFrozen: wallet.isFrozen,
    recentAppointments,
    appointmentsByStatus,
  };
};

export const DashboardStatsService = {
  getAdminDashboardStats,
  getSalonOwnerDashboardStats,
  getCustomerDashboardStats,
};
