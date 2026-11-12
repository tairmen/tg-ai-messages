export function normalizePhone(value) {
  const phone = value.trim().replace(/[\s()-]/g, "");
  if (!/^\+[1-9]\d{7,14}$/.test(phone)) {
    throw new Error(
      "Use the full international number starting with +, for example +380 followed by the 9-digit Ukrainian number.",
    );
  }
  return phone;
}
export function loginError(error) {
  const code =
    typeof error?.errorMessage === "string" ? error.errorMessage : "";
  const hints = {
    API_ID_INVALID:
      "Check api_id and api_hash in .env against my.telegram.org/apps.",
    API_ID_PUBLISHED_FLOOD:
      "Telegram has restricted these API credentials. Check your application at my.telegram.org.",
    PHONE_NUMBER_INVALID:
      "Use a full international number starting with +380 for Ukraine.",
    PHONE_NUMBER_BANNED:
      "Telegram has banned this number. Check the account in the official Telegram app.",
    PHONE_CODE_INVALID:
      "The login code is incorrect. Restart login and enter the code from Telegram.",
    PHONE_CODE_EXPIRED:
      "The login code has expired. Restart login to request a fresh code.",
    PASSWORD_HASH_INVALID: "The two-step verification password is incorrect.",
    SESSION_PASSWORD_NEEDED:
      "Telegram requires your two-step verification password.",
  };
  if (code.startsWith("FLOOD_WAIT") || error?.name === "FloodWaitError") {
    return `Telegram rate limit. Wait ${Number.isFinite(error.seconds) ? error.seconds + " seconds" : "before trying again"}.`;
  }
  if (code)
    return `${code}. ${hints[code] || "Telegram rejected this login step. Check the account in the official app."}`;
  if (/Request was unsuccessful 0 time/.test(error?.message || ""))
    return "Client configuration error: no Telegram request attempts were allowed.";
  if (/email/i.test(error?.message || ""))
    return "Telegram requires an email verification step. Follow the email prompts or sign in using the official app first.";
  if (/payment/i.test(error?.message || ""))
    return "Telegram requires a paid login-code step supported only in the official Telegram app.";
  return `Login could not finish (${error?.name || "unknown error"}). No session was saved. Check your connection and try again.`;
}
