export function normalizeUsername(value) {
  const username = value.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9_]{1,32}$/.test(username))
    throw Object.assign(
      new Error("Use a Telegram username such as @example, without a URL."),
      { httpStatus: 400 },
    );
  return username;
}
export function importedUser(result, clientId) {
  const wanted = String(clientId);
  if (result.retryContacts?.some((id) => String(id) === wanted))
    throw Object.assign(
      new Error(
        "Telegram deferred this phone lookup because of a server-side limit. No message was sent. Try later or use a username.",
      ),
      { httpStatus: 429 },
    );
  const entry = result.imported?.find((i) => String(i.clientId) === wanted);
  return entry
    ? result.users?.find(
        (u) => String(u.id) === String(entry.userId) && !u.deleted && !u.bot,
      )
    : undefined;
}
