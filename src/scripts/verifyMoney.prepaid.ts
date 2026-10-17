import { randomUUID } from "crypto";
import {
  AppointmentSource,
  AppointmentStatus,
  DepositStatus,
  LedgerAccount,
  Prisma,
  UserRole,
  WalletTxType,
} from "@prisma/client";
import { getSetting } from "../app/utils/settings";
import { AppointmentDeposit } from "../app/modules/Appointment/appointment.deposit";
import { paymentSummary } from "../app/modules/Appointment/appointment.billing";
import { WalletService } from "../app/modules/Wallet/wallet.service";
import { SettlementService } from "../app/modules/Settlement/settlement.service";

type Check = (name: string, ok: boolean, detail?: string) => void;

/**
 * Owner Phase 15 for verify:money: a ৳450 bill paid in full from the wallet
 * (৳30 deposit + ৳420 prepaid) in one hold, through the real settlement
 * functions. The caller runs it inside a transaction it rolls back.
 */
export const runPrepaid = async (tx: Prisma.TransactionClient, check: Check) => {
  const tag = randomUUID().slice(0, 8);
  const ownerUser = await tx.user.create({
    data: { email: `verify-prepaid-owner-${tag}@seed.example.com`, name: "Verify Prepaid Owner", role: UserRole.SALON_OWNER, isTest: true },
  });
  const owner = await tx.salonOwner.create({ data: { userId: ownerUser.id, businessName: `Verify Prepaid ${tag}` } });
  const customer = await tx.user.create({
    data: { email: `verify-prepaid-customer-${tag}@seed.example.com`, name: "Verify Prepaid Customer", isTest: true },
  });
  const salon = await tx.salon.create({
    data: { name: `Verify Prepaid ${tag}`, address: "test road", area: "Mirpur", city: "Dhaka", phone: "01700000000", images: [], ownerId: owner.id, isTest: true, acceptsPrepay: true },
  });
  const service = await tx.service.create({
    data: { name: "Haircut", category: "HAIRCUT", priceMinor: 45000, duration: 30, salonId: salon.id, images: [] },
  });
  const counter = await tx.counter.create({ data: { salonId: salon.id, name: "Chair 1" } });

  await WalletService.mutate(
    { userId: customer.id, type: WalletTxType.TOPUP, amount: 200000, description: "verify:money top-up", idempotencyKey: `verify-prepaid-topup:${tag}` },
    tx,
  );

  // Booked the way bookAppointment books: HELD, one hold for deposit + prepaid.
  const prepaidBooking = async (status: AppointmentStatus) => {
    const a = await tx.appointment.create({
      data: {
        customerId: customer.id, salonId: salon.id, serviceId: service.id, counterId: counter.id,
        appointmentDate: new Date(), startTime: "10:00", status,
        totalMinor: 45000, depositMinor: 3000, prepaidMinor: 42000,
        depositStatus: DepositStatus.HELD, commissionBps: 1000, source: AppointmentSource.PLATFORM,
      },
    });
    await WalletService.holdDeposit(customer.id, 45000, a.id, tx, { depositMinor: 3000, prepaidMinor: 42000 });
    return a;
  };
  const wallet = () => tx.wallet.findUniqueOrThrow({ where: { userId: customer.id } });
  const lines = (appointmentId: string) =>
    tx.ledgerEntry.findMany({ where: { appointmentId }, select: { account: true, amountMinor: true } });
  const sumOf = (rows: Array<{ account: LedgerAccount; amountMinor: number }>, account?: LedgerAccount) =>
    rows.filter((r) => !account || r.account === account).reduce((s, r) => s + r.amountMinor, 0);

  // ---- completed
  const done = await prepaidBooking(AppointmentStatus.COMPLETED);
  const hold = await tx.walletTransaction.findUnique({ where: { idempotencyKey: `hold:${done.id}` }, select: { metadata: true } });
  const meta = hold?.metadata as { depositMinor?: number; prepaidMinor?: number } | null;
  check("prepaid: one hold carries the split", meta?.depositMinor === 3000 && meta?.prepaidMinor === 42000, JSON.stringify(meta));

  await AppointmentDeposit.settleCompletedTx(tx, done.id);
  const doneLines = await lines(done.id);
  const payable = doneLines.filter((r) => r.account === LedgerAccount.SALON_PAYABLE);
  const plus = payable.filter((r) => r.amountMinor > 0).reduce((s, r) => s + r.amountMinor, 0);
  const minus = payable.filter((r) => r.amountMinor < 0).reduce((s, r) => s + r.amountMinor, 0);
  check("prepaid ৳450 completed → SALON_PAYABLE +45000 −4500", plus === 45000 && minus === -4500, `+${plus} ${minus}`);
  check("prepaid completed: journal balanced", sumOf(doneLines) === 0, JSON.stringify(doneLines.map((r) => r.amountMinor)));
  const doneRow = await tx.appointment.findUniqueOrThrow({ where: { id: done.id }, include: { payment: true } });
  const summary = paymentSummary(doneRow);
  check(
    "prepaid completed: ৳0 due, PAID, paid in app",
    summary.amountDueMinor === 0 && summary.paymentState === "PAID" && summary.paidInApp,
    `due ${summary.amountDueMinor} ${summary.paymentState}`,
  );
  let w = await wallet();
  check("prepaid completed: wallet −৳450, nothing held", w.balance === 155000 && w.heldBalance === 0, `balance ${w.balance} held ${w.heldBalance}`);

  // ---- refund ৳100 (commission kept), then the rest (full → commission back)
  const refund = async (amountMinor: number, n: number, full: boolean) => {
    await WalletService.mutate(
      { userId: customer.id, type: WalletTxType.REFUND, amount: amountMinor, description: "verify refund", referenceType: "APPOINTMENT", referenceId: done.id, idempotencyKey: `salon-refund:${done.id}:${n}` },
      tx,
    );
    return SettlementService.recordSalonRefund(tx, doneRow, amountMinor, full);
  };
  const returned1 = await refund(10000, 1, false);
  const afterRefund = await lines(done.id);
  w = await wallet();
  check(
    "refund ৳100: balanced, commission kept, wallet +৳100",
    sumOf(afterRefund) === 0 && returned1 === 0 && sumOf(afterRefund, LedgerAccount.PLATFORM_REVENUE) === 4500 && w.balance === 165000,
    `Σ ${sumOf(afterRefund)} rev ${sumOf(afterRefund, LedgerAccount.PLATFORM_REVENUE)} balance ${w.balance}`,
  );
  const returned2 = await refund(35000, 2, true);
  const afterFull = await lines(done.id);
  check(
    "full refund returns the commission",
    returned2 === 4500 && sumOf(afterFull, LedgerAccount.PLATFORM_REVENUE) === 0 && sumOf(afterFull, LedgerAccount.SALON_PAYABLE) === 0 && sumOf(afterFull) === 0,
    `returned ${returned2} rev ${sumOf(afterFull, LedgerAccount.PLATFORM_REVENUE)} payable ${sumOf(afterFull, LedgerAccount.SALON_PAYABLE)}`,
  );

  // ---- no-show: owner Phase 0 decision, the whole prepaid amount is forfeited
  const noShow = await prepaidBooking(AppointmentStatus.NO_SHOW);
  const before = await wallet();
  await AppointmentDeposit.settleForfeitedTx(tx, noShow.id);
  const nsLines = await lines(noShow.id);
  w = await wallet();
  // Deposit 70/30 (2100 / 900); prepaid ৳420 owed less 10% (42000 − 4200).
  check(
    "prepaid no-show: all forfeited, deposit 70/30, prepaid less commission",
    w.balance === before.balance - 45000 &&
      w.heldBalance === 0 &&
      sumOf(nsLines, LedgerAccount.SALON_PAYABLE) === 2100 + 42000 - 4200 &&
      sumOf(nsLines, LedgerAccount.PLATFORM_REVENUE) === 900 + 4200 &&
      sumOf(nsLines) === 0,
    `wallet −${before.balance - w.balance} payable ${sumOf(nsLines, LedgerAccount.SALON_PAYABLE)} rev ${sumOf(nsLines, LedgerAccount.PLATFORM_REVENUE)}`,
  );
  await SettlementService.reverseForfeitedDeposit(
    tx,
    await tx.appointment.findUniqueOrThrow({ where: { id: noShow.id } }),
    salon.noShowSalonSharePct,
  );
  const reversed = await lines(noShow.id);
  check(
    "prepaid no-show reversed on appeal nets to 0",
    sumOf(reversed, LedgerAccount.SALON_PAYABLE) === 0 && sumOf(reversed, LedgerAccount.PLATFORM_REVENUE) === 0 && sumOf(reversed) === 0,
    `payable ${sumOf(reversed, LedgerAccount.SALON_PAYABLE)} rev ${sumOf(reversed, LedgerAccount.PLATFORM_REVENUE)}`,
  );

  // ---- late cancel: fee from the deposit only, prepaid back whole
  const late = await prepaidBooking(AppointmentStatus.CANCELLED);
  const beforeLate = await wallet();
  const settled = await AppointmentDeposit.settleLateCancelledTx(tx, late.id);
  w = await wallet();
  const fee = Math.round((3000 * (await getSetting("booking.lateCancellationPercent"))) / 100);
  check(
    "prepaid late cancel: fee on deposit only, rest released",
    settled?.penaltyMinor === fee && settled?.refundMinor === 45000 - fee && w.balance === beforeLate.balance - fee && w.heldBalance === 0,
    `fee ${settled?.penaltyMinor} refund ${settled?.refundMinor}`,
  );

  // ---- free cancel: everything released, no ledger rows
  const free = await prepaidBooking(AppointmentStatus.CANCELLED);
  await AppointmentDeposit.settleReleasedTx(tx, free.id);
  w = await wallet();
  check("prepaid free cancel: all released", w.heldBalance === 0 && (await lines(free.id)).length === 0, `held ${w.heldBalance}`);

  // ---- wallet drift: the cached balance equals the sum of its transactions
  const txSum = await tx.walletTransaction.aggregate({ where: { walletId: w.id }, _sum: { amount: true } });
  check("prepaid: wallet drift 0", (txSum._sum.amount ?? 0) === w.balance, `Σ ${txSum._sum.amount} vs ${w.balance}`);
};
