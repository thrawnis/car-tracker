import { execSync } from "node:child_process";
import { TEST_ENV } from "./env.js";

// Runs once, in its own process, before any test file. Pushes the current
// Prisma schema to the test database so tests always run against an
// up-to-date, disposable schema (never against the dev/prod database).
export async function setup() {
  execSync("npx prisma db push --skip-generate --accept-data-loss", {
    stdio: "inherit",
    env: { ...process.env, ...TEST_ENV },
  });
}
