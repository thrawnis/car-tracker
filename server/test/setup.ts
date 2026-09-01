import { TEST_ENV } from "./env.js";

for (const [key, value] of Object.entries(TEST_ENV)) {
  process.env[key] = value;
}
