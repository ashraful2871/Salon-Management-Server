import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { clientIp } from "../../middlewares/rateLimiter";
import { ContactService } from "./contact.service";

const sendContact = catchAsync(async (req: Request, res: Response) => {
  await ContactService.sendContactMessage(req.body, clientIp(req));

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: "Message sent. We'll get back to you soon.",
  });
});

export const ContactController = {
  sendContact,
};
