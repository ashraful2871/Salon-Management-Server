import { Request, Response } from 'express';
import { StatusCodes } from 'http-status-codes';
import catchAsync from '../../shared/catchAsync';
import sendResponse from '../../shared/sendResponse';
import { DashboardStatsService } from './dashboardStats.service';

const getAdminDashboardStats = catchAsync(async (req: Request, res: Response) => {
  const result = await DashboardStatsService.getAdminDashboardStats();

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Admin dashboard stats retrieved successfully',
    data: result,
  });
});

const getSalonOwnerDashboardStats = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await DashboardStatsService.getSalonOwnerDashboardStats(userId);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Salon owner dashboard stats retrieved successfully',
    data: result,
  });
});

const getCustomerDashboardStats = catchAsync(async (req: Request, res: Response) => {
  const userId = req.user?.userId;

  const result = await DashboardStatsService.getCustomerDashboardStats(userId);

  sendResponse(res, {
    statusCode: StatusCodes.OK,
    success: true,
    message: 'Customer dashboard stats retrieved successfully',
    data: result,
  });
});

export const DashboardStatsController = {
  getAdminDashboardStats,
  getSalonOwnerDashboardStats,
  getCustomerDashboardStats,
};
