import { LocationAccuracy, Prisma, SlotStatus } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import { z } from "zod";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import prisma from "../../shared/prisma";
import sendResponse from "../../shared/sendResponse";
import { AuditCtx, auditTx } from "../../utils/audit";
import { AccessUser, assertOwnerOf, scopeSalonIds, withAccessCache } from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { scheduleReindex } from "../AI-Suggestion/ai.indexer";
import { addDays, dhakaDay } from "../Analytics/analytics.days";

/**
 * Multi-branch catalogue (owner only): copy services and hours between
 * branches, change one service's price across branches, and the per-branch
 * profile completeness score. Existing bookings keep their snapshotted
 * `totalMinor`; only the service rows change.
 */

const ids = z.array(z.string().uuid()).min(1).max(1000);

export const copyServicesBody = z.object({
  fromSalonId: z.string().uuid(),
  toSalonIds: ids,
  serviceIds: z.array(z.string().uuid()).max(500).optional(),
});

export const bulkPriceBody = z
  .object({
    serviceName: z.string().trim().min(1).max(120),
    salonIds: ids,
    priceMinor: z.number().int().min(100).max(10_000_000).optional(),
    percentChange: z.number().min(-90).max(500).optional(),
  })
  .refine((b) => (b.priceMinor === undefined) !== (b.percentChange === undefined), {
    message: "Send either priceMinor or percentChange",
    path: ["priceMinor"],
  });

export const copyHoursBody = z.object({ fromSalonId: z.string().uuid(), toSalonIds: ids });

/** 404 unless the caller owns every branch named. */
const ownedOrNotFound = async (user: AccessUser, salonIds: string[]) => {
  const { salonIds: owned } = await assertOwnerOf(user);
  if (salonIds.some((id) => !owned.includes(id))) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
};

const targetsOf = (from: string, to: string[]) => [...new Set(to)].filter((id) => id !== from);

// ---------------------------------------------------------------------------
// Copy services
// ---------------------------------------------------------------------------

const copyServices = async (user: AccessUser, ctx: AuditCtx, body: z.infer<typeof copyServicesBody>) => {
  const targets = targetsOf(body.fromSalonId, body.toSalonIds);
  if (!targets.length) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick at least one other branch.");
  await ownedOrNotFound(user, [body.fromSalonId, ...targets]);

  const source = await prisma.service.findMany({
    where: {
      salonId: body.fromSalonId,
      isDeleted: false,
      ...(body.serviceIds?.length && { id: { in: body.serviceIds } }),
    },
    select: { name: true, category: true, priceMinor: true, duration: true, description: true, images: true },
    orderBy: { name: "asc" },
  });
  if (!source.length) throw new ApiError(StatusCodes.BAD_REQUEST, "That branch has no services to copy.");

  const [existing, salons] = await Promise.all([
    prisma.service.findMany({
      where: { salonId: { in: targets }, isDeleted: false },
      select: { salonId: true, name: true },
    }),
    prisma.salon.findMany({ where: { id: { in: targets } }, select: { id: true, name: true } }),
  ]);
  const namesAt = new Map<string, Set<string>>();
  for (const row of existing) {
    const set = namesAt.get(row.salonId) ?? new Set<string>();
    set.add(row.name.trim().toLowerCase());
    namesAt.set(row.salonId, set);
  }

  const results = await prisma.$transaction(
    async (tx) => {
      const out: Array<{ salonId: string; salonName: string; created: string[]; skipped: string[] }> = [];
      for (const salon of salons) {
        const have = namesAt.get(salon.id) ?? new Set<string>();
        const fresh = source.filter((s) => !have.has(s.name.trim().toLowerCase()));
        const skipped = source.filter((s) => have.has(s.name.trim().toLowerCase())).map((s) => s.name);
        if (fresh.length) {
          await tx.service.createMany({ data: fresh.map((s) => ({ ...s, salonId: salon.id })) });
          await auditTx(tx, ctx, {
            action: "services.copy",
            entityType: "salon",
            entityId: salon.id,
            salonId: salon.id,
            after: { fromSalonId: body.fromSalonId, created: fresh.map((s) => s.name) },
          });
        }
        out.push({ salonId: salon.id, salonName: salon.name, created: fresh.map((s) => s.name), skipped });
      }
      return out;
    },
    { timeout: 60_000 },
  );

  for (const r of results) if (r.created.length) scheduleReindex(r.salonId, "service.created");

  return {
    createdCount: results.reduce((n, r) => n + r.created.length, 0),
    skippedCount: results.reduce((n, r) => n + r.skipped.length, 0),
    branches: results,
  };
};

// ---------------------------------------------------------------------------
// Bulk price
// ---------------------------------------------------------------------------

/** New price: a fixed one, or a percentage change rounded to whole taka (min ৳1). */
const nextPrice = (beforeMinor: number, body: z.infer<typeof bulkPriceBody>) =>
  body.priceMinor !== undefined
    ? body.priceMinor
    : Math.max(100, Math.round((beforeMinor * (1 + body.percentChange! / 100)) / 100) * 100);

