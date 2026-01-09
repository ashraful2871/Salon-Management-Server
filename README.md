# Salon Management Server

A comprehensive backend application for managing salon operations, built with Node.js, Express, TypeScript, Prisma, and PostgreSQL.

## Features

- **Role-Based Access Control (RBAC)**: Four user roles - Customer, Staff, Salon Owner, and Admin
- **Authentication**: JWT-based authentication with access and refresh tokens stored in HTTP-only cookies
- **Salon Management**: Create and manage salons with details, services, staff, and operating hours
- **Service Management**: Manage salon services with categories, pricing, and duration
- **Staff Management**: Add staff members to salons and assign services
- **Appointment Booking**: Customers can book appointments with specific services and staff
- **Payment Processing**: Track payments with multiple payment methods
- **Review System**: Customers can review salons and staff after completed appointments
- **Dashboard Statistics**: Role-specific dashboard stats for Admin, Salon Owner, and Customer
- **File Upload**: Support for image uploads via Cloudinary
- **Soft Delete**: Soft delete functionality for users, salons, services, and staff
- **Pagination**: Pagination support for all list endpoints

## Tech Stack

- **Runtime**: Node.js with TypeScript
- **Framework**: Express.js 5.x
- **ORM**: Prisma with PostgreSQL
- **Authentication**: JWT (jsonwebtoken)
- **Validation**: Zod
- **File Upload**: Multer + Cloudinary
- **Password Hashing**: bcryptjs
- **Cookie Management**: cookie-parser

## Prerequisites

- Node.js (v18 or higher)
- PostgreSQL (v12 or higher)
- npm or yarn

## Installation

1. Clone the repository:
```bash
git clone https://github.com/ashraful2871/Salon-Management-Server.git
cd Salon-Management-Server
```

2. Install dependencies:
```bash
npm install
```

3. Create a `.env` file in the root directory and add the following environment variables:
```env
NODE_ENV=development
PORT=5000
DATABASE_URL=postgresql://user:password@localhost:5432/salon_management
JWT_SECRET=your-jwt-secret
EXPIRES_IN=1h
REFRESH_TOKEN_SECRET=your-refresh-token-secret
REFRESH_TOKEN_EXPIRES_IN=90d
CLOUDINARY_CLOUD_NAME=your-cloud-name
CLOUDINARY_API_KEY=your-api-key
CLOUDINARY_API_SECRET=your-api-secret
```

4. Generate Prisma Client:
```bash
npm run prisma:generate
```

5. Push the database schema:
```bash
npm run prisma:push
```

Or run migrations (recommended for production):
```bash
npm run prisma:migrate
```

## Available Scripts

- `npm run dev` - Start development server with hot reload
- `npm run build` - Build the TypeScript project
- `npm start` - Start the production server
- `npm run prisma:generate` - Generate Prisma Client
- `npm run prisma:push` - Push schema changes to database
- `npm run prisma:migrate` - Run database migrations

## Default Admin Credentials

On first startup, a default admin user is automatically created:

- **Email**: admin@salon.com
- **Password**: admin123456

**Important**: Change the password immediately after first login!

## API Endpoints

### Authentication (`/api/v1/auth`)
- `POST /register` - User registration
- `POST /login` - User login
- `POST /logout` - User logout
- `POST /refresh-token` - Refresh access token
- `POST /change-password` - Change password (authenticated)
- `GET /me` - Get current user profile

### Users (`/api/v1/users`)
- `GET /` - Get all users (Admin only)
- `GET /:id` - Get user by ID
- `PATCH /:id` - Update user profile
- `PATCH /:id/status` - Update user status (Admin only)
- `PATCH /:id/role` - Update user role (Admin only)
- `DELETE /:id` - Delete user (Admin only)

### Salons (`/api/v1/salons`)
- `POST /` - Create salon (Salon Owner only)
- `GET /` - Get all salons (public)
- `GET /my-salons` - Get owner's salons (Salon Owner only)
- `GET /:id` - Get salon details (public)
- `PATCH /:id` - Update salon (Salon Owner only)
- `PATCH /:id/status` - Update salon status (Admin only)
- `DELETE /:id` - Delete salon (Salon Owner/Admin)

### Services (`/api/v1/services`)
- `POST /` - Create service (Salon Owner only)
- `GET /` - Get all services (public, filterable)
- `GET /:id` - Get service details
- `PATCH /:id` - Update service (Salon Owner only)
- `DELETE /:id` - Delete service (Salon Owner only)

### Staff (`/api/v1/staff`)
- `POST /` - Add staff (Salon Owner only)
- `GET /` - Get all staff (filterable)
- `GET /:id` - Get staff details
- `PATCH /:id` - Update staff (Salon Owner only)
- `DELETE /:id` - Remove staff (Salon Owner only)

