import express, { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../../shared/catchAsync";
import sendResponse from "../../../shared/sendResponse";
import validateRequest from "../../../middlewares/validateRequest";
import { adminAuth, adminOnly } from "../admin.middleware";
import { AdminSupportService } from "./support.service";
import { AdminSupportValidation } from "./support.validation";

/** /admin/support - the ticket inbox. Admins only. */
const router = express.Router();

const ok = (res: Response, message: string, data: unknown, meta?: unknown) =>
  sendResponse(res, { statusCode: StatusCodes.OK, success: true, message, meta: meta as never, data });

router.get(
  "/tickets",
  adminAuth("support.view"),
  adminOnly,
  validateRequest(AdminSupportValidation.list),
  catchAsync(async (req: Request, res: Response) => {
    const result = await AdminSupportService.list(req.user!.userId, req.query as Record<string, string | undefined>);
    ok(res, "Tickets", result.data, result.meta);
  }),
);

router.get(
  "/assignees",
  adminAuth("support.view"),
  adminOnly,
  catchAsync(async (_req: Request, res: Response) => {
    ok(res, "Assignees", await AdminSupportService.assignees());
  }),
);

router.get(
  "/tickets/:id",
  adminAuth("support.view"),
  adminOnly,
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Ticket", await AdminSupportService.getTicket(String(req.params.id)));
  }),
);

router.post(
  "/tickets/:id/messages",
  adminAuth("support.reply"),
  adminOnly,
  validateRequest(AdminSupportValidation.reply, { replaceBody: true }),
  catchAsync(async (req: Request, res: Response) => {
    const data = await AdminSupportService.reply(req.auditCtx, req.user!.userId, String(req.params.id), req.body);
    sendResponse(res, {
      statusCode: StatusCodes.CREATED,
      success: true,
      message: req.body.internal
        ? "Note added"
        : data.emailed
          ? "Reply sent"
          : "Reply saved, but the email didn't go out",
      data,
    });
  }),
);

router.patch(
  "/tickets/:id",
  adminAuth("support.assign"),
  adminOnly,
  validateRequest(AdminSupportValidation.update, { replaceBody: true }),
  catchAsync(async (req: Request, res: Response) => {
    ok(res, "Ticket updated", await AdminSupportService.update(req.auditCtx, String(req.params.id), req.body));
  }),
);

export const AdminSupportRoutes = router;
