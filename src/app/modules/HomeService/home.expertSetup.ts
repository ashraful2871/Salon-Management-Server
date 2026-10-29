import { randomUUID } from "crypto";
import {
  ExpertVerification,
  Gender,
  HomeAudience,
  HomeBookingStatus,
  HomeExpert,
  Prisma,
  StaffStatus,
} from "@prisma/client";
import { v2 as cloudinary } from "cloudinary";
import { StatusCodes } from "http-status-codes";
import config from "../../../config";
import ApiError from "../../Error/error";
import prisma from "../../shared/prisma";
import { AuditCtx, auditTx, diff } from "../../utils/audit";
import { AccessUser, assertSalonPermission } from "../../utils/salonAccess";
import { rehomeExpertBookings } from "./home.cancel";
import { allowedSidesOf } from "./home.owner";
import type {
  CreateExpertBody,
  DocKind,
  ExpertDocBody,
  UpdateExpertBody,
} from "./home.validation";

/**
 * A branch turns its staff into home experts. LADIES ⇔ FEMALE and
 * GENTS ⇔ MALE are enforced here (and by a DB CHECK); offering links must
 * match the expert's side. ID documents are private Cloudinary assets: their
 * public ids never leave this file except through the admin documents
 * endpoint, as 5-minute signed URLs.
 */

cloudinary.config({
  cloud_name: config.cloudinary.cloud_name,
  api_key: config.cloudinary.api_key,
  api_secret: config.cloudinary.api_secret,
  secure: true,
});

/** Statuses that still hold the expert's time. */
export const ACTIVE_BOOKING_STATUSES: HomeBookingStatus[] = [
  HomeBookingStatus.PENDING_PAYMENT,
  HomeBookingStatus.CONFIRMED,
  HomeBookingStatus.EN_ROUTE,
  HomeBookingStatus.ARRIVED,
  HomeBookingStatus.IN_PROGRESS,
];

export const DOC_KINDS = ["ID_FRONT", "ID_BACK", "SELFIE"] as const;
const DOC_FIELD = { ID_FRONT: "idDocFrontId", ID_BACK: "idDocBackId", SELFIE: "selfieId" } as const;
const DOC_MAX_BYTES = 8 * 1024 * 1024;
const DOC_FORMATS = ["jpg", "jpeg", "png", "webp", "pdf"];
const UPLOAD_TICKET_MS = 10 * 60 * 1000;
const VIEW_URL_SECONDS = 5 * 60;
/** The owner may change gender, documents and resubmit only in these states. */
const EDITABLE: ExpertVerification[] = [ExpertVerification.DRAFT, ExpertVerification.REJECTED];

const notFound = () => new ApiError(StatusCodes.NOT_FOUND, "Not found");

export const audienceOf = (gender: Gender): HomeAudience =>
  gender === Gender.FEMALE ? HomeAudience.LADIES : HomeAudience.GENTS;

const sideRule = (audience: HomeAudience) =>
  audience === HomeAudience.LADIES ? "Ladies services need a female expert" : "Gents services need a male expert";

// ---------------------------------------------------------------------------
// Documents (Cloudinary, type: authenticated)
// ---------------------------------------------------------------------------

const docPrefix = (expertId: string, kind: DocKind) => `home-experts/${expertId}/${kind}-`;

const inspectDoc = async (publicId: string) => {
  try {
    const r = await cloudinary.api.resource(publicId, { type: "authenticated", resource_type: "image" });
    return { bytes: r.bytes as number, format: String(r.format ?? "").toLowerCase() };
  } catch {
    return null;
  }
};

const deleteDocs = async (publicIds: string[]) => {
  if (!publicIds.length) return;
  try {
    await cloudinary.api.delete_resources(publicIds, {
      type: "authenticated",
      resource_type: "image",
      invalidate: true,
    });
  } catch (err) {
    // Never log the ids themselves.
    console.error(`[home] failed to delete ${publicIds.length} expert document(s)`, (err as Error)?.message ?? err);
  }
};

