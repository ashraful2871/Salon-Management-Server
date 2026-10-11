import { Request, Response } from "express";
import { StatusCodes } from "http-status-codes";
import catchAsync from "../../shared/catchAsync";
import sendResponse from "../../shared/sendResponse";
import { clientIp } from "../../middlewares/rateLimiter";
import { ContactService } from "./contact.service";

const sendContact = catchAsync(async (req: Request, res: Response) => {
  const data = await ContactService.sendContactMessage(req.body, clientIp(req));

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: `Message sent — ticket #${data.ticketNumber}. We'll get back to you soon.`,
    data,
  });
});

export const ContactController = {
  sendContact,
};
