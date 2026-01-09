import express from 'express';
import { DashboardStatsController } from './dashboardStats.controller';
import auth from '../../middlewares/auth';

const router = express.Router();

router.get('/admin', auth('ADMIN'), DashboardStatsController.getAdminDashboardStats);

router.get(
  '/salon-owner',
  auth('SALON_OWNER'),
  DashboardStatsController.getSalonOwnerDashboardStats
);

router.get('/customer', auth('CUSTOMER'), DashboardStatsController.getCustomerDashboardStats);

export const DashboardStatsRoutes = router;
