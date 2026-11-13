import { test } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { aiPreferences, decisionSchema, createAiRunner } from "./ai-policy.js";
function fixture(overrides = {}) {
  const target = {
    id: 1,
    ai_enabled: true,
    ai_mode: "scheduled",
    ai_revision: 0,
    opted_out: false,
  };
  const config = { enabled: true, model: "test", instructions: "test" };
  const sent = [],
    records = [];
  let releases = 0;
  const run = createAiRunner({
    load: async () => ({ ...target }),
    master: async () => ({ ...config }),
    history: async () => [],
    decide: async () => ({
      send: true,
      body: "hello",
      reason: "conditions met",
    }),
    send: async (...args) => sent.push(args),
    record: async (...args) => records.push(args),
    lock: async () => async () => {
      releases++;
    },
    ...overrides,
  });
  return { run, target, config, sent, records, releases: () => releases };
}
test("intervals accept every minute and reject invalid schedules and modes", () => {
  const schema = z.object(aiPreferences);
  assert.equal(
    schema.parse({ ai_mode: "scheduled", ai_interval_minutes: 1 })
      .ai_interval_minutes,
    1,
  );
  for (const n of [0, -1, 1.5, 10081, "1"])
    assert.equal(schema.safeParse({ ai_interval_minutes: n }).success, false);
  assert.equal(schema.safeParse({ ai_mode: "unknown" }).success, false);
  assert.equal(
    decisionSchema.safeParse({ send: true, body: " ", reason: "x" }).success,
    false,
  );
  assert.equal(
    decisionSchema.safeParse({ send: "false", body: "x", reason: "x" }).success,
    false,
  );
});
test("scheduled checks can send with no new messages for both groups and individuals", async () => {
  for (const kind of ["contact", "group"]) {
    const f = fixture();
    await f.run(kind, 1, "scheduled");
    assert.equal(f.sent.length, 1);
    assert.equal(f.sent[0][0], kind);
    assert.equal(f.records[0][2].status, "sent");
    assert.equal(f.releases(), 1);
  }
});
test("AI can skip sending and records why", async () => {
  const f = fixture({
    decide: async () => ({
      send: false,
      body: "",
      reason: "No unanswered question",
    }),
  });
  await f.run("group", 1, "scheduled");
  assert.equal(f.sent.length, 0);
  assert.equal(f.records[0][2].status, "skipped");
});
test("global pause, opt-out, disabled chat and other mode suppress evaluations", async () => {
  for (const change of ["master", "optout", "disabled", "mode"]) {
    let decisions = 0;
    const f = fixture({
      decide: async () => {
        decisions++;
      },
    });
    if (change === "master") f.config.enabled = false;
    if (change === "optout") f.target.opted_out = true;
    if (change === "disabled") f.target.ai_enabled = false;
    if (change === "mode") f.target.ai_mode = "immediate";
    await f.run("contact", 1, "scheduled");
    assert.equal(decisions, 0);
  }
});
test("configuration changes and opt-out during generation cancel sends", async () => {
  for (const change of [
    "master",
    "optout",
    "revision",
    "mode",
    "instructions",
  ]) {
    let f;
    f = fixture({
      decide: async () => {
        if (change === "master") f.config.enabled = false;
        if (change === "optout") f.target.opted_out = true;
        if (change === "revision") f.target.ai_revision++;
        if (change === "mode") f.target.ai_mode = "immediate";
        if (change === "instructions") f.config.instructions = "new policy";
        return { send: true, body: "stale", reason: "old policy" };
      },
    });
    await f.run("contact", 1, "scheduled");
    assert.equal(f.sent.length, 0, change);
  }
});
test("overlapping schedule ticks run only one decision", async () => {
  let resolve;
  const blocked = new Promise((r) => {
    resolve = r;
  });
  let decisions = 0;
  const f = fixture({
    decide: async () => {
      decisions++;
      await blocked;
      return { send: true, body: "one", reason: "x" };
    },
  });
  const first = f.run("group", 1, "scheduled");
  await f.run("group", 1, "scheduled");
  resolve();
  await first;
  assert.equal(decisions, 1);
  assert.equal(f.sent.length, 1);
});
test("new incoming message invalidates immediate draft and generates from latest history", async () => {
  let resolve, entered;
  const started = new Promise((r) => {
    entered = r;
  });
  const blocked = new Promise((r) => {
    resolve = r;
  });
  let decisions = 0;
  const f = fixture({
    decide: async () => {
      decisions++;
      if (decisions === 1) {
        entered();
        await blocked;
      }
      return { send: true, body: String(decisions), reason: "x" };
    },
  });
  f.target.ai_mode = "immediate";
  const first = f.run("contact", 1, "immediate");
  await started;
  await f.run("contact", 1, "immediate");
  resolve();
  await first;
  assert.equal(decisions, 2);
  assert.equal(f.sent.length, 1);
  assert.equal(f.sent[0][2], "2");
});
test("invalid AI output sends nothing and releases the worker for next check", async () => {
  const f = fixture({
    decide: async () => ({ send: true, body: "", reason: "bad" }),
  });
  await f.run("contact", 1, "scheduled");
  await f.run("contact", 1, "scheduled");
  assert.equal(f.sent.length, 0);
  assert.equal(f.records.length, 2);
  assert.equal(f.records[0][2].status, "error");
  assert.equal(f.releases(), 2);
});
test("uncertain delivery is distinguishable from generation failure", async () => {
  const f = fixture({
    send: async () => {
      throw new Error("timeout");
    },
  });
  await f.run("group", 1, "scheduled");
  assert.equal(f.records[0][2].status, "uncertain");
});
test("an existing database worker lock prevents duplicate evaluation", async () => {
  let evaluations = 0;
  const f = fixture({
    lock: async () => null,
    decide: async () => {
      evaluations++;
    },
  });
  await f.run("contact", 1, "scheduled");
  assert.equal(evaluations, 0);
});

test("incoming events do not turn a scheduled check into immediate reply loops", async () => {
  let enter, release;
  const entered = new Promise((r) => {
    enter = r;
  });
  const blocked = new Promise((r) => {
    release = r;
  });
  let decisions = 0;
  const f = fixture({
    decide: async () => {
      decisions++;
      enter();
      await blocked;
      return { send: false, body: "", reason: "not due" };
    },
  });
  const first = f.run("group", 1, "scheduled");
  await entered;
  await f.run("group", 1, "immediate");
  release();
  await first;
  assert.equal(decisions, 1);
});

test("shared concurrency limit leaves database connections available and processes queued chats", async () => {
  let enter, release;
  const entered = new Promise((r) => {
    enter = r;
  });
  const blocked = new Promise((r) => {
    release = r;
  });
  let decisions = 0,
    locks = 0,
    peak = 0;
  const f = fixture({
    concurrency: 2,
    lock: async () => {
      locks++;
      peak = Math.max(peak, locks);
      return async () => {
        locks--;
      };
    },
    decide: async () => {
      decisions++;
      if (decisions === 2) enter();
      await blocked;
      return { send: false, body: "", reason: "skip" };
    },
  });
  const jobs = Array.from({ length: 10 }, (_, i) =>
    f.run("contact", i + 1, "scheduled"),
  );
  await entered;
  assert.equal(locks, 2);
  assert.equal(decisions, 2);
  release();
  await Promise.all(jobs);
  assert.equal(decisions, 10);
  assert.equal(peak, 2);
  assert.equal(locks, 0);
});
