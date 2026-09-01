import { z } from "zod";

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "production", "test"]).default("development"),
  PORT: z.coerce.number().default(4000),
  DATABASE_URL: z.string().min(1, "DATABASE_URL is required"),

  // Master key used to wrap/unwrap each user's per-account data key.
  // Must be a 32-byte key, base64-encoded. Rotate carefully (see docs).
  MASTER_ENCRYPTION_KEY: z
    .string()
    .min(1, "MASTER_ENCRYPTION_KEY is required")
    .refine((v) => Buffer.from(v, "base64").length === 32, {
      message: "MASTER_ENCRYPTION_KEY must be a base64-encoded 32-byte key",
    }),

  JWT_ACCESS_SECRET: z.string().min(32, "JWT_ACCESS_SECRET must be at least 32 characters"),
  JWT_REFRESH_SECRET: z.string().min(32, "JWT_REFRESH_SECRET must be at least 32 characters"),

  ACCESS_TOKEN_TTL: z.string().default("15m"),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().default(30),

  APP_URL: z.string().default("http://localhost:5173"),
  COOKIE_SECURE: z
    .string()
    .default("true")
    .transform((v) => v === "true"),

  // Mail delivery: either "smtp" or "resend"
  MAIL_PROVIDER: z.enum(["smtp", "resend", "none"]).default("none"),
  MAIL_FROM: z.string().default("Car Tracker <no-reply@example.com>"),

  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().optional(),
  SMTP_SECURE: z
    .string()
    .optional()
    .transform((v) => v === "true"),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),

  RESEND_API_KEY: z.string().optional(),

  REMINDER_CRON: z.string().default("0 8 * * *"),
});

export type Env = z.infer<typeof envSchema>;

function loadEnv(): Env {
  const parsed = envSchema.safeParse(process.env);
  if (!parsed.success) {
    console.error("Invalid environment configuration:");
    for (const issue of parsed.error.issues) {
      console.error(`  - ${issue.path.join(".")}: ${issue.message}`);
    }
    process.exit(1);
  }
  return parsed.data;
}

export const env = loadEnv();
