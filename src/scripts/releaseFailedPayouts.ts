/**
 * Repairs payouts that were marked FAILED before a failure released its ledger
 * entries. Those entries still carry the payout's id, so the money never shows
 * as payable again and is never re-paid. This detaches them (payoutId = null),
 * one transaction per payout, with an audit row (source "cli"). Dry run unless
 * --apply.
 *
 *   npm run payouts:release-failed
 *   npm run payouts:release-failed -- --apply
 */
import { PayoutStatus } from "@prisma/client";
import prisma from "../app/shared/prisma";
import { releasePayoutEntries } from "../app/modules/Settlement/settlement.service";
import { auditTx, systemAuditCtx } from "../app/utils/audit";
import { formatBDT } from "../app/utils/money";

const main = async () => {
  const apply = process.argv.includes("--apply");

  const stuck = await prisma.payout.findMany({
    where: { status: PayoutStatus.FAILED, entries: { some: {} } },
    select: { id: true, salonId: true, netMinor: true, createdAt: true },
    orderBy: { createdAt: "asc" },
  });

  if (stuck.length === 0) {
    console.log("No FAILED payout still holds ledger entries. Nothing to do.");
    return;
  }

  let totalEntries = 0;
  let totalMinor = 0;

  for (const payout of stuck) {
    const agg = await prisma.ledgerEntry.aggregate({
      where: { payoutId: payout.id },
      _count: { _all: true },
      _sum: { amountMinor: true },
    });
    const count = agg._count._all;
    const sumMinor = agg._sum.amountMinor ?? 0;
    totalEntries += count;
    totalMinor += sumMinor;

    console.log(
      `${payout.id}  salon ${payout.salonId}  ${count} entries  ${formatBDT(sumMinor)}  (payout net ${formatBDT(payout.netMinor)})`,
    );

    if (!apply) continue;

    const released = await prisma.$transaction(async (tx) => {
      // Re-check inside the transaction: the payout must still be FAILED.
      const current = await tx.payout.findUnique({ where: { id: payout.id }, select: { status: true } });
      if (current?.status !== PayoutStatus.FAILED) return 0;

      const releasedEntries = await releasePayoutEntries(tx, payout.id);
      await auditTx(tx, systemAuditCtx("cli"), {
        action: "payout.release_failed",
        entityType: "payout",
        entityId: payout.id,
        salonId: payout.salonId,
        after: { releasedEntries, releasedMinor: sumMinor },
        reason: "FAILED payout kept its ledger entries; released so the money is payable again",
      });
      return releasedEntries;
    });

    console.log(`  released ${released} entries`);
  }

  console.log(
    `\n${stuck.length} FAILED payout(s), ${totalEntries} entries, ${formatBDT(totalMinor)} ${
      apply ? "released." : "would be released. Re-run with --apply to release them."
    }`,
  );
};

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