/** Short-lived download URLs for the admin viewer. The only place ids turn into URLs. */
export const signedDocUrls = async (expert: Pick<HomeExpert, "idDocFrontId" | "idDocBackId" | "selfieId">) => {
  const expiresAt = Math.floor(Date.now() / 1000) + VIEW_URL_SECONDS;
  const out: Record<DocKind, { url: string; format: string } | null> = { ID_FRONT: null, ID_BACK: null, SELFIE: null };
  await Promise.all(
    DOC_KINDS.map(async (kind) => {
      const publicId = expert[DOC_FIELD[kind]];
      if (!publicId) return;
      const info = await inspectDoc(publicId);
      if (!info) return;
      out[kind] = {
        format: info.format,
        url: cloudinary.utils.private_download_url(publicId, info.format, {
          resource_type: "image",
          type: "authenticated",
          expires_at: expiresAt,
        }),
      };
    }),
  );
  return { documents: out, expiresAt: new Date(expiresAt * 1000) };
};

export { deleteDocs as deleteExpertDocs };

// ---------------------------------------------------------------------------
// Views (no document ids, ever)
// ---------------------------------------------------------------------------

type ExpertRow = HomeExpert & { offerings?: Array<{ offeringId: string }> };

export const docsPresent = (e: Pick<HomeExpert, "idDocFrontId" | "idDocBackId" | "selfieId">) => ({
  ID_FRONT: !!e.idDocFrontId,
  ID_BACK: !!e.idDocBackId,
  SELFIE: !!e.selfieId,
});

export const expertView = (e: ExpertRow) => {
  const { idDocFrontId: _f, idDocBackId: _b, selfieId: _s, offerings, ...rest } = e;
  return {
    ...rest,
    docs: docsPresent(e),
    ...(offerings && { offeringIds: offerings.map((o) => o.offeringId) }),
  };
};

/** What the audit log keeps of an expert: no document ids. */
const auditable = (e: HomeExpert | null) =>
  e && {
    gender: e.gender,
    audience: e.audience,
    verification: e.verification,
    headline: e.headline,
    languages: e.languages,
    maxJobsPerDay: e.maxJobsPerDay,
    isActive: e.isActive,
    removedAt: e.removedAt,
    rejectReason: e.rejectReason,
    docs: docsPresent(e),
  };

export const auditExpert = (
  tx: Prisma.TransactionClient,
  ctx: AuditCtx | undefined,
  action: string,
  before: HomeExpert | null,
  after: HomeExpert,
  extra: { reason?: string | null; note?: Record<string, unknown> } = {},
) => {
  const d = diff(auditable(before), auditable(after));
  return auditTx(tx, ctx, {
    action,
    entityType: "home_expert",
    entityId: after.id,
    salonId: after.salonId,
    before: d.before,
    after: extra.note ? { ...d.after, ...extra.note } : d.after,
    reason: extra.reason || null,
  });
};

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

const isStaffActive = (s: { isDeleted: boolean; status: StaffStatus }) => !s.isDeleted && s.status !== StaffStatus.INACTIVE;

/** The expert, or 404 when removed or at a branch the caller can't manage. */
const managedExpert = async (user: AccessUser, id: string) => {
  const expert = await prisma.homeExpert.findFirst({ where: { id, removedAt: null } });
  if (!expert) throw notFound();
  await assertSalonPermission(user, expert.salonId, "homeservice.manage");
  return expert;
};

const salonAudience = async (salonId: string) => {
  const salon = await prisma.salon.findUnique({ where: { id: salonId }, select: { audience: true, isDeleted: true } });
  if (!salon || salon.isDeleted) throw notFound();
  return salon.audience;
};

const assertSideAllowed = async (salonId: string, audience: HomeAudience) => {
  const allowed = allowedSidesOf(await salonAudience(salonId));
  if (!allowed.includes(audience)) {
    throw ApiError.withCode(
      StatusCodes.BAD_REQUEST,
      audience === HomeAudience.GENTS
        ? "This salon serves ladies only, so its home experts must be female."
        : "This salon serves gents only, so its home experts must be male.",
      "EXPERT_GENDER_MISMATCH",
      { allowedSides: allowed },
    );
  }
};

const conflict = () => new ApiError(StatusCodes.CONFLICT, "This expert changed meanwhile. Reload and try again.");

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

