import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../shared/catchAsync';
import sendResponse from '../../shared/sendResponse';
import { PaymentService } from './payment.service';

const createPayment = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentService.createPayment(req.body);

  sendResponse(res, {
    statusCode: StatusCodes.CREATED,
    success: true,
    message: 'Payment created successfully',
    data: result,
  });
});

const getAllPayments = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;
  const userRole = req.user?.role;

  const result = await PaymentService.getAllPayments(userId, userRole, req.query);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Payments retrieved successfully',
    meta: result.meta,
    data: result.data,
  });
});

const getPaymentById = catchAsync(async (req: Request, res: Response) => {
  const result = await PaymentService.getPaymentById(req.params.id);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Payment retrieved successfully',
    data: result,
  });
});

export const PaymentController = {
  createPayment,
  getAllPayments,
  getPaymentById,
};
