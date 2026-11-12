import crypto from "node:crypto";
export const scopes = [
  "relay:read",
  "relay:write",
  "relay:send",
  "offline_access",
];
export const hash = (value) =>
  crypto.createHash("sha256").update(value).digest("hex");
export const random = () => crypto.randomBytes(32).toString("base64url");
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function previewCampaign(campaign, contacts) {
  const recipients = campaign.recipient_ids.map((id) => {
    const c = contacts.find((c) => c.id === id);
    if (!c) throw new Error("A campaign contact no longer exists");
    const message = campaign.body.replaceAll("{{name}}", c.name);
    if (message.length > 4096)
      throw new Error(
        "A personalized message exceeds Telegram’s 4096-character limit",
      );
    return {
      contact_id: c.id,
      name: c.name,
      phone: c.phone,
      opted_out: c.opted_out,
      message,
    };
  });
  const view = {
    campaign_id: campaign.id,
    name: campaign.name,
    status: campaign.status,
    recipients,
  };
  return { ...view, preview_hash: hash(JSON.stringify(view)) };
}