/** GET /owner/experts: the branch's experts (removed ones left out). */
export const listExperts = async (user: AccessUser, salonId: string) => {
  await assertSalonPermission(user, salonId, "homeservice.manage");
  const rows = await prisma.homeExpert.findMany({
    where: { salonId, removedAt: null },
    include: {
      offerings: { select: { offeringId: true } },
      staff: { select: { status: true, isDeleted: true, user: { select: { name: true, profilePhoto: true } } } },
    },
    orderBy: [{ audience: "asc" }, { createdAt: "asc" }],
  });
  return rows.map(({ staff, ...e }) => ({
    ...expertView(e),
    staff: { name: staff.user.name, photo: staff.user.profilePhoto, active: isStaffActive(staff) },
  }));
};

/** GET /owner/experts/candidates: active staff of the branch who aren't experts yet. */
export const listCandidates = async (user: AccessUser, salonId: string) => {
  await assertSalonPermission(user, salonId, "homeservice.manage");
  const staff = await prisma.staff.findMany({
    where: {
      salonId,
      isDeleted: false,
      status: { not: StaffStatus.INACTIVE },
      OR: [{ homeExpert: { is: null } }, { homeExpert: { is: { removedAt: { not: null } } } }],
    },
    select: {
      id: true,
      speciality: true,
      user: { select: { name: true, profilePhoto: true, gender: true } },
    },
    orderBy: { createdAt: "asc" },
  });
  return staff.map((s) => ({
    staffId: s.id,
    name: s.user.name,
    photo: s.user.profilePhoto,
    gender: s.user.gender,
    speciality: s.speciality,
  }));
};

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/** POST /owner/experts: a DRAFT expert from a staff row. A removed expert comes back as DRAFT. */
export const createExpert = async (user: AccessUser, ctx: AuditCtx, body: CreateExpertBody) => {
  await assertSalonPermission(user, body.salonId, "homeservice.manage");
  const staff = await prisma.staff.findFirst({
    where: { id: body.staffId, salonId: body.salonId },
    select: { id: true, isDeleted: true, status: true, homeExpert: true },
  });
  if (!staff || staff.isDeleted) throw notFound();
  if (!isStaffActive(staff)) throw new ApiError(StatusCodes.BAD_REQUEST, "This staff member is inactive.");

  const gender = body.gender as Gender;
  const audience = audienceOf(gender);
  await assertSideAllowed(body.salonId, audience);

  const existing = staff.homeExpert;
  if (existing && !existing.removedAt) {
    throw new ApiError(StatusCodes.CONFLICT, "This staff member is already a home expert.");
  }

  return prisma.$transaction(async (tx) => {
    let after: HomeExpert;
    if (existing) {
      await tx.homeExpertOffering.deleteMany({ where: { expertId: existing.id, offering: { audience: { not: audience } } } });
      after = await tx.homeExpert.update({
        where: { id: existing.id },
        data: {
          gender,
          audience,
          verification: ExpertVerification.DRAFT,
          isActive: true,
          removedAt: null,
          submittedAt: null,
          verifiedAt: null,
          verifiedById: null,
          rejectReason: null,
        },
      });
    } else {
      after = await tx.homeExpert.create({
        data: { staffId: staff.id, salonId: body.salonId, gender, audience },
      });
    }
    await auditExpert(tx, ctx, existing ? "homeService.expert_readd" : "homeService.expert_create", existing, after);
    return expertView(after);
  });
};

/** PATCH /owner/experts/:id */
export const updateExpert = async (user: AccessUser, ctx: AuditCtx, id: string, body: UpdateExpertBody) => {
  const before = await managedExpert(user, id);
  const data: Prisma.HomeExpertUpdateInput = {};
  if (body.headline !== undefined) data.headline = body.headline || null;
  if (body.languages !== undefined) data.languages = [...new Set(body.languages)];
  if (body.maxJobsPerDay !== undefined) data.maxJobsPerDay = body.maxJobsPerDay;
  if (body.isActive !== undefined) data.isActive = body.isActive;

  let newAudience: HomeAudience | null = null;
  if (body.gender !== undefined && body.gender !== before.gender) {
    if (!EDITABLE.includes(before.verification)) {
      throw new ApiError(
        StatusCodes.BAD_REQUEST,
        "Gender can't be changed after submitting. Ask SalonKhuji support.",
      );
    }
    newAudience = audienceOf(body.gender as Gender);
    await assertSideAllowed(before.salonId, newAudience);
    data.gender = body.gender as Gender;
    data.audience = newAudience;
  }

  return prisma.$transaction(async (tx) => {
    // Links to the other side go first; they could never be booked anyway.
    if (newAudience) {
      await tx.homeExpertOffering.deleteMany({ where: { expertId: id, offering: { audience: { not: newAudience } } } });
    }
    const { count } = await tx.homeExpert.updateMany({
      where: { id, removedAt: null, verification: before.verification, gender: before.gender },
      data: data as Prisma.HomeExpertUpdateManyMutationInput,
    });
    if (count === 0) throw conflict();
    const after = await tx.homeExpert.findUniqueOrThrow({ where: { id }, include: { offerings: { select: { offeringId: true } } } });
    await auditExpert(tx, ctx, "homeService.expert_update", before, after);
    return expertView(after);
  });
};

