import test from "node:test";
import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";
import {
  ModelScheduler,
  modelScheduler,
  providerSetting,
  retryAfterMs,
} from "../src/lib/models/scheduler";

test("Retry-After 秒数、HTTP 日期、无效与过期值", () => {
  const now = Date.parse("2026-01-01T00:00:00Z");
  assert.equal(retryAfterMs("3", now), 3000);
  assert.equal(retryAfterMs("Thu, 01 Jan 2026 00:00:05 GMT", now), 5000);
  for (const raw of [null, "invalid", "Thu, 01 Jan 2026 00:00:00 GMT"])
    assert.equal(retryAfterMs(raw, now), 0);
});

test("通道共享调度与独立覆盖配置，包括文本和视觉模型", () => {
  const cfg = {
    id: "agnes" as const,
    baseUrl: "http://scheduler.test",
    model: "text",
    key: "",
  };
  process.env.MODEL_RPM = "20";
  process.env.AGNES_RPM = "60";
  assert.equal(providerSetting(cfg, "RPM", 0), 60);
  assert.equal(
    modelScheduler(cfg),
    modelScheduler({ ...cfg, model: "vision" }),
  );
  assert.notEqual(
    modelScheduler(cfg),
    modelScheduler({ ...cfg, id: "school" }),
  );
  process.env.AGNES_RPM = "-1";
  assert.equal(providerSetting(cfg, "RPM", 0), 0);
  delete process.env.AGNES_RPM;
  delete process.env.MODEL_RPM;
});

test("429 降并发并共享冷却，成功后逐级回升；排队取消不占许可", async () => {
  const scheduler = new ModelScheduler(4, 0, 2, 10);
  const releases = await Promise.all(
    Array.from({ length: 4 }, () => scheduler.acquire()),
  );
  scheduler.rateLimited(25);
  assert.equal(scheduler.concurrency, 2);
  scheduler.rateLimited(25);
  assert.equal(scheduler.concurrency, 1);
  let started = false;
  const waiting = scheduler.acquire().then((release) => {
    started = true;
    return release;
  });
  const controller = new AbortController();
  const cancelled = scheduler.acquire(controller.signal);
  controller.abort(new Error("cancelled"));
  await assert.rejects(cancelled, /cancelled/);
  const start = Date.now();
  releases.forEach((release) => release(false));
  await delay(5);
  assert.equal(started, false);
  const release = await waiting;
  assert.ok(Date.now() - start >= 20);
  release(true);
  (await scheduler.acquire())(true);
  assert.equal(scheduler.concurrency, 2);
  await delay(12);
  (await scheduler.acquire())(true);
  (await scheduler.acquire())(true);
  assert.equal(scheduler.concurrency, 3);
});

test("RPM 将请求开始时间平滑分隔，包含并发请求", async () => {
  const scheduler = new ModelScheduler(4, 3000);
  const starts: number[] = [];
  await Promise.all(
    Array.from({ length: 4 }, async () => {
      const release = await scheduler.acquire();
      starts.push(Date.now());
      release(true);
    }),
  );
  for (let i = 1; i < starts.length; i++)
    assert.ok(starts[i] - starts[i - 1] >= 18);
});
