import { HomeAudience } from "@prisma/client";
import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import ApiError from "../../Error/error";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { withAccessCache } from "../../utils/salonAccess";
import { buildAuditCtx } from "../Admin/admin.middleware";
import * as Admin from "./home.admin";
import * as Booking from "./home.booking";
import * as Experts from "./home.expertSetup";
import * as Owner from "./home.owner";
import * as Public from "./home.public";

const ctxOf = (req: Request) => buildAuditCtx(req, req.user!.role);
const ok = <T>(res: Response, message: string, data: T, statusCode: number = StatusCodes.OK) =>
  sendResponse(res, { statusCode, success: true, message, data });

// ---------------------------------------------------------------- owner: profile

const getProfile = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service profile", await Owner.getOwnerProfile(withAccessCache(req), String(req.query.salonId)));
});

const turnOn = catchAsync(async (req: Request, res: Response) => {
  const data = await Owner.turnOn(withAccessCache(req), ctxOf(req), req.body);
  ok(res, data.status === "PENDING_REVIEW" ? "Sent for review" : "Home Service is on", data);
});

const turnOff = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service is off", await Owner.turnOff(withAccessCache(req), ctxOf(req), req.body));
});

const pause = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service paused", await Owner.pause(withAccessCache(req), ctxOf(req), req.body));
});

const resume = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service resumed", await Owner.resume(withAccessCache(req), ctxOf(req), req.body));
});

const updateProfile = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Settings saved", await Owner.updateProfile(withAccessCache(req), ctxOf(req), req.body));
});

// ---------------------------------------------------------------- owner: menu

const listOfferings = catchAsync(async (req: Request, res: Response) => {
  const audience = req.query.audience ? (String(req.query.audience) as HomeAudience) : undefined;
  ok(res, "Home menu", await Owner.listOfferings(withAccessCache(req), String(req.query.salonId), audience));
});

const createOffering = catchAsync(async (req: Request, res: Response) => {
  const data = await Owner.createOffering(withAccessCache(req), ctxOf(req), req.body);
  ok(res, "Service added", data, StatusCodes.CREATED);
});

const updateOffering = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Service updated", await Owner.updateOffering(withAccessCache(req), ctxOf(req), String(req.params.id), req.body));
});

const toggleOffering = catchAsync(async (req: Request, res: Response) => {
  const data = await Owner.toggleOffering(withAccessCache(req), ctxOf(req), String(req.params.id));
  ok(res, data.isActive ? "Service shown" : "Service hidden", data);
});

const deleteOffering = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Service removed", await Owner.deleteOffering(withAccessCache(req), ctxOf(req), String(req.params.id)));
});

// ---------------------------------------------------------------- owner: experts

const id = (req: Request) => String(req.params.id);

const listExperts = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home experts", await Experts.listExperts(withAccessCache(req), String(req.query.salonId)));
});

const listCandidates = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Staff who can become home experts", await Experts.listCandidates(withAccessCache(req), String(req.query.salonId)));
});

const createExpert = catchAsync(async (req: Request, res: Response) => {
  const data = await Experts.createExpert(withAccessCache(req), ctxOf(req), req.body);
  ok(res, "Expert added", data, StatusCodes.CREATED);
});

const updateExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Expert updated", await Experts.updateExpert(withAccessCache(req), ctxOf(req), id(req), req.body));
});

const setExpertOfferings = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Services linked", await Experts.setExpertOfferings(withAccessCache(req), ctxOf(req), id(req), req.body.offeringIds));
});

const docUploadSignature = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Upload ticket", await Experts.docUploadSignature(withAccessCache(req), id(req), req.body.kind));
});

const saveExpertDoc = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Document saved", await Experts.saveExpertDoc(withAccessCache(req), ctxOf(req), id(req), req.body));
});

const submitExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Sent for verification", await Experts.submitExpert(withAccessCache(req), ctxOf(req), id(req)));
});

const removeExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Expert removed", await Experts.removeExpert(withAccessCache(req), ctxOf(req), id(req), req.body?.reason));
});

// ---------------------------------------------------------------- admin

const page = <T extends { meta: unknown; data: unknown }>(res: Response, message: string, result: T) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, meta: result.meta as never, data: result.data });

const adminProfiles = catchAsync(async (req: Request, res: Response) => {
  page(res, "Home Service branches", await Admin.listProfiles(req.query));
});

const adminApproveProfile = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service approved", await Admin.approveProfile(req.auditCtx, id(req), req.body?.reason));
});

const adminRejectProfile = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service rejected", await Admin.rejectProfile(req.auditCtx, id(req), req.body.reason));
});

const adminSuspendProfile = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service suspended", await Admin.suspendProfile(req.auditCtx, id(req), req.body.reason));
});

