import dns from "node:dns/promises";
import ipaddr from "ipaddr.js";
export function publicAddress(address) {
  try {
    return ipaddr.process(address).range() === "unicast";
  } catch {
    return false;
  }
}
export async function validatePublicImageUrl(value) {
  const u = new URL(value);
  if (
    u.protocol !== "https:" ||
    u.username ||
    u.password ||
    (u.port && u.port !== "443")
  )
    throw Object.assign(
      new Error("Use a direct public HTTPS image URL without credentials."),
      { httpStatus: 400 },
    );
  const host = u.hostname.replace(/^\[|\]$/g, "");
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some((a) => !publicAddress(a.address)))
    throw Object.assign(
      new Error("Image URLs must resolve to public internet addresses."),
      { httpStatus: 400 },
    );
  return u.href;
}
export function joinedGroup(entity) {
  return Boolean(
    entity &&
    !entity.left &&
    !entity.kicked &&
    !entity.deactivated &&
    (entity.className === "Chat" ||
      (entity.className === "Channel" && entity.megagroup)),
  );
}
