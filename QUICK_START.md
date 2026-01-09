# Quick Start Guide - Salon Management Server

## Prerequisites
- Node.js (v18+)
- PostgreSQL (v12+)
- npm or yarn

## Installation Steps

### 1. Install Dependencies
```bash
npm install
```

### 2. Environment Setup
Create a `.env` file in the root directory:
```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgresql://user:password@localhost:5432/salon_management
JWT_SECRET=your-super-secret-jwt-key-change-this
EXPIRES_IN=1h
REFRESH_TOKEN_SECRET=your-super-secret-refresh-token-key-change-this
REFRESH_TOKEN_EXPIRES_IN=90d
CLOUDINARY_CLOUD_NAME=your-cloudinary-cloud-name
CLOUDINARY_API_KEY=your-cloudinary-api-key
CLOUDINARY_API_SECRET=your-cloudinary-api-secret
```

### 3. Database Setup

**Option A: Push Schema (Development)**
```bash
npm run prisma:generate
npm run prisma:push
```

**Option B: Migrations (Production)**
```bash
npm run prisma:generate
npm run prisma:migrate
```

### 4. Start Development Server
```bash
npm run dev
```

The server will start at `http://localhost:5000`

### 5. Default Admin Access
On first startup, a default admin account is created:
- **Email**: admin@salon.com
- **Password**: admin123456

**⚠️ IMPORTANT**: Change this password immediately after first login!

## API Testing

### Health Check
```bash
curl http://localhost:5000
```

### Login as Admin
```bash
curl -X POST http://localhost:5000/api/v1/auth/login \
  -H "Content-Type: application/json" \
  -d '{
    "email": "admin@salon.com",
    "password": "admin123456"
  }'
```

### Get Profile
```bash
curl http://localhost:5000/api/v1/auth/me \
  -H "Authorization: <your-access-token>"
```

## API Endpoints Overview

### Authentication (`/api/v1/auth`)
- POST `/register` - Register new user
- POST `/login` - Login user
- POST `/logout` - Logout user
- POST `/refresh-token` - Refresh access token
- POST `/change-password` - Change password
- GET `/me` - Get current user profile

### Users (`/api/v1/users`)
- GET `/` - List all users (Admin)
- GET `/:id` - Get user by ID
- PATCH `/:id` - Update user
- PATCH `/:id/status` - Update user status (Admin)
- PATCH `/:id/role` - Update user role (Admin)
- DELETE `/:id` - Delete user (Admin)

### Salons (`/api/v1/salons`)
- POST `/` - Create salon (Salon Owner)
- GET `/` - List all salons (Public)
- GET `/my-salons` - Get owner's salons
- GET `/:id` - Get salon details
- PATCH `/:id` - Update salon
- PATCH `/:id/status` - Update salon status (Admin)
- DELETE `/:id` - Delete salon

### Services (`/api/v1/services`)
- POST `/` - Create service (Salon Owner)
- GET `/` - List all services (Public)
- GET `/:id` - Get service details
- PATCH `/:id` - Update service
- DELETE `/:id` - Delete service

### Staff (`/api/v1/staff`)
- POST `/` - Add staff (Salon Owner)
- GET `/` - List all staff
- GET `/:id` - Get staff details
- PATCH `/:id` - Update staff
- DELETE `/:id` - Remove staff

### Appointments (`/api/v1/appointments`)
- POST `/` - Book appointment (Customer)
- GET `/` - List appointments (Role-filtered)
- GET `/my-appointments` - Customer's appointments
- GET `/:id` - Get appointment details
- PATCH `/:id/status` - Update appointment status
- DELETE `/:id` - Cancel appointment

### Payments (`/api/v1/payments`)
- POST `/` - Create payment
- GET `/` - List payments (Admin/Salon Owner)
- GET `/:id` - Get payment details

### Reviews (`/api/v1/reviews`)
- POST `/` - Create review (Customer)
- GET `/` - List reviews
- GET `/:id` - Get review details

### Dashboard Stats (`/api/v1/dashboard-stats`)
- GET `/admin` - Admin dashboard stats
- GET `/salon-owner` - Salon owner dashboard stats
- GET `/customer` - Customer dashboard stats

## User Roles

### CUSTOMER
- Browse salons and services
- Book appointments
- Leave reviews
- View booking history

### STAFF
- View assigned appointments
- Update appointment status
- Manage profile

### SALON_OWNER
- Create and manage salons
- Add services and staff
- View appointments and payments
- Access salon analytics

### ADMIN
- Full system access
- Manage all users
- Approve/reject salons
- View all data and analytics

## Production Build

```bash
# Build
npm run build

# Start production server
npm start
```

## Troubleshooting

### Database Connection Issues
- Verify PostgreSQL is running
- Check DATABASE_URL in .env
- Ensure database exists

### Port Already in Use
- Change PORT in .env file
- Kill process using port 5000: `lsof -ti:5000 | xargs kill`

### Prisma Client Issues
- Regenerate client: `npm run prisma:generate`
- Reset database: `npx prisma db push --force-reset`

## Support
For issues, please check the README.md or create an issue on GitHub.
