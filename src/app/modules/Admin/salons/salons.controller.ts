import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { loadAdminContext } from "../admin.middleware";
import { AdminSalonsService } from "./salons.service";

type Query = Record<string, string | undefined>;

const ok = (res: Response, message: string, result: { meta?: unknown; data: unknown }) =>
  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message,
    meta: result.meta as never,
    data: result.data,
  });

const STATUS_MESSAGES: Record<string, string> = {
  ACTIVE: "Salon is live",
  REJECTED: "Salon rejected",
  SUSPENDED: "Salon suspended",
  INACTIVE: "Salon set inactive",
};

const list = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Salons", await AdminSalonsService.listSalons(admin, req.query as Query));
});

const get = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Salon", { data: await AdminSalonsService.getSalon(admin, req.params.id) });
});

const services = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Services", { data: await AdminSalonsService.listServices(req.params.id) });
});

const team = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Team", { data: await AdminSalonsService.listTeam(admin, req.params.id) });
});

const bookings = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Bookings", await AdminSalonsService.listBookings(req.params.id, req.query as Query));
});

const reviews = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Reviews", await AdminSalonsService.listReviews(req.params.id, req.query as Query));
});

const money = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Money", await AdminSalonsService.getMoney(req.params.id, req.query as Query));
});

const activity = catchAsync(async (req: Request, res: Response) => {
  ok(res, "Activity", await AdminSalonsService.listActivity(req.params.id, req.query as Query));
});

const impact = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Impact", { data: await AdminSalonsService.getImpact(admin, req.params.id) });
});

/** Also mounted as the older `PATCH /salons/:id/status`. */
const updateStatus = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const data = await AdminSalonsService.updateStatus(admin, req.auditCtx, id, req.body);
  ok(res, STATUS_MESSAGES[data.status] ?? "Salon status updated", { data });
});

const cancelUpcoming = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  const data = await AdminSalonsService.cancelUpcoming(admin, req.auditCtx, req.params.id, req.body.reason);
  ok(res, `Cancelled ${data.cancelled} booking(s)${data.failed ? `, ${data.failed} failed` : ""}`, { data });
});

const updateLocation = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Pin updated", {
    data: await AdminSalonsService.updateLocation(admin, req.auditCtx, req.params.id, req.body),
  });
});

const updateListing = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Listing updated", {
    data: await AdminSalonsService.updateListing(admin, req.auditCtx, req.params.id, req.body),
  });
});

const reindex = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  const data = await AdminSalonsService.reindex(admin, req.auditCtx, req.params.id);
  ok(res, data.outcome === "unchanged" ? "Search index already up to date" : "Salon re-indexed", { data });
});

const remove = catchAsync(async (req: Request, res: Response) => {
  const admin = await loadAdminContext(req);
  ok(res, "Salon deleted", {
    data: await AdminSalonsService.deleteSalon(admin, req.auditCtx, req.params.id, req.body),
  });
});

export const AdminSalonsController = {
  list,
  get,
  services,
  team,
  bookings,
  reviews,
  money,
  activity,
  impact,
  updateStatus,
  cancelUpcoming,
  updateLocation,
  updateListing,
  reindex,
  remove,
};
