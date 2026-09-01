import "dotenv/config";
import { env } from "./env.js";
import { createApp } from "./app.js";
import { startReminderScheduler } from "./services/reminderScheduler.js";

const app = createApp();

app.listen(env.PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`car-tracker server listening on port ${env.PORT}`);
  startReminderScheduler();
});
