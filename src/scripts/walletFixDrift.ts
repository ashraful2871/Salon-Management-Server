/**
 * Closes a wallet's drift (the "Wallets out of step with their ledger" alert)
 * when the balance was changed outside `mutate` - a hand edit in the database.
 * It keeps the balance as it is and adds one ADJUSTMENT row for the difference,
 * with balanceAfter = the current balance, so the history records what
 * happened instead of the balance being moved again. Writes an audit row with
 * source "cli". Dry run unless --apply.
 *
 *   npm run wallet:fix-drift -- --email someone@example.com --reason "Balance reset by hand on 22 Sep"
 *   npm run wallet:fix-drift -- --email someone@example.com --reason "..." --apply
 *
 * To give the customer the money back instead, don't use this: credit the
 * difference with Adjust wallet.
 */
import { WalletTxType } from "@prisma/client";
import prisma from "../app/shared/prisma";
import { auditTx, systemAuditCtx } from "../app/utils/audit";
import { formatBDT } from "../app/utils/money";
import { normalizeEmail } from "../app/utils/normalizeEmail";

const USAGE =
  'Usage: npm run wallet:fix-drift -- --email someone@example.com --reason "what happened" [--apply]';

const argValue = (flag: string) => {
  const i = process.argv.indexOf(flag);
  return i === -1 ? undefined : process.argv[i + 1];
};

const main = async () => {
  const rawEmail = argValue("--email");
  const reason = argValue("--reason")?.trim();
  const apply = process.argv.includes("--apply");
  if (!rawEmail || !rawEmail.includes("@") || !reason || reason.length < 3) {
    console.error(USAGE);
    process.exit(1);
  }
  const email = normalizeEmail(rawEmail);

  const user = await prisma.user.findFirst({
    where: { email: { equals: email, mode: "insensitive" } },
    select: { id: true, wallet: { select: { id: true } } },
  });
  if (!user?.wallet) {
    console.error(`No wallet for ${email}.`);
    process.exit(1);
  }
  const walletId = user.wallet.id;

  const result = await prisma.$transaction(async (tx) => {
    // Same lock `mutate` takes, so no wallet write can land in between.
    const [wallet] = await tx.$queryRaw<Array<{ balance: number; heldBalance: number }>>`
      SELECT balance, "heldBalance" FROM wallets WHERE id = ${walletId} FOR UPDATE
    `;
    const sum = await tx.walletTransaction.aggregate({
      where: { walletId },
      _sum: { amount: true },
    });
    const ledger = sum._sum.amount ?? 0;
    const diff = wallet.balance - ledger;

    console.log(
      `${email}: balance ${formatBDT(wallet.balance)}, history sums to ${formatBDT(ledger)}, ` +
        `drift ${diff < 0 ? "-" : "+"}${formatBDT(Math.abs(diff))}`,
    );
    if (diff === 0 || !apply) return { diff, applied: false };

    const row = await tx.walletTransaction.create({
      data: {
        walletId,
        type: WalletTxType.ADJUSTMENT,
        amount: diff,
        balanceAfter: wallet.balance,
        heldAfter: wallet.heldBalance,
        description: `Correction: ${reason}`,
        referenceType: "ADJUSTMENT",
        // One correction per drifted state: a rerun finds nothing to do.
        idempotencyKey: `drift-fix:${walletId}:${ledger}`,
        metadata: { reason, ledgerOnly: true, ledgerBefore: ledger },
      },
    });
    await auditTx(tx, systemAuditCtx("cli"), {
      action: "wallet.drift_fix",
      entityType: "wallet",
      entityId: user.id,
      before: { balanceMinor: wallet.balance, ledgerMinor: ledger },
      after: { amountMinor: diff, walletTransactionId: row.id },
      reason,
    });
    return { diff, applied: true };
  });

  if (result.diff === 0) console.log("No drift. Nothing to do.");
  else if (!result.applied) console.log("Dry run - add --apply to write the correction row.");
  else console.log("Correction row written. The balance did not change; the drift is closed.");
};

main()
  .catch((error) => {
    console.error("wallet:fix-drift failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
