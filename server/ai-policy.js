import { z } from "zod";
export const aiPreferences = {
  ai_enabled: z.boolean().optional(),
  ai_instructions: z.string().max(12000).optional(),
  ai_mode: z.enum(["immediate", "scheduled"]).optional(),
  ai_interval_minutes: z.number().int().min(1).max(10080).optional(),
};
export const decisionSchema = z
  .object({
    send: z.boolean(),
    body: z.string().trim().max(4000),
    reason: z.string().trim().min(1).max(2000),
  })
  .strict()
  .refine(
    (v) => !v.send || v.body.length > 0,
    "A send decision requires message text",
  );
export function eligible(target, settings, mode) {
  return Boolean(
    target &&
    settings?.enabled &&
    target.ai_enabled &&
    !target.opted_out &&
    target.ai_mode === mode,
  );
}
// All events for a target share one worker. New incoming messages invalidate a draft.
export function createAiRunner({
  load,
  master,
  history,
  decide,
  send,
  record,
  lock,
  concurrency = 4,
}) {
  const running = new Map();
  let active = 0;
  const queue = [];
  async function takeSlot() {
    if (active >= concurrency)
      await new Promise((resolve) => queue.push(resolve));
    else active++;
    return () => {
      const next = queue.shift();
      if (next) next();
      else active--;
    };
  }
  return async function run(kind, id, mode) {
    const key = kind + ":" + id;
    if (running.has(key)) {
      if (mode === "immediate" && running.get(key).mode === "immediate")
        running.get(key).dirty = true;
      return;
    }
    const state = { dirty: false, mode };
    running.set(key, state);
    let release, releaseSlot;
    let deliveryStarted = false;
    try {
      releaseSlot = await takeSlot();
      release = await lock(kind, id);
      if (!release) return;
      do {
        state.dirty = false;
        const target = await load(kind, id),
          settings = await master();
        if (!eligible(target, settings, mode)) return;
        const messages = await history(kind, target, mode);
        const result = decisionSchema.parse(
          await decide(target, settings, messages, mode),
        );
        if (state.dirty) continue;
        const fresh = await load(kind, id),
          current = await master();
        if (
          !eligible(fresh, current, mode) ||
          fresh.ai_revision !== target.ai_revision ||
          current.model !== settings.model ||
          current.instructions !== settings.instructions
        )
          return;
        if (state.dirty) continue;
        if (result.send) {
          deliveryStarted = true;
          await send(kind, fresh, result.body);
          deliveryStarted = false;
        }
        await record(kind, id, {
          status: result.send ? "sent" : "skipped",
          reason: result.reason,
        });
      } while (state.dirty);
    } catch (e) {
      await record(kind, id, {
        status: deliveryStarted ? "uncertain" : "error",
        reason:
          "AI check or delivery failed. Inspect Telegram before retrying if delivery is uncertain.",
        code: String(e.code || e.name || "Error").slice(0, 100),
      });
    } finally {
      try {
        await release?.();
      } finally {
        releaseSlot?.();
        running.delete(key);
      }
    }
  };
}