/** PUT /owner/experts/:id/offerings: replace the links in one go. */
export const setExpertOfferings = async (user: AccessUser, ctx: AuditCtx, id: string, offeringIds: string[]) => {
  const before = await managedExpert(user, id);
  const ids = [...new Set(offeringIds)];
  const offerings = ids.length
    ? await prisma.homeServiceOffering.findMany({
        where: { id: { in: ids }, salonId: before.salonId, isDeleted: false },
        select: { id: true, audience: true },
      })
    : [];
  if (offerings.length !== ids.length) throw notFound();
  const mismatched = offerings.filter((o) => o.audience !== before.audience).map((o) => o.id);
  if (mismatched.length) {
    const otherSide = before.audience === HomeAudience.LADIES ? HomeAudience.GENTS : HomeAudience.LADIES;
    throw ApiError.withCode(StatusCodes.BAD_REQUEST, `${sideRule(otherSide)}.`, "EXPERT_GENDER_MISMATCH", {
      offeringIds: mismatched,
    });
  }

  return prisma.$transaction(async (tx) => {
    const old = await tx.homeExpertOffering.findMany({ where: { expertId: id }, select: { offeringId: true } });
    await tx.homeExpertOffering.deleteMany({ where: { expertId: id } });
    if (ids.length) {
      await tx.homeExpertOffering.createMany({ data: ids.map((offeringId) => ({ expertId: id, offeringId })) });
    }
    await auditTx(tx, ctx, {
      action: "homeService.expert_offerings",
      entityType: "home_expert",
      entityId: id,
      salonId: before.salonId,
      before: { offeringIds: old.map((o) => o.offeringId) },
      after: { offeringIds: ids },
    });
    return { id, offeringIds: ids };
  });
};

/** POST /owner/experts/:id/doc-upload-signature: a signed direct upload to the private preset. */
export const docUploadSignature = async (user: AccessUser, id: string, kind: DocKind) => {
  const expert = await managedExpert(user, id);
  if (!EDITABLE.includes(expert.verification)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Documents can't be changed while the expert is under review or verified.");
  }
  // Cloudinary itself accepts a signature for an hour; the ticket we hand out says 10 minutes.
  const params = {
    public_id: `${docPrefix(id, kind)}${randomUUID()}`,
    timestamp: Math.round(Date.now() / 1000),
    upload_preset: config.homeService.docsPreset,
    type: "authenticated",
    tags: "home-expert-doc",
  };
  const signature = cloudinary.utils.api_sign_request(params, config.cloudinary.api_secret as string);
  return {
    kind,
    cloudName: config.cloudinary.cloud_name as string,
    apiKey: config.cloudinary.api_key as string,
    uploadUrl: `https://api.cloudinary.com/v1_1/${config.cloudinary.cloud_name}/image/upload`,
    params: { ...params, signature },
    expiresAt: new Date(params.timestamp * 1000 + UPLOAD_TICKET_MS),
    maxBytes: DOC_MAX_BYTES,
    formats: DOC_FORMATS,
  };
};