const bulkPrice = async (
  user: AccessUser,
  ctx: AuditCtx,
  body: z.infer<typeof bulkPriceBody>,
  dryRun: boolean,
) => {
  const salonIds = [...new Set(body.salonIds)];
  await ownedOrNotFound(user, salonIds);

  const [services, salons] = await Promise.all([
    prisma.service.findMany({
      where: { salonId: { in: salonIds }, isDeleted: false, name: { equals: body.serviceName, mode: "insensitive" } },
      select: { id: true, salonId: true, name: true, priceMinor: true },
    }),
    prisma.salon.findMany({ where: { id: { in: salonIds } }, select: { id: true, name: true } }),
  ]);
  const nameOf = new Map(salons.map((s) => [s.id, s.name]));

  const rows = services
    .map((s) => ({
      salonId: s.salonId,
      salonName: nameOf.get(s.salonId) ?? "",
      serviceId: s.id,
      serviceName: s.name,
      beforeMinor: s.priceMinor,
      afterMinor: nextPrice(s.priceMinor, body),
    }))
    .sort((a, b) => a.salonName.localeCompare(b.salonName));
  const missing = salons
    .filter((s) => !services.some((row) => row.salonId === s.id))
    .map((s) => ({ salonId: s.id, salonName: s.name }));
  const changes = rows.filter((r) => r.afterMinor !== r.beforeMinor);

  if (!dryRun && changes.length) {
    await prisma.$transaction(
      async (tx) => {
        for (const c of changes) {
          // Conditional on the price previewed, so a concurrent edit is not overwritten blind.
          const { count } = await tx.service.updateMany({
            where: { id: c.serviceId, priceMinor: c.beforeMinor, isDeleted: false },
            data: { priceMinor: c.afterMinor },
          });
          if (count === 0) {
            throw new ApiError(StatusCodes.CONFLICT, `${c.salonName}: the price changed meanwhile. Preview again.`);
          }
          await auditTx(tx, ctx, {
            action: "services.price_change",
            entityType: "service",
            entityId: c.serviceId,
            salonId: c.salonId,
            before: { priceMinor: c.beforeMinor },
            after: { priceMinor: c.afterMinor },
          });
        }
      },
      { timeout: 60_000 },
    );
    for (const salonId of new Set(changes.map((c) => c.salonId))) scheduleReindex(salonId, "service.updated");
  }

  return { dryRun, changed: changes.length, unchanged: rows.length - changes.length, rows, missing };
};

// ---------------------------------------------------------------------------
// Copy hours
// ---------------------------------------------------------------------------

const copyHours = async (user: AccessUser, ctx: AuditCtx, body: z.infer<typeof copyHoursBody>) => {
  const targets = targetsOf(body.fromSalonId, body.toSalonIds);
  if (!targets.length) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick at least one other branch.");
  await ownedOrNotFound(user, [body.fromSalonId, ...targets]);

  const from = await prisma.salon.findUnique({ where: { id: body.fromSalonId }, select: { operatingHours: true } });
  const hours = from?.operatingHours;
  if (!hours || typeof hours !== "object" || !Object.keys(hours).length) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Set this branch's hours first.");
  }

  const before = await prisma.salon.findMany({ where: { id: { in: targets } }, select: { id: true, operatingHours: true } });
  await prisma.$transaction(
    async (tx) => {
      await tx.salon.updateMany({
        where: { id: { in: targets } },
        data: { operatingHours: hours as Prisma.InputJsonValue },
      });
      for (const salon of before) {
        await auditTx(tx, ctx, {
          action: "salon.hours_copy",
          entityType: "salon",
          entityId: salon.id,
          salonId: salon.id,
          before: { operatingHours: salon.operatingHours },
          after: { operatingHours: hours, fromSalonId: body.fromSalonId },
        });
      }
    },
    { timeout: 60_000 },
  );
  return { updated: before.length };
};

// ---------------------------------------------------------------------------
// Profile completeness
// ---------------------------------------------------------------------------

const CHECKS = ["description", "photos", "hours", "exactPin", "services", "team", "phone", "slots14d"] as const;
type Check = (typeof CHECKS)[number];

const LABELS: Record<Check, string> = {
  description: "Write a description of at least 80 characters",
  photos: "Add at least 3 photos",
  hours: "Set your opening hours",
  exactPin: "Place an exact map pin",
  services: "List at least 3 active services",
  team: "Add a stylist or a counter",
  phone: "Add a phone number",
  slots14d: "Open slots for the next 14 days",
};

