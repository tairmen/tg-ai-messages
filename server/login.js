import { createInterface } from "node:readline/promises";
import fs from "node:fs/promises";
import qrcode from "qrcode-terminal";
import { makeClient, sessionPath, credentials } from "./telegram.js";
import { pool } from "./db.js";
import { normalizePhone, loginError } from "./login-utils.js";
const rl = createInterface({ input: process.stdin, output: process.stdout });
let client;
try {
  client = makeClient();
  const auth = {
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
    phoneCode: async (isApp, info) => {
      const delivery = info?.type || (isApp ? "app" : "unknown");
      console.log("Telegram reports code delivery: " + delivery);
      if (delivery === "app")
        console.log(
          "Open the verified Telegram service chat on an already signed-in device for this same phone number.",
        );
      if (delivery === "sms")
        console.log(
          "Check the SMS inbox for this phone number, not the Telegram chat.",
        );
      if (
        delivery === "call" ||
        delivery === "flashCall" ||
        delivery === "missedCall"
      )
        console.log("Check incoming calls for this number.");
      if (info?.nextType)
        console.log("Telegram offers a later fallback: " + info.nextType + ".");
      return (await rl.question("Enter the received login code: ")).trim();
    },
    password: () =>
      rl.question("Two-step password (visible in this local terminal): "),
    emailAddress: () => rl.question("Telegram login email: "),
    emailVerification: async () =>
      (await rl.question("Code sent to your Telegram login email: ")).trim(),
    // Throw deliberately: this library's onError return semantics vary by version.
    // Never loop silently or repeatedly request fresh login codes after a failure.
    onError: (error) => {
      throw error;
    },
  };
  if (process.argv.includes("--qr")) {
    const { id, hash } = credentials();
    const abort = new AbortController();
    const timeout = setTimeout(() => abort.abort(), 180000);
    try {
      await client.connect();
      console.log(
        "On your phone: Telegram > Settings > Devices > Link Desktop Device. Scan the QR below.",
      );
      await client.signInUserWithQrCode(
        { apiId: id, apiHash: hash },
        {
          qrCode: async ({ token }) => {
            console.log(
              "Scan the latest QR (refreshes automatically). Keep it private.",
            );
            qrcode.generate("tg://login?token=" + token.toString("base64url"), {
              small: true,
            });
          },
          password: auth.password,
          onError: auth.onError,
          abortSignal: abort.signal,
        },
      );
    } finally {
      clearTimeout(timeout);
    }
  } else {
    await client.start(auth);
  }
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
