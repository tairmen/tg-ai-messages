import { hash } from "./mcp-utils.js";
export async function sendOnce({ request, claim, finish, loadContact, send }) {
  const fingerprint = hash(
    JSON.stringify({
      contact_id: request.contact_id || null,
      phone: request.phone || null,
      body: request.body,
      ...(request.username ? { username: request.username } : {}),
      ...(request.group_id ? { group_id: request.group_id } : {}),
      ...(request.image_url ? { image_url: request.image_url } : {}),
    }),
  );
  const existing = await claim(request.request_id, fingerprint);
  if (existing) {
    if (existing.fingerprint !== fingerprint)
      throw Object.assign(
        new Error("This request ID was already used for a different message."),
        { httpStatus: 409 },
      );
    return (
      existing.result || {
        request_id: request.request_id,
        status: existing.status,
        error:
          "This request is already processing or its delivery is uncertain. Do not automatically retry with a new ID.",
      }
    );
  }
  try {
    const c = await loadContact(request);
    const result = await send(c, request.body, "direct");
    const output = {
      request_id: request.request_id,
      status: "sent",
      ...(request.group_id
        ? { group_id: c.id, title: c.title }
        : { contact_id: c.id }),
      phone: c.phone,
      username: c.username || null,
      ...result,
    };
    await finish(request.request_id, "sent", output);
    return output;
  } catch (e) {
    const state = e.errorMessage || e.httpStatus ? "failed" : "uncertain";
    const result = {
      request_id: request.request_id,
      status: state,
      error:
        e.errorMessage ||
        (e.httpStatus && e.message) ||
        "Delivery could not be confirmed. Check the conversation before sending again.",
    };
    await finish(request.request_id, state, result);
    return result;
  }
}
