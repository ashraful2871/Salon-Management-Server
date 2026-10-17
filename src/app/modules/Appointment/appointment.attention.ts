import { AppealStatus, AppointmentStatus, DepositStatus, PaymentStatus, Prisma } from "@prisma/client";
import prisma from "../../shared/prisma";

/**
 * The booking lists behind the owner's "Needs attention" rows. The home counts
 * and `GET /appointments?attention=` use these same filters, so a count always
 * matches the list it links to.
 */
export const ATTENTION_KINDS = ["pending", "stale", "unrecorded", "appeal"] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const isAttentionKind = (v: unknown): v is AttentionKind =>
  typeof v === "string" && (ATTENTION_KINDS as readonly string[]).includes(v);

/** Checked in this long ago and still not started or finished. */
export const STALE_CHECK_IN_MS = 2 * 60 * 60 * 1000;

export const attentionWhere = (kind: AttentionKind, now = new Date()): Prisma.AppointmentWhereInput => {
  switch (kind) {
    case "pending":
      return { status: AppointmentStatus.PENDING };
    case "stale":
      return {
        status: AppointmentStatus.CHECKED_IN,
        checkedInAt: { lt: new Date(now.getTime() - STALE_CHECK_IN_MS) },
      };
    case "unrecorded":
      // paymentState UNRECORDED (appointment.billing): completed, nothing taken
      // at the counter, and the deposit does not cover the price.
      return {
        status: AppointmentStatus.COMPLETED,
        OR: [{ payment: { is: null } }, { payment: { is: { status: { notIn: [PaymentStatus.COMPLETED, PaymentStatus.REFUNDED] } } } }],
        AND: [
          {
            OR: [
              { depositStatus: { notIn: [DepositStatus.HELD, DepositStatus.APPLIED] }, totalMinor: { gt: 0 } },
              { depositMinor: { lt: prisma.appointment.fields.totalMinor } },
            ],
          },
        ],
      };
    case "appeal":
      return { appealStatus: AppealStatus.PENDING };
  }
};
