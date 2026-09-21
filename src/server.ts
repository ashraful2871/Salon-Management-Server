import { Server } from "http";
import app from "./app";
import config from "./config";
import { seedAdmin } from "./app/seed/admin.seed";
import { startBackgroundJobs } from "./app/jobs/scheduler";

async function main() {
  // Slot "HH:mm" times are read as server-local. Anywhere but Dhaka, every
  // cancellation window, past-slot check and no-show sweep runs hours off.
  if (new Date().getTimezoneOffset() !== -360) {
    console.warn(
      "[tz] Server is not on Asia/Dhaka (UTC+6). Slot times are read as server-local - set TZ=Asia/Dhaka.",
    );
  }

  try {
    // Seed admin user
    await seedAdmin();

    // Reconciliation, auto no-show and wallet drift checks
    startBackgroundJobs();

    const server: Server = app.listen(config.port, () => {
      console.log(`Server is running on port ${config.port}`);
    });

    const exitHandler = () => {
      if (server) {
        server.close(() => {
          console.info("Server closed");
        });
      }
      process.exit(1);
    };

    const unexpectedErrorHandler = (error: unknown) => {
      console.error(error);
      exitHandler();
    };

    process.on("uncaughtException", unexpectedErrorHandler);
    process.on("unhandledRejection", unexpectedErrorHandler);

    process.on("SIGTERM", () => {
      console.info("SIGTERM received");
      if (server) {
        server.close();
      }
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

main();
