import express from 'express';
import { DashboardStatsController } from './dashboardStats.controller';
import auth from '../../middlewares/auth';
import { adminAuth } from '../Admin/admin.middleware';
import validateRequest from '../../middlewares/validateRequest';
import { OwnerValidation } from '../Owner/owner.validation';

const router = express.Router();

router.get('/admin', adminAuth('analytics.view'), DashboardStatsController.getAdminDashboardStats);

router.get(
  '/salon-owner',
  auth('SALON_OWNER'),
  validateRequest(OwnerValidation.branchQuery),
  DashboardStatsController.getSalonOwnerDashboardStats
);

router.get('/customer', auth('CUSTOMER'), DashboardStatsController.getCustomerDashboardStats);

export const DashboardStatsRoutes = router;
