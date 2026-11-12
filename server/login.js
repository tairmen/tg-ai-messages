import { createInterface } from "node:readline/promises";
import fs from "node:fs/promises";
import { makeClient, sessionPath } from "./telegram.js";
import { pool } from "./db.js";
import { normalizePhone, loginError } from "./login-utils.js";
const rl = createInterface({ input: process.stdin, output: process.stdout });
let client;
try {
  client = makeClient();
  await client.start({
    phoneNumber: async () => {
      for (;;) {
        try {
          return normalizePhone(
            await rl.question(
              "Telegram phone (full number starting with +380): ",
            ),
          );
        } catch (error) {
          console.error(error.message);
        }
      }
    },
    phoneCode: () => rl.question("Login code from Telegram: "),
    password: () =>
      rl.question("Two-step password (visible in this local terminal): "),
    emailAddress: () => rl.question("Telegram login email: "),
    emailVerification: async () => ({
      code: await rl.question("Code sent to your Telegram login email: "),
    }),
    // Throw deliberately: this library's onError return semantics vary by version.
    // Never loop silently or repeatedly request fresh login codes after a failure.
    onError: (error) => {
      throw error;
    },
  });
  if (!(await client.isUserAuthorized()))
    throw new Error("Authorization was not completed");
  await fs.mkdir(new URL("../.data/", import.meta.url), { recursive: true });
  await fs.writeFile(sessionPath, client.session.save(), { mode: 0o600 });
  console.log(
    "Telegram connected. Click Settings > Connect saved session in the dashboard.",
  );
} catch (error) {
  console.error(loginError(error));
  process.exitCode = 1;
} finally {
  rl.close();
  if (client) await client.disconnect().catch(() => {});
  await pool.end();
  process.exit(process.exitCode || 0);
}
