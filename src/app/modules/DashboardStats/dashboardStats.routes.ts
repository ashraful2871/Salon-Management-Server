import express from 'express';
import { DashboardStatsController } from './dashboardStats.controller';
import auth from '../../middlewares/auth';
import { adminAuth } from '../Admin/admin.middleware';

const router = express.Router();

router.get('/admin', adminAuth('analytics.view'), DashboardStatsController.getAdminDashboardStats);

router.get(
  '/salon-owner',
  auth('SALON_OWNER'),
  DashboardStatsController.getSalonOwnerDashboardStats
);

router.get('/customer', auth('CUSTOMER'), DashboardStatsController.getCustomerDashboardStats);

export const DashboardStatsRoutes = router;
