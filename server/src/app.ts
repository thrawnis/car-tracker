import express from "express";
import helmet from "helmet";
import cors from "cors";
import cookieParser from "cookie-parser";
import { pinoHttp } from "pino-http";
import rateLimit from "express-rate-limit";
import { env } from "./env.js";
import { authRouter } from "./routes/auth.js";
import { vehiclesRouter } from "./routes/vehicles.js";
import { maintenanceRouter } from "./routes/maintenance.js";
import { fuelRouter } from "./routes/fuel.js";
import { odometerRouter } from "./routes/odometer.js";
import { reminderRulesRouter } from "./routes/reminderRules.js";
import { remindersRouter } from "./routes/reminders.js";
import { backupRouter } from "./routes/backup.js";

export function createApp(): express.Express {
  const app = express();

  // Required for correct req.ip / secure cookies when running behind the bundled
  // nginx reverse proxy (see client/nginx.conf and docker-compose.yml).
  app.set("trust proxy", 1);

  app.use(helmet());
  app.use(cors({ origin: env.APP_URL, credentials: true }));
  app.use(express.json({ limit: "5mb" }));
  app.use(cookieParser());
  if (env.NODE_ENV !== "test") app.use(pinoHttp());

  const apiLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 120,
    standardHeaders: true,
    legacyHeaders: false,
    // Integration tests exercise far more request volume, from one "IP", than
    // any real client would - rate limiting stays on in dev/production.
    skip: () => env.NODE_ENV === "test",
  });
  app.use("/api", apiLimiter);

  app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

  app.use("/api/auth", authRouter);
  app.use("/api/vehicles", vehiclesRouter);
  app.use("/api/vehicles/:vehicleId/maintenance", maintenanceRouter);
  app.use("/api/vehicles/:vehicleId/fuel", fuelRouter);
  app.use("/api/vehicles/:vehicleId/odometer", odometerRouter);
  app.use("/api/vehicles/:vehicleId/reminder-rules", reminderRulesRouter);
  app.use("/api/reminders", remindersRouter);
  app.use("/api/backup", backupRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    // eslint-disable-next-line no-console
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  });

  return app;
}