### Appointments (`/api/v1/appointments`)
- `POST /` - Book appointment (Customer only)
- `GET /` - Get appointments (role-filtered)
- `GET /my-appointments` - Get customer's appointments
- `GET /:id` - Get appointment details
- `PATCH /:id/status` - Update appointment status
- `DELETE /:id` - Cancel appointment

### Payments (`/api/v1/payments`)
- `POST /` - Create payment
- `GET /` - Get payments (Admin/Salon Owner)
- `GET /:id` - Get payment details

### Reviews (`/api/v1/reviews`)
- `POST /` - Create review (Customer only, after completed appointment)
- `GET /` - Get reviews (filterable)
- `GET /:id` - Get review details

### Dashboard Stats (`/api/v1/dashboard-stats`)
- `GET /admin` - Admin dashboard statistics
- `GET /salon-owner` - Salon owner dashboard statistics
- `GET /customer` - Customer dashboard statistics

## Folder Structure

```
Salon-Management-Server/
├── prisma/
│   └── schema/                 # Prisma schema files
│       ├── schema.prisma       # Generator & datasource config
│       ├── enum.prisma         # All enums
│       ├── user.prisma         # User models
│       ├── salon.prisma        # Salon model
│       ├── service.prisma      # Service models
│       ├── staff.prisma        # Staff model
│       ├── appointment.prisma  # Appointment model
│       ├── payment.prisma      # Payment model
│       └── review.prisma       # Review model
├── src/
│   ├── app/
│   │   ├── Error/              # Error classes
│   │   ├── helper/             # Helper utilities (JWT, file upload)
│   │   ├── middlewares/        # Express middlewares
│   │   ├── modules/            # Feature modules
│   │   │   ├── Auth/           # Authentication module
│   │   │   ├── User/           # User management module
│   │   │   ├── Salon/          # Salon management module
│   │   │   ├── Service/        # Service management module
│   │   │   ├── Staff/          # Staff management module
│   │   │   ├── Appointment/    # Appointment module
│   │   │   ├── Payment/        # Payment module
│   │   │   ├── Review/         # Review module
│   │   │   └── DashboardStats/ # Dashboard statistics module
│   │   ├── routes/             # Route definitions
│   │   ├── seed/               # Database seeding
│   │   └── shared/             # Shared utilities
│   ├── config/                 # Configuration files
│   ├── types/                  # TypeScript type definitions
│   ├── app.ts                  # Express app setup
│   └── server.ts               # Server entry point
├── uploads/                    # Uploaded files (temporary)
├── .env.example                # Environment variables template
├── .gitignore                  # Git ignore rules
├── package.json                # NPM dependencies
├── tsconfig.json               # TypeScript configuration
└── README.md                   # This file
```

## User Roles

### CUSTOMER
- Register and manage profile
- Browse salons and services
- Book appointments
- Make payments
- Leave reviews after completed appointments
- View booking history

### STAFF
- View assigned appointments
- Update appointment status
- Manage profile

### SALON_OWNER
- Create and manage salons
- Add and manage services
- Add and manage staff
- View salon appointments
- View salon payments
- View salon reviews and ratings
- Access salon dashboard statistics

### ADMIN
- Full system access
- Manage all users
- Approve/reject salons
- Update salon status
- View all appointments and payments
- Access admin dashboard statistics

## Database Schema

The application uses Prisma ORM with PostgreSQL. The schema includes:

- **Users**: Base user table with authentication
- **Admins**: Extended admin profiles
- **SalonOwners**: Business owner profiles
- **Salons**: Salon information and settings
- **Services**: Services offered by salons
- **Staff**: Salon employees
- **StaffServices**: Many-to-many relationship
- **Appointments**: Booking records
- **Payments**: Payment transactions
- **Reviews**: Customer feedback

## Security Features

- JWT-based authentication
- HTTP-only cookies for refresh tokens
- Password hashing with bcryptjs
- Role-based access control
- Input validation with Zod
- Soft delete for data retention
- User status management (active, inactive, suspended, blocked)

## Error Handling

The application includes comprehensive error handling:
- Global error handler for all routes
- Prisma error handling
- Zod validation error handling
- Custom API errors with status codes
- Not found handler for invalid routes

## Development

To run the application in development mode:

```bash
npm run dev
```

The server will start at `http://localhost:5000` with hot reload enabled.

## Production

To build and run in production:

```bash
npm run build
npm start
```

## Contributing

1. Fork the repository
2. Create a feature branch
3. Commit your changes
4. Push to the branch
5. Open a Pull Request

## License

ISC

## Support

For issues and questions, please open an issue on GitHub.
