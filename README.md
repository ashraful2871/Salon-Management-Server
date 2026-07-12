# Salon Management Backend

![Node.js](https://img.shields.io/badge/Node.js-18.x-339933?style=for-the-badge&logo=nodedotjs&logoColor=white)
![Express](https://img.shields.io/badge/Express.js-4.18-404D59?style=for-the-badge)
![TypeScript](https://img.shields.io/badge/TypeScript-5.0-007ACC?style=for-the-badge&logo=typescript&logoColor=white)
![Prisma](https://img.shields.io/badge/Prisma-6.x-2D3748?style=for-the-badge&logo=prisma&logoColor=white)
![PostgreSQL](https://img.shields.io/badge/PostgreSQL-316192?style=for-the-badge&logo=postgresql&logoColor=white)
![Bun](https://img.shields.io/badge/Bun-%23000000.svg?style=for-the-badge&logo=bun&logoColor=white)

A robust, scalable backend RESTful API for the Salon Management System built with **Node.js**, **Express**, **TypeScript**, and **Prisma ORM**.

---

## 🌟 Overview

The **Salon Management Backend** serves as the core engine powering the salon management application. It handles user authentication, role-based access control, appointment scheduling, service management, and integrations with external services like Cloudinary for image hosting and Google's Gemini AI.

## 🚀 Tech Stack

- **Runtime**: [Node.js](https://nodejs.org/)
- **Framework**: [Express.js](https://expressjs.com/)
- **Language**: [TypeScript](https://www.typescriptlang.org/)
- **ORM**: [Prisma](https://www.prisma.io/)
- **Database**: [PostgreSQL](https://www.postgresql.org/) (Compatible with Neon)
- **Validation**: [Zod](https://zod.dev/)
- **Authentication**: JWT (JSON Web Tokens) & `bcryptjs`
- **File Uploads**: `multer` & [Cloudinary](https://cloudinary.com/)
- **AI Integration**: Google Generative AI (Gemini)

## 🛠️ Features

- **Authentication & Authorization**: Secure login with JWT, access/refresh token rotation, and Role-Based Access Control (RBAC).
- **Database Management**: Strongly typed database access and schema migrations using Prisma.
- **Image Processing**: Direct integration with Cloudinary for seamless media uploads.
- **Data Validation**: Request payload validation using Zod.
- **AI Capabilities**: Integrated with Google Gemini for intelligent salon insights.

## ⚙️ Getting Started

### Prerequisites

- [Node.js](https://nodejs.org/) (v18+)
- [Bun](https://bun.sh/) (or `npm`/`yarn`)
- PostgreSQL Database

### Installation

1. **Clone the repository:**
   ```bash
   git clone <repository-url>
   cd Salon-Management-Server
   ```

2. **Install dependencies:**
   ```bash
   bun install
   ```

3. **Set up environment variables:**
   Create a `.env` file in the root directory and configure it based on `.env.example`.

   ```env
   # Server Configuration
   NODE_ENV=development
   PORT=5000

   # Database
   DATABASE_URL=postgresql://user:password@localhost:5432/salon_management_db?schema=public

   # Authentication Secrets
   JWT_SECRET=your-jwt-secret
   EXPIRES_IN=1h
   ACCESS_TOKEN_SECRET=your-access-token-secret
   ACCESS_TOKEN_EXPIRES_IN=7d
   REFRESH_TOKEN_SECRET=your-refresh-token-secret
   REFRESH_TOKEN_EXPIRES_IN=90d

   # Cloudinary (Image Uploads)
   CLOUDINARY_CLOUD_NAME=your-cloud-name
   CLOUDINARY_API_KEY=your-api-key
   CLOUDINARY_API_SECRET=your-api-secret

   # AI Integration
   GEMINI_API_KEY=your-gemini-api-key
   ```

   | Variable | Description | Example |
   | :--- | :--- | :--- |
   | `PORT` | The port the server runs on | `5000` |
   | `DATABASE_URL` | PostgreSQL connection string | `postgresql://...` |
   | `JWT_SECRET` | Secret key for JWT signing | `secret` |
   | `CLOUDINARY_*` | Cloudinary credentials | - |
   | `GEMINI_API_KEY` | Google Gemini API key | - |

4. **Run Database Migrations:**
   Synchronize your Prisma schema with the database.
   ```bash
   bunx prisma db push
   # or
   npx prisma db push
   ```

5. **Run the development server:**
   ```bash
   bun run dev
   ```

   The server will start on `http://localhost:5000`.

## 📂 Project Structure

```plaintext
├── prisma/             # Prisma schema and migrations
├── src/                
│   ├── app/            # Application logic (Routes, Controllers, Services)
│   ├── config/         # Environment variables and configurations
│   ├── errors/         # Global error handling mechanisms
│   ├── interfaces/     # TypeScript interfaces and types
│   ├── middlewares/    # Express middlewares (Auth, Validation, etc.)
│   ├── utils/          # Helper functions and utilities
│   └── server.ts       # Application entry point
├── package.json        # Project metadata and scripts
└── tsconfig.json       # TypeScript configuration
```

## 📜 Available Scripts

- `bun run dev`: Starts the development server with hot-reloading (`ts-node-dev`).
- `bun run build`: Compiles TypeScript source code to the `dist` folder.
- `bun run start`: Runs the compiled application for production.

## 🤝 Contributing

1. Fork the repository.
2. Create a new branch (`git checkout -b feature/amazing-feature`).
3. Commit your changes (`git commit -m 'Add some amazing feature'`).
4. Push to the branch (`git push origin feature/amazing-feature`).
5. Open a Pull Request.

## 📄 License

This project is licensed under the ISC License.
