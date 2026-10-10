import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import { CONTENT_ICONS, describeSettings, MAX_FEATURED_SALONS } from "../../../utils/settings";
import { resolveFeaturedSalons } from "../../Settings/settings.service";
import { adminAuth, adminOnly } from "../admin.middleware";

/**
 * /admin/content — the content.* settings for the Content page, with each
 * featured salon's live status. Saving goes through PATCH /admin/settings/:key
 * (content.manage, tier 2), which audits `content.update`.
 */
const router = express.Router();

router.get(
  "/",
  adminAuth("content.manage"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    const [settings, featuredSalons] = await Promise.all([
      describeSettings(),
      resolveFeaturedSalons(true),
    ]);
    sendResponse(res, {
      statusCode: StatusCodes.OK,
      success: true,
      message: "Content",
      data: {
        settings: settings
          .filter((s) => s.group === "content")
          .map(({ key, value, default: fallback, version, updatedAt }) => ({
            key,
            value,
            default: fallback,
            version,
            updatedAt,
          })),
        featuredSalons,
        icons: CONTENT_ICONS,
        maxFeatured: MAX_FEATURED_SALONS,
      },
    });
  }),
);

export const AdminContentRoutes = router;