/** POST /owner/experts/:id/docs: record an uploaded document after checking it with the Admin API. */
export const saveExpertDoc = async (user: AccessUser, ctx: AuditCtx, id: string, body: ExpertDocBody) => {
  const before = await managedExpert(user, id);
  if (!EDITABLE.includes(before.verification)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "Documents can't be changed while the expert is under review or verified.");
  }
  if (!body.publicId.startsWith(docPrefix(id, body.kind))) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "This upload doesn't belong to this expert.");
  }
  const field = DOC_FIELD[body.kind];
  if (before[field] === body.publicId) return expertView(before);

  const info = await inspectDoc(body.publicId);
  if (!info) throw new ApiError(StatusCodes.BAD_REQUEST, "Upload not found. Try uploading again.");
  if (info.bytes > DOC_MAX_BYTES || !DOC_FORMATS.includes(info.format)) {
    await deleteDocs([body.publicId]);
    throw new ApiError(StatusCodes.BAD_REQUEST, "Documents must be JPG, PNG, WEBP or PDF, at most 8 MB.");
  }

  const after = await prisma.$transaction(async (tx) => {
    const { count } = await tx.homeExpert.updateMany({
      where: { id, removedAt: null, verification: { in: EDITABLE }, [field]: before[field] } as Prisma.HomeExpertWhereInput,
      data: { [field]: body.publicId } as Prisma.HomeExpertUpdateManyMutationInput,
    });
    if (count === 0) throw conflict();
    const row = await tx.homeExpert.findUniqueOrThrow({ where: { id } });
    await auditExpert(tx, ctx, "homeService.expert_doc_upload", before, row, { note: { kind: body.kind } });
    return row;
  });
  const old = before[field];
  if (old) void deleteDocs([old]);
  return expertView(after);
};

/** POST /owner/experts/:id/submit: send for verification. */
export const submitExpert = async (user: AccessUser, ctx: AuditCtx, id: string) => {
  const before = await managedExpert(user, id);
  if (!EDITABLE.includes(before.verification)) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "This expert is already submitted.");
  }
  const [staff, links] = await Promise.all([
    prisma.staff.findUnique({ where: { id: before.staffId }, select: { isDeleted: true, status: true, salonId: true } }),
    prisma.homeExpertOffering.count({ where: { expertId: id, offering: { isDeleted: false } } }),
  ]);
  const missing: string[] = [];
  for (const kind of DOC_KINDS) if (!before[DOC_FIELD[kind]]) missing.push(kind);
  if (links === 0) missing.push("OFFERING");
  if (!staff || staff.salonId !== before.salonId || !isStaffActive(staff)) missing.push("STAFF_ACTIVE");
  if (missing.length) {
    const e = new ApiError(
      StatusCodes.BAD_REQUEST,
      "Upload the ID front, ID back and a selfie, and link at least one service, before submitting.",
    );
    e.details = { missing };
    throw e;
  }

  return prisma.$transaction(async (tx) => {
    const { count } = await tx.homeExpert.updateMany({
      where: { id, removedAt: null, verification: before.verification },
      data: { verification: ExpertVerification.PENDING, submittedAt: new Date(), rejectReason: null },
    });
    if (count === 0) throw conflict();
    const after = await tx.homeExpert.findUniqueOrThrow({ where: { id } });
    await auditExpert(tx, ctx, "homeService.expert_submit", before, after);
    return expertView(after);
  });
};

/** DELETE /owner/experts/:id: soft remove. Documents go 90 days later (Phase 9 retention). */
export const removeExpert = async (user: AccessUser, ctx: AuditCtx, id: string, reason?: string) => {
  const before = await managedExpert(user, id);
  // A visit already on its way finishes first; upcoming ones are moved or cancelled below.
  const underWay = await prisma.homeBooking.count({
    where: {
      expertId: id,
      status: { in: [HomeBookingStatus.EN_ROUTE, HomeBookingStatus.ARRIVED, HomeBookingStatus.IN_PROGRESS] },
    },
  });
  if (underWay > 0) {
    const e = new ApiError(StatusCodes.CONFLICT, `This expert has ${underWay} home visit(s) under way. Finish them first.`);
    e.details = { underWay };
    throw e;
  }

  await prisma.$transaction(async (tx) => {
    const { count } = await tx.homeExpert.updateMany({
      where: { id, removedAt: null },
      data: { removedAt: new Date(), isActive: false },
    });
    if (count === 0) throw conflict();
    const after = await tx.homeExpert.findUniqueOrThrow({ where: { id } });
    await auditExpert(tx, ctx, "homeService.expert_remove", before, after, { reason });
  });
  // The salon's choice, so a visit nobody else can take is a salon cancel (full refund + credit).
  const upcoming = await rehomeExpertBookings(id, "SALON_CANCEL", {
    ctx,
    actorRole: user.role,
    reason: reason?.trim() || "Expert removed by the salon",
    action: "homeService.booking_salon_cancel",
  });
  return { id, upcoming };
};
