import { createInterface } from "node:readline/promises";
import fs from "node:fs/promises";
import { makeClient, sessionPath } from "./telegram.js";
import { pool } from "./db.js";
const rl = createInterface({ input: process.stdin, output: process.stdout });
const client = makeClient();
try {
  await client.start({
    phoneNumber: () => rl.question("Telegram phone (+380...): "),
    phoneCode: () => rl.question("Login code from Telegram: "),
    password: () =>
      rl.question("Two-step password (visible in this local terminal): "),
    onError: () => console.log("Login failed; please retry."),
  });
  await fs.mkdir(new URL("../.data/", import.meta.url), { recursive: true });
  await fs.writeFile(sessionPath, client.session.save(), { mode: 0o600 });
  console.log("Telegram connected. Restart the app to load this session.");
} catch {
  console.error("Could not complete login.");
  process.exitCode = 1;
} finally {
  rl.close();
  await client.disconnect();
  await pool.end();
  process.exit(process.exitCode || 0);
}
