// Fixed, non-secret test configuration shared by globalSetup and setupFiles.
// Never used outside the test environment.
export const TEST_ENV = {
  NODE_ENV: "test",
  DATABASE_URL:
    process.env.TEST_DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/car_tracker_test",
  MASTER_ENCRYPTION_KEY: "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=",
  JWT_ACCESS_SECRET: "test-jwt-access-secret-at-least-32-chars-long",
  JWT_REFRESH_SECRET: "test-jwt-refresh-secret-at-least-32-chars-long",
  APP_URL: "http://localhost:5173",
  COOKIE_SECURE: "false",
  MAIL_PROVIDER: "none",
} as const;
