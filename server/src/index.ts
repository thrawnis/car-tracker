import "dotenv/config";
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
import { startReminderScheduler } from "./services/reminderScheduler.js";

const app = express();

// Required for correct req.ip / secure cookies when running behind the bundled
// nginx reverse proxy (see client/nginx.conf and docker-compose.yml).
app.set("trust proxy", 1);

app.use(helmet());
app.use(cors({ origin: env.APP_URL, credentials: true }));
app.use(express.json({ limit: "5mb" }));
app.use(cookieParser());
app.use(pinoHttp());

const apiLimiter = rateLimit({ windowMs: 60 * 1000, limit: 120, standardHeaders: true, legacyHeaders: false });
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

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`car-tracker server listening on port ${env.PORT}`);
  startReminderScheduler();
});
