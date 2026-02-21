import express from "express";
import { AuthRoutes } from "../modules/Auth/auth.routes";
import { UserRoutes } from "../modules/User/user.routes";
import { SalonRoutes } from "../modules/Salon/salon.routes";
import { ServiceRoutes } from "../modules/Service/service.routes";
import { StaffRoutes } from "../modules/Staff/staff.routes";
import { AppointmentRoutes } from "../modules/Appointment/appointment.routes";
import { PaymentRoutes } from "../modules/Payment/payment.routes";
import { ReviewRoutes } from "../modules/Review/review.routes";
import { DashboardStatsRoutes } from "../modules/DashboardStats/dashboardStats.routes";
import { SalonOwnerRoutes } from "../modules/BecomeASalonWoner/salonOwner.route";
import { CounterRoutes } from "../modules/Counter/counter.route";

const router = express.Router();

const moduleRoutes = [
  {
    path: "/auth",
    route: AuthRoutes,
  },
  {
    path: "/users",
    route: UserRoutes,
  },
  {
    path: "/salons",
    route: SalonRoutes,
  },
  {
    path: "/services",
    route: ServiceRoutes,
  },
  {
    path: "/staff",
    route: StaffRoutes,
  },
  {
    path: "/appointments",
    route: AppointmentRoutes,
  },
  {
    path: "/counters",
    route: CounterRoutes,
  },
  {
    path: "/payments",
    route: PaymentRoutes,
  },
  {
    path: "/reviews",
    route: ReviewRoutes,
  },
  {
    path: "/dashboard-stats",
    route: DashboardStatsRoutes,
  },
  {
    path: "/become-salon-owner",
    route: SalonOwnerRoutes,
  },
];

moduleRoutes.forEach((route) => router.use(route.path, route.route));

export default router;