const adminUnsuspendProfile = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service unsuspended", await Admin.unsuspendProfile(req.auditCtx, id(req), req.body?.reason));
});

const adminExperts = catchAsync(async (req: Request, res: Response) => {
  page(res, "Home experts", await Admin.listExperts(req.query));
});

const adminExpertDocuments = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Expert documents (links expire in 5 minutes)", await Admin.expertDocuments(req.auditCtx, id(req)));
});

const adminVerifyExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Expert verified", await Admin.verifyExpert(req.auditCtx, id(req), req.body?.reason));
});

const adminRejectExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Expert rejected", await Admin.rejectExpert(req.auditCtx, id(req), req.body.reason));
});

const adminSuspendExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Expert suspended", await Admin.suspendExpert(req.auditCtx, id(req), req.body.reason));
});

const adminExpertGender = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Gender updated; the expert needs verifying again", await Admin.setExpertGender(req.auditCtx, id(req), req.body.gender, req.body.reason));
});

// ---------------------------------------------------------------- public reads

const viewerOf = (req: Request) => (req.user?.userId ? { userId: String(req.user.userId) } : undefined);

const publicCatalog = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home Service catalog", await Public.getCatalog(viewerOf(req), req.query));
});

const publicExperts = catchAsync(async (req: Request, res: Response) => {
  const { meta, data } = await Public.listExperts(viewerOf(req), req.query);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Home experts", meta, data });
});

const publicExpert = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home expert", await Public.getExpert(viewerOf(req), String(req.params.id), req.query));
});

const publicAvailability = catchAsync(async (req: Request, res: Response) => {
  const data = await Public.getAvailability(viewerOf(req), req.query);
  res.set("Cache-Control", "no-store");
  ok(res, "Available times", data);
});

const publicAvailabilityDays = catchAsync(async (req: Request, res: Response) => {
  const data = await Public.getAvailabilityDays(viewerOf(req), req.query);
  res.set("Cache-Control", "no-store");
  ok(res, "Available days", data);
});

// ---------------------------------------------------------------- customer bookings

const actorOf = (req: Request): Booking.Actor => ({ userId: String(req.user!.userId), impersonating: Boolean(req.user?.imp) });

const quote = catchAsync(async (req: Request, res: Response) => {
  res.set("Cache-Control", "no-store");
  ok(res, "Home visit quote", await Booking.quote(actorOf(req), req.body));
});

const createBooking = catchAsync(async (req: Request, res: Response) => {
  const key = req.get("idempotency-key")?.trim();
  if (!key || key.length > 100) {
    throw new ApiError(StatusCodes.BAD_REQUEST, "An Idempotency-Key header (up to 100 characters) is required.");
  }
  const lang = req.body.lang ?? (/^bn\b/i.test(req.get("accept-language") ?? "") ? "bn" : "en");
  const data = await Booking.createBooking(actorOf(req), req.body, key, lang);
  ok(res, "Booking created. Pay the advance to confirm it.", data, StatusCodes.CREATED);
});

const payBooking = catchAsync(async (req: Request, res: Response) => {
  const data = await Booking.payBooking(actorOf(req), id(req), req.body.method);
  ok(res, data.status === "CONFIRMED" ? "Booking confirmed" : "Continue to payment", data);
});

const myBookings = catchAsync(async (req: Request, res: Response) => {
  const tab = req.query.tab === "past" ? "past" : "upcoming";
  const page = Math.max(1, Number(req.query.page) || 1);
  const { meta, data } = await Booking.listMyBookings(String(req.user!.userId), tab, page);
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "My home visits", meta, data });
});

const getBooking = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Home visit", await Booking.getBooking(String(req.user!.userId), id(req)));
});

export const HomeController = {
  quote,
  createBooking,
  payBooking,
  myBookings,
  getBooking,
  publicCatalog,
  publicExperts,
  publicExpert,
  publicAvailability,
  publicAvailabilityDays,
  getProfile,
  turnOn,
  turnOff,
  pause,
  resume,
  updateProfile,
  listOfferings,
  createOffering,
  updateOffering,
  toggleOffering,
  deleteOffering,
  listExperts,
  listCandidates,
  createExpert,
  updateExpert,
  setExpertOfferings,
  docUploadSignature,
  saveExpertDoc,
  submitExpert,
  removeExpert,
  adminProfiles,
  adminApproveProfile,
  adminRejectProfile,
  adminSuspendProfile,
  adminUnsuspendProfile,
  adminExperts,
  adminExpertDocuments,
  adminVerifyExpert,
  adminRejectExpert,
  adminSuspendExpert,
  adminExpertGender,
};
