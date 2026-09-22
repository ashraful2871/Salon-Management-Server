import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { GeoService } from "./geo.service";
import { GeoValidation } from "./geo.validation";

const search = catchAsync(async (req: Request, res: Response) => {
  // Parsed here, not in validateRequest, so the coerced numbers survive.
  const query = GeoValidation.searchQuery.parse(req.query);
  const places = await GeoService.searchPlaces(query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: places.length
      ? `Found ${places.length} place${places.length === 1 ? "" : "s"}`
      : "No matching places found",
    data: places,
  });
});

const reverse = catchAsync(async (req: Request, res: Response) => {
  const query = GeoValidation.reverseQuery.parse(req.query);
  const place = await GeoService.reverseGeocode(query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Address found",
    data: place,
  });
});

export const GeoController = { search, reverse };