const linkFor = (check: Check, salonId: string) => {
  const store = `/dashboard/store/${salonId}`;
  switch (check) {
    case "hours":
      return `${store}?tab=hours`;
    case "exactPin":
      return `${store}?tab=location`;
    case "team":
      return `${store}?tab=counters`;
    case "services":
      return "/dashboard/services";
    case "slots14d":
      return "/dashboard/slots";
    default:
      return `${store}?tab=details`;
  }
};

const hasHours = (hours: unknown) => !!hours && typeof hours === "object" && Object.keys(hours).length > 0;

export const completenessFor = async (salonIds: string[]) => {
  if (!salonIds.length) return [];
  const today = dhakaDay();
  const [salons, services, staff, counters, slots] = await Promise.all([
    prisma.salon.findMany({
      where: { id: { in: salonIds } },
      select: { id: true, name: true, description: true, images: true, operatingHours: true, locationAccuracy: true, phone: true },
    }),
    prisma.service.groupBy({ by: ["salonId"], where: { salonId: { in: salonIds }, isActive: true, isDeleted: false }, _count: true }),
    prisma.staff.groupBy({ by: ["salonId"], where: { salonId: { in: salonIds }, isDeleted: false }, _count: true }),
    prisma.counter.groupBy({ by: ["salonId"], where: { salonId: { in: salonIds }, isActive: true, isDeleted: false }, _count: true }),
    prisma.slot.groupBy({
      by: ["salonId"],
      where: {
        salonId: { in: salonIds },
        status: SlotStatus.AVAILABLE,
        isBooked: false,
        date: { gte: new Date(`${today}T00:00:00Z`), lte: new Date(`${addDays(today, 13)}T00:00:00Z`) },
      },
      _count: true,
    }),
  ]);
  const count = (rows: Array<{ salonId: string; _count: number }>) => new Map(rows.map((r) => [r.salonId, r._count]));
  const [svc, stf, ctr, slt] = [count(services), count(staff), count(counters), count(slots)];

  return salons.map((s) => {
    const done: Record<Check, boolean> = {
      description: (s.description?.trim().length ?? 0) >= 80,
      photos: s.images.length >= 3,
      hours: hasHours(s.operatingHours),
      exactPin: s.locationAccuracy === LocationAccuracy.EXACT,
      services: (svc.get(s.id) ?? 0) >= 3,
      team: (stf.get(s.id) ?? 0) + (ctr.get(s.id) ?? 0) > 0,
      phone: !!s.phone?.trim(),
      slots14d: (slt.get(s.id) ?? 0) > 0,
    };
    const passed = CHECKS.filter((c) => done[c]).length;
    return {
      salonId: s.id,
      salonName: s.name,
      score: Math.round((passed / CHECKS.length) * 100),
      done,
      missing: CHECKS.filter((c) => !done[c]).map((c) => ({ key: c, label: LABELS[c], href: linkFor(c, s.id) })),
    };
  });
};

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

const ctxOf = (req: Request) => buildAuditCtx(req, req.user!.role);

const handleCopyServices = catchAsync(async (req: Request, res: Response) => {
  const data = await copyServices(withAccessCache(req), ctxOf(req), req.body);
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: `${data.createdCount} service${data.createdCount === 1 ? "" : "s"} copied, ${data.skippedCount} skipped`,
    data,
  });
});

const handleBulkPrice = catchAsync(async (req: Request, res: Response) => {
  const dryRun = req.query.dryRun === "1" || req.query.dryRun === "true";
  const data = await bulkPrice(withAccessCache(req), ctxOf(req), req.body, dryRun);
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: dryRun ? "Preview" : `${data.changed} price${data.changed === 1 ? "" : "s"} changed`,
    data,
  });
});

const handleCopyHours = catchAsync(async (req: Request, res: Response) => {
  const data = await copyHours(withAccessCache(req), ctxOf(req), req.body);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: `Hours copied to ${data.updated} branches`, data });
});

/** GET /owner/salons/completeness?salonId — every branch in branch.profile scope. */
const handleCompletenessList = catchAsync(async (req: Request, res: Response) => {
  const requested = typeof req.query.salonId === "string" ? req.query.salonId : undefined;
  const scope = await scopeSalonIds(withAccessCache(req), "branch.profile", requested);
  if (scope === null) throw new ApiError(StatusCodes.BAD_REQUEST, "Pick a branch");
  const data = await completenessFor(scope);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Profile completeness", data });
});

const handleCompleteness = catchAsync(async (req: Request, res: Response) => {
  const salonId = String(req.params.id);
  const scope = await scopeSalonIds(withAccessCache(req), "branch.profile", salonId);
  if (scope !== null && !scope.length) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  const [row] = await completenessFor([salonId]);
  if (!row) throw new ApiError(StatusCodes.NOT_FOUND, "Not found");
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Profile completeness", data: row });
});

export const OwnerCatalogue = {
  copyServices: handleCopyServices,
  bulkPrice: handleBulkPrice,
  copyHours: handleCopyHours,
  completenessList: handleCompletenessList,
  completeness: handleCompleteness,
};
