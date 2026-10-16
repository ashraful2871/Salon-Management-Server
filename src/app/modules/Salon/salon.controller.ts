import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { SalonService } from "./salon.service";
import { withAccessCache } from "../../utils/salonAccess";
import { findSalonMarkers } from "./salon.geo";
import { NEARBY_MAX_RADIUS_KM, SalonValidation } from "./salon.validation";
import { recordSearchTerm } from "../Analytics/analytics.capture";
import { buildAuditCtx } from "../Admin/admin.middleware";
import { SalonClosureService } from "./salon.closure";
import { SalonPauseService } from "./salon.pause";

const idParam = (req: Request, key: string) => String(req.params[key]);

const listClosures = catchAsync(async (req: Request, res: Response) => {
  const from = typeof req.query.from === "string" ? req.query.from : undefined;
  const data = await SalonClosureService.listClosures(withAccessCache(req), idParam(req, "id"), { from });
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Closures", data });
});

const createClosure = catchAsync(async (req: Request, res: Response) => {
  const data = await SalonClosureService.createClosure(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    idParam(req, "id"),
    req.body,
  );
  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: data.notice ?? "Closure added",
    data,
  });
});

const deleteClosure = catchAsync(async (req: Request, res: Response) => {
  const data = await SalonClosureService.deleteClosure(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    idParam(req, "id"),
    idParam(req, "closureId"),
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Closure removed", data });
});

const getPause = catchAsync(async (req: Request, res: Response) => {
  const data = await SalonPauseService.getPause(withAccessCache(req), idParam(req, "id"));
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Booking status", data });
});

const pauseSalon = catchAsync(async (req: Request, res: Response) => {
  const data = await SalonPauseService.pauseSalon(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    idParam(req, "id"),
    req.body,
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Online bookings paused", data });
});

const resumeSalon = catchAsync(async (req: Request, res: Response) => {
  const data = await SalonPauseService.resumeSalon(
    withAccessCache(req),
    buildAuditCtx(req, req.user!.role),
    idParam(req, "id"),
  );
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message: "Online bookings resumed", data });
});

const createSalon = catchAsync(async (req: Request, res: Response) => {

  const result = await SalonService.createSalon(withAccessCache(req), req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: "Salon created successfully",
    data: result,
  });
});

const getAllSalons = catchAsync(async (req: Request, res: Response) => {
  // Parsed here, not in validateRequest, so the coerced numbers survive.
  const query = SalonValidation.salonListQuery.parse(req.query);
  const result = await SalonService.getAllSalons(
    { ...query, radiusKm: Math.min(query.radiusKm, NEARBY_MAX_RADIUS_KM) },
    req.user,
  );

  // Discovery analytics: first page only (paging is not a new search), and
  // not the back office browsing the list. Fire and forget.
  if (query.searchTerm && query.page === 1 && !["ADMIN", "AGENT"].includes(req.user?.role ?? "")) {
    recordSearchTerm(query.searchTerm, "LIST", result.meta.total === 0);
  }

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salons retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getSalonMarkers = catchAsync(async (req: Request, res: Response) => {
  const {
    bbox: [minLng, minLat, maxLng, maxLat],
    lat,
    lng,
    radiusKm,
  } = SalonValidation.salonMapQuery.parse(req.query);
  const near =
    lat !== undefined && lng !== undefined
      ? { lat, lng, radiusKm: Math.min(radiusKm, NEARBY_MAX_RADIUS_KM) }
      : undefined;
  const result = await findSalonMarkers(minLng, minLat, maxLng, maxLat, near);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon markers retrieved successfully",
    data: result,
  });
});

const getMySalons = catchAsync(async (req: Request, res: Response) => {

  const result = await SalonService.getMySalons(withAccessCache(req), req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "My salons retrieved successfully",
    meta: result.meta,
    data: result.data,
  });
});

const getSalonById = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;
  const result = await SalonService.getSalonById(id, req.user);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon retrieved successfully",
    data: result,
  });
});

const updateSalon = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await SalonService.updateSalon(withAccessCache(req), id, req.body);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon updated successfully",
    data: result,
  });
});

const updateSalonLocation = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  const result = await SalonService.updateSalonLocation(withAccessCache(req), id, {
    latitude: req.body.latitude,
    longitude: req.body.longitude,
  });

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon location updated successfully",
    data: result,
  });
});

const deleteSalon = catchAsync(async (req: Request, res: Response) => {
  const idParam = req.params.id;
  const id = Array.isArray(idParam) ? idParam[0] : idParam;

  await SalonService.deleteSalon(withAccessCache(req), id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Salon deleted successfully",
    data: null,
  });
});

export const SalonController = {
  createSalon,
  getAllSalons,
  getSalonMarkers,
  getMySalons,
  getSalonById,
  listClosures,
  createClosure,
  deleteClosure,
  getPause,
  pauseSalon,
  resumeSalon,
  updateSalon,
  updateSalonLocation,
  deleteSalon,
};
