/**
 * Verification for the wallet and ledger primitives.
 *
 * There is no test runner in this project, so this script stands in for one on
 * the part of the codebase where being wrong costs real money. It creates a
 * throwaway user, exercises the guarantees the payment design depends on, and
 * deletes everything it made.
 *
 *   npm run verify:payments
 *
 * It is safe to run against a live database: it only ever touches the user it
 * creates. Nothing else is read or written.
 */
import { createHash, randomUUID } from "crypto";
import prisma from "../app/shared/prisma";
import config from "../config";
import { WalletService } from "../app/modules/Wallet/wallet.service";
import { sslCommerzProvider } from "../app/modules/Payment/providers/sslcommerz.provider";
import {
  parseGatewayAmount,
  toGatewayAmount,
} from "../app/modules/Payment/providers/amount";
import {
  maskMsisdn,
  verifyBkashSettlement,
} from "../app/modules/Payment/providers/bkash/bkash.provider";
import {
  bkashFailureReason,
  classifyBkashError,
} from "../app/modules/Payment/providers/bkash/bkash.errors";

let passed = 0;
let failed = 0;

const check = (name: string, condition: boolean, detail?: string) => {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${name}`);
  } else {
    failed += 1;
    console.error(`  FAIL  ${name}${detail ? ` - ${detail}` : ""}`);
  }
};

/**
 * bKash's pure helpers. No database, no network: these are the checks that
 * stand in for tampering with a live intent's amount or invoice.
 */
const bkashOfflineChecks = () => {
  console.log("\n0. bKash (offline)");

  check('"500" parses to 50000 poisha', parseGatewayAmount("500") === 50000);
  check('"500.00" parses to 50000 poisha', parseGatewayAmount("500.00") === 50000);
  check('"500.5" parses to 50050 poisha', parseGatewayAmount("500.5") === 50050);
  check('"abc" parses to 0', parseGatewayAmount("abc") === 0);
  check('50050 poisha goes out as "500.50"', toGatewayAmount(50050) === "500.50");

  const intent = { transactionId: "TXN-VERIFY-1", amountMinor: 50000 };
  const completed = {
    paymentID: "TR0011verify",
    trxID: "VERIFY0001",
    transactionStatus: "Completed",
    amount: "500.00",
    currency: "BDT",
    merchantInvoiceNumber: intent.transactionId,
  };
  const settles = (patch: Record<string, string>) =>
    verifyBkashSettlement(intent, { ...completed, ...patch }).ok;

  check("a matching Completed payment settles", settles({}));
  check("a wrong amount does not settle", !settles({ amount: "5000.00" }));
  check("a wrong invoice does not settle", !settles({ merchantInvoiceNumber: "TXN-OTHER" }));
  check("a non-BDT currency does not settle", !settles({ currency: "USD" }));
  check("an Initiated payment does not settle", !settles({ transactionStatus: "Initiated" }));

  const kinds: Array<[string, string]> = [
    ["2023", "business"],
    ["2062", "ambiguous"],
    ["TIMEOUT", "ambiguous"],
    ["2002", "integration"],
    ["9999", "unknown"],
  ];
  for (const [code, kind] of kinds) {
    const actual = classifyBkashError(code).kind;
    check(`bKash ${code} is ${kind}`, actual === kind, `got ${actual}`);
  }

  check(
    "a failure reason names the bKash code",
    bkashFailureReason("2023", "Insufficient Balance").endsWith("(bKash 2023)"),
  );
  check("a wallet number is masked", !maskMsisdn("01770618575").includes("0618"));
};

const main = async () => {
  bkashOfflineChecks();

  const email = `wallet-verify-${randomUUID()}@example.invalid`;

  const user = await prisma.user.create({
    data: {
      email,
      password: "not-a-real-login",
      name: "Wallet Verification",
      role: "CUSTOMER",
    },
  });

  try {
    console.log("\n1. Concurrent holds against one balance");

    await WalletService.mutate({
      userId: user.id,
      type: "ADJUSTMENT",
      amount: 10000, // BDT 100
      description: "verification float",
    });

    // Four identical holds of 3000 against a balance of 10000. Whichever order
    // they happen to arrive in, exactly three can fit and the fourth cannot -
    // so unlike a mixed-size race, this has one correct answer. If the row
    // lock were missing, all four would read 10000 and all four would pass.
    const appointmentIds = [
      randomUUID(),
      randomUUID(),
      randomUUID(),
      randomUUID(),
    ];

    const results = await Promise.allSettled(
      appointmentIds.map((id) => WalletService.holdDeposit(user.id, 3000, id)),
    );

    const heldIds = appointmentIds.filter(
      (_, index) => results[index].status === "fulfilled",
    );
    const rejected = results.filter((r) => r.status === "rejected").length;

    for (const result of results) {
      if (result.status === "rejected") {
        const reason = result.reason as {
          code?: string;
          meta?: unknown;
          message?: string;
        };
        console.log(
          `        rejected: code=${reason?.code ?? "-"} meta=${JSON.stringify(reason?.meta)} ${reason?.message?.replace(/\s+/g, " ").slice(0, 160)}`,
        );
      }
    }

    check("exactly three holds fit", heldIds.length === 3, `got ${heldIds.length}`);
    check("the fourth is refused", rejected === 1, `got ${rejected}`);

    let wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });

    check(
      "heldBalance is exactly 9000",
      wallet.heldBalance === 9000,
      `got ${wallet.heldBalance}`,
    );
    check(
      "balance is untouched by holds",
      wallet.balance === 10000,
      `got ${wallet.balance}`,
    );
    check(
      "the wallet is never overdrawn",
      wallet.heldBalance <= wallet.balance,
      `${wallet.heldBalance} held against ${wallet.balance}`,
    );

    console.log("\n2. Idempotency");

    const first = await prisma.walletTransaction.findUnique({
      where: { idempotencyKey: `hold:${heldIds[0]}` },
    });
    const replay = await WalletService.holdDeposit(user.id, 3000, heldIds[0]);

    check(
      "replaying a hold returns the original row",
      replay.id === first?.id,
      `${replay.id} vs ${first?.id}`,
    );

    wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });
    check(
      "a replayed hold moves nothing",
      wallet.heldBalance === 9000,
      `got ${wallet.heldBalance}`,
    );

    console.log("\n3. Deposit lifecycle");

    // One booking is honoured, two are cancelled in time.
    await WalletService.applyDeposit(user.id, 3000, heldIds[0]);
    await WalletService.releaseDeposit(user.id, 3000, heldIds[1]);
    await WalletService.releaseDeposit(user.id, 3000, heldIds[2]);

    wallet = await prisma.wallet.findUniqueOrThrow({
      where: { userId: user.id },
    });

    check(
      "an applied deposit leaves the balance",
      wallet.balance === 7000,
      `got ${wallet.balance}`,
    );
    check(
      "released deposits free their holds",
      wallet.heldBalance === 0,
      `got ${wallet.heldBalance}`,
    );

    console.log("\n4. The balance cache agrees with the ledger");

    const ledgerSum = await prisma.walletTransaction.aggregate({
      where: { walletId: wallet.id },
      _sum: { amount: true },
    });

    check(
      "balance equals the sum of its transactions",
      wallet.balance === (ledgerSum._sum.amount ?? 0),
      `${wallet.balance} vs ${ledgerSum._sum.amount}`,
    );

    console.log("\n5. Database constraints, not just application checks");

    let negativeRejected = false;
    try {
      await prisma.$executeRaw`UPDATE wallets SET balance = -1 WHERE id = ${wallet.id}`;
    } catch {
      negativeRejected = true;
    }
    check("postgres refuses a negative balance", negativeRejected);

    let overHeldRejected = false;
    try {
      await prisma.$executeRaw`UPDATE wallets SET "heldBalance" = balance + 1 WHERE id = ${wallet.id}`;
    } catch {
      overHeldRejected = true;
    }
    check("postgres refuses holding more than the balance", overHeldRejected);

    console.log("\n6. Overdraft is impossible even in one call");

    let overdraftRejected = false;
    try {
      await WalletService.mutate({
        userId: user.id,
        type: "DEPOSIT_FORFEIT",
        amount: -999999,
        description: "should never apply",
      });
    } catch {
      overdraftRejected = true;
    }
    check("a debit larger than the balance is refused", overdraftRejected);
    console.log("\n7. SSLCommerz IPN signature verification");

    if (!config.sslcz.storePasswd) {
      console.log("  SKIP  set SSLCZ_STORE_PASSWD to exercise this");
    } else {
      // Build a payload the way SSLCommerz signs one: the fields named by
      // verify_key, plus the md5 of the store password, sorted, joined, md5'd.
      const signed: Record<string, string> = {
        tran_id: "TOPUP-TEST-1",
        val_id: "VAL-TEST-1",
        amount: "500.00",
        currency: "BDT",
        status: "VALID",
      };

      const verifyKey = Object.keys(signed).sort().join(",");
      const fields: Record<string, string> = {
        ...signed,
        store_passwd: createHash("md5")
          .update(config.sslcz.storePasswd)
          .digest("hex"),
      };

      const verifySign = createHash("md5")
        .update(
          Object.keys(fields)
            .sort()
            .map((key) => `${key}=${fields[key]}`)
            .join("&"),
        )
        .digest("hex");

      const genuine = { ...signed, verify_key: verifyKey, verify_sign: verifySign };

      check(
        "a genuine signature is accepted",
        sslCommerzProvider.verifySignature(genuine),
      );
      check(
        "a tampered amount is rejected",
        !sslCommerzProvider.verifySignature({ ...genuine, amount: "50000.00" }),
      );
      check(
        "a payload with no signature is rejected",
        !sslCommerzProvider.verifySignature({ ...signed }),
      );
    }
  } finally {
    // Cascades to the wallet and its transactions.
    await prisma.user.delete({ where: { id: user.id } }).catch(() => undefined);
  }

  console.log(`\n${passed} passed, ${failed} failed\n`);
  await prisma.$disconnect();
  process.exit(failed === 0 ? 0 : 1);
};

main().catch(async (error) => {
  console.error(error);
  await prisma.$disconnect();
  process.exit(1);
});
