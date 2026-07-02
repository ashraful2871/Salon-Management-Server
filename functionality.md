# Salon Management System

A comprehensive multi-tenant platform for managing salons. It empowers salon owners to register and run their businesses, allows customers to seamlessly book services, and gives administrators robust oversight of the entire ecosystem.

---

## 🚀 Project Proposal

### Overview
The Salon Management System is designed to bridge the gap between salon businesses and their clientele. By providing a centralized platform, it digitizes salon operations, from staff and service management to appointment scheduling and payment processing.

### Objectives
- **For Customers**: Provide a seamless, intuitive booking experience allowing them to discover salons, book appointments, and leave reviews.
- **For Salon Owners**: Streamline operations by offering tools to manage staff, services, counters, and appointments, alongside powerful business analytics.
- **For Administrators**: Enable robust platform oversight, allowing admins to vet new salons, manage users, and monitor overall platform health.

---

## 👥 Roles and Permissions

The system operates on a robust Role-Based Access Control (RBAC) mechanism with four distinct user roles:

1. **Admin**: Platform administrators with complete oversight. They manage users, approve or reject new salon applications, and view platform-wide analytics.
2. **Salon Owner**: Business owners who manage their specific salon(s). They control store details, services, staff, counters, and track their revenue and appointments.
3. **Staff**: Employees assigned to specific salons. They can view their assigned appointments and manage their availability status (Available, Busy, On Leave, Inactive).
4. **Customer**: End-users who can browse salons, view services, book appointments, make payments, and leave reviews.

---

## ✨ Features & Functionality

### 1. Authentication & User Management
- **Registration & Login**: Secure authentication system for all roles.
- **Role-Based Access**: Specialized dashboards and protected routes based on user role.
- **Profile Management**: Users can update their personal information and settings.
- **User Status Tracking**: Support for Active, Inactive, Suspended, Deleted, and Blocked user states.

### 2. Public Platform (Customer Facing)
- **Home/Landing Page**: Showcases the platform, featured salons, and top services.
- **Salons Directory**: Customers can browse, search, and filter available salons.
- **Salon Details**: View comprehensive salon information including address, operating hours, service menus, and aggregated ratings.
- **Become a Salon Owner**: A dedicated application portal for prospective salon owners to submit their business for admin approval.

### 3. Salon Management (Owner Dashboard)
- **Store Settings**: Update salon profile, description, images, operating hours, and contact information.
- **Service Management**: Create, update, and manage services across categories (Haircut, Styling, Coloring, Spa, Facial, Massage, etc.) with specific pricing and durations.
- **Staff Management**: Add staff members, assign them to specific services, and track their performance.
- **Counter/Station Management**: Allocate counters for specific services and appointments to avoid double-booking.
- **Business Statistics**: Dashboard widgets displaying total appointments, revenue, and active staff.

### 4. Appointment Booking System
- **Booking Flow**: Intuitive process for customers to select a salon, choose a service, pick an available date/time, and confirm their booking.
- **Status Lifecycle**: Appointments flow through states: `PENDING`, `CONFIRMED`, `IN_PROGRESS`, `COMPLETED`, `CANCELLED`, and `NO_SHOW`.
- **Assignment**: Appointments are assigned to specific staff members and service counters.
- **History & Tracking**: Dedicated views for customers to see past/upcoming bookings, and for owners/staff to manage their schedules.

### 5. Payment & Billing
- **Payment Processing**: Integrated payment tracking for completed appointments.
- **Payment Methods**: Support for Cash, Card, Online, and Mobile Banking transactions.
- **Payment Lifecycle**: Track payments through states: `PENDING`, `COMPLETED`, `FAILED`, and `REFUNDED`.

### 6. Ratings & Reviews
- Customers can leave detailed reviews and ratings (1-5 stars) for salons and services after an appointment is completed.
- Salons display aggregated ratings and total review counts to build trust.

### 7. Administrative Oversight (Admin Dashboard)
- **Application Approvals**: Review, approve, or reject pending "Become a Salon Owner" requests.
- **Global User Management**: Manage all Customers, Staff, and Salon Owners.
- **Platform Analytics**: Comprehensive view of platform activities, total registered salons, user growth, and transaction volumes.

---

## 🛠️ Technology Stack

- **Frontend**: Next.js, React, Tailwind CSS.
- **Backend**: Node.js, Express.js.
- **Database**: PostgreSQL with Prisma ORM.
- **State & Data Management**: Typescript.

---

## 📦 Getting Started

### Prerequisites
- Node.js (v18+)
- PostgreSQL
- Bun (or npm/yarn)

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   ```

2. **Setup Backend (`Salon-Management-Server`):**
   ```bash
   cd Salon-Management-Server
   npm install # or bun install
   cp .env.example .env
   npx prisma generate
   npx prisma db push
   npm run dev
   ```

3. **Setup Frontend (`Salon-Management-Frontend`):**
   ```bash
   cd Salon-Management-Frontend
   npm install # or bun install
   cp .env.example .env
   npm run dev
   ```

The frontend will be accessible at `http://localhost:3000` and the backend API at your configured port.
