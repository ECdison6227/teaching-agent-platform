import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import http from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { and, eq } from "drizzle-orm";
import Database from "better-sqlite3";
import { database } from "../src/db";
import {
  courses,
  jobs,
  chapters,
  knowledgePoints,
  pages,
  questions,
  importItems,
} from "../src/db/schema";
import {
  createCourse,
  saveSource,
  enqueueImport,
  restartQuestionSteps,
} from "../src/lib/courses";
import { importJob } from "../src/lib/importer";
import {
  claimJob,
  JobLease,
  LeaseLostError,
  leaseOwner,
} from "../src/lib/job-lease";
import { makePdf } from "../scripts/generate-samples.mjs";

const dir = await mkdtemp(path.join(tmpdir(), "tap-lease-test-"));
process.env.DATA_DIR = dir;
process.env.MODEL_PROVIDER = "none";
after(async () => {
  database().sqlite.close();
  await rm(dir, { recursive: true, force: true });
});
const old = "2000-01-01T00:00:00.000Z";
function fixture() {
  const course = createCourse({ title: "Original lease test" });
  const source = saveSource(
    course.id,
    "slides",
    "sample.pdf",
    makePdf([["Original concept"]]),
  );
  const job = enqueueImport(course.id);
  return { course, source, job };
}
function readJob(id: string) {
  return database().db.select().from(jobs).where(eq(jobs.id, id)).get()!;
}
function claimant(courseId: string) {
  const child = spawn(
    process.execPath,
    [
      "--import",
      "tsx",
      "--input-type=module",
      "-e",
      `
    const { claimJob } = await import('./src/lib/job-lease.ts');
    const { database } = await import('./src/db/index.ts');
    database();
    process.on('message', (message) => {
      if (message === 'claim') process.send({ job: claimJob(${JSON.stringify(courseId)}) });
      if (message === 'stop') { database().sqlite.close(); process.disconnect(); }
    });
    process.send({ ready: true });
  `,
    ],
    { env: process.env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  let output = "";
  child.stdout!.on("data", (chunk) => {
    output += chunk;
  });
  child.stderr!.on("data", (chunk) => {
    output += chunk;
  });
  const exited = once(child, "exit");
  const ready = Promise.race([
    once(child, "message"),
    exited.then(() => {
      throw new Error(`Claimant exited before ready: ${output}`);
    }),
  ]);
  return {
    child,
    ready,
    async claim() {
      const message = once(child, "message");
      child.send("claim");
      return (await message)[0].job;
    },
    async close() {
      if (child.connected) child.send("stop");
      const [code] = await exited;
      assert.equal(code, 0, output);
    },
  };
}

test("两个真实进程同时争用时只有一个 owner；其他进程无法执行，存活宽限后正常退出才回收", async (t) => {
  const f = fixture();
  const first = claimant(f.course.id),
    second = claimant(f.course.id);
  t.after(async () => {
    await Promise.all([first.close(), second.close()]);
  });
  await Promise.all([first.ready, second.ready]);
  const results = await Promise.all([first.claim(), second.claim()]);
  assert.equal(results.filter(Boolean).length, 1);
  const winner = results[0] ? first : second;
  const claimed = readJob(f.job.id);
  assert.equal(JSON.parse(claimed.leaseOwner!).pid, winner.child.pid);
  assert.notEqual(claimed.leaseOwner, leaseOwner);
  await assert.rejects(importJob(f.job.id), LeaseLostError);
  database()
    .db.update(jobs)
    .set({ leaseExpiresAt: old, heartbeatAt: old })
    .where(eq(jobs.id, f.job.id))
    .run();
  assert.equal(claimJob(f.course.id), null);
  assert.equal(readJob(f.job.id).status, "running");
  assert.ok(Date.parse(readJob(f.job.id).leaseExpiresAt!) > Date.now());
  await Promise.all([first.close(), second.close()]);
  database()
    .db.update(jobs)
    .set({ leaseExpiresAt: old })
    .where(eq(jobs.id, f.job.id))
    .run();
  claimJob(f.course.id);
  assert.equal(readJob(f.job.id).status, "failed");
  assert.ok(readJob(f.job.id).finishedAt);
});

test("挂起、墙钟向前/向后跳变均立即续租；回收器先运行也不误回收本机存活 owner", (t) => {
  const f = fixture();
  const job = claimJob(f.course.id)!;
  let wall = Date.now(),
    monotonic = 100;
  t.mock.method(Date, "now", () => wall);
  const log: Record<string, unknown>[] = [];
  t.mock.method(console, "info", (line: string) => {
    log.push(JSON.parse(line));
  });
  process.env.IMPORT_LEASE_GRACE_MS = "60000";
  t.after(() => {
    delete process.env.IMPORT_LEASE_GRACE_MS;
  });
  const lease = new JobLease(job, {
    wall: () => wall,
    monotonic: () => monotonic,
  });
  for (const [wallShift, monotonicShift] of [
    [5_400_000, 100],
    [-7_200_000, 100],
    [5_400_000, 5_400_000],
  ]) {
    wall += wallShift;
    monotonic += monotonicShift;
    claimJob(f.course.id);
    assert.equal(readJob(job.id).status, "running");
    if (wallShift > 0)
      assert.equal(Date.parse(readJob(job.id).leaseExpiresAt!), wall + 60_000);
    lease.write(() => {});
    const renewed = readJob(job.id);
    assert.equal(renewed.heartbeatAt, new Date(wall).toISOString());
    assert.equal(Date.parse(renewed.leaseExpiresAt!), wall + 300_000);
    assert.equal(renewed.finishedAt, null);
  }
  assert.equal(
    log.filter((row) => row.event === "import_clock_jump").length,
    3,
  );
  assert.equal(
    log.filter((row) => row.event === "import_lease_grace").length,
    2,
  );
  assert.equal(lease.signal.aborted, false);
});

test("其他主机的同号 pid 不证明 owner 存活；旧无 owner 任务按心跳回收且限定课程", () => {
  const first = fixture(),
    second = fixture();
  claimJob(first.course.id);
  claimJob(second.course.id);
  const { db } = database();
  db.update(jobs)
    .set({
      leaseOwner: JSON.stringify({
        host: hostname() + "-other",
        pid: process.pid,
        token: "other",
      }),
      leaseExpiresAt: old,
    })
    .where(eq(jobs.id, first.job.id))
    .run();
  db.update(jobs)
    .set({ leaseOwner: null, leaseExpiresAt: null, heartbeatAt: old })
    .where(eq(jobs.id, second.job.id))
    .run();
  claimJob(first.course.id);
  assert.equal(readJob(first.job.id).status, "failed");
  assert.equal(readJob(second.job.id).status, "running");
  claimJob(second.course.id);
  assert.equal(readJob(second.job.id).status, "failed");
});

test("定向重跑拒绝活跃任务时仍保留存活 owner 的宽限", () => {
  const f = fixture();
  claimJob(f.course.id);
  database()
    .db.update(jobs)
    .set({ leaseExpiresAt: old })
    .where(eq(jobs.id, f.job.id))
    .run();
  assert.throws(
    () => restartQuestionSteps(f.course.id, "answers"),
    /活跃导入任务/,
  );
  assert.equal(readJob(f.job.id).status, "running");
  assert.ok(Date.parse(readJob(f.job.id).leaseExpiresAt!) > Date.now());
});

for (const operation of ["progress", "heartbeat", "result"] as const) {
  for (const status of ["queued", "done", "failed", "running"] as const) {
    test(`${operation} 发现 ${status === "running" ? "owner 改变" : status} 时中止，job 和课程均不写入`, () => {
      const f = fixture();
      const claimed = claimJob(f.course.id)!;
      const lease = new JobLease(claimed);
      database()
        .db.update(jobs)
        .set({
          status,
          ...(status === "running"
            ? { leaseOwner: claimed.leaseOwner + "-stolen" }
            : { finishedAt: new Date().toISOString() }),
        })
        .where(eq(jobs.id, claimed.id))
        .run();
      const before = readJob(claimed.id);
      let wrote = false;
      assert.throws(() => {
        if (operation === "progress")
          lease.progress(75, "must not appear", 123);
        else if (operation === "heartbeat") lease.renew();
        else
          lease.finish({ status: "done", progress: 100 }, () => {
            wrote = true;
          });
      }, LeaseLostError);
      assert.equal(lease.signal.aborted, true);
      assert.throws(
        () =>
          lease.write(() => {
            wrote = true;
          }),
        LeaseLostError,
      );
      assert.equal(wrote, false);
      assert.deepEqual(readJob(claimed.id), before);
    });
  }
}

for (const detection of ["heartbeat", "result"] as const) {
  test(`续跑 CLI 通过 ${detection} 检测失租并退出，不重试、不回写失败结果`, async (t) => {
    const f = fixture();
    const { db } = database();
    // A completed import with one missing answer, ready for the targeted CLI.
    db.update(jobs).set({ status: "done" }).where(eq(jobs.id, f.job.id)).run();
    db.update(courses)
      .set({ status: "ready" })
      .where(eq(courses.id, f.course.id))
      .run();
    db.insert(chapters)
      .values({
        id: `${f.course.id}-chapter`,
        courseId: f.course.id,
        order: 0,
        title: "Original concept",
      })
      .run();
    db.insert(knowledgePoints)
      .values({
        id: `${f.course.id}-kp`,
        courseId: f.course.id,
        chapterId: `${f.course.id}-chapter`,
        code: "K1",
        order: 0,
        title: "Original concept",
        keywords: [],
      })
      .run();
    db.insert(pages)
      .values({
        id: `${f.course.id}-page`,
        courseId: f.course.id,
        sourceId: f.source.id,
        sourcePage: 1,
        index: 1,
        imageKey: "unused.png",
        width: 1,
        height: 1,
        title: "Original",
        rawText: "Original",
        kpId: `${f.course.id}-kp`,
      })
      .run();
    db.insert(questions)
      .values({
        id: `${f.course.id}-question`,
        courseId: f.course.id,
        code: "Q-001",
        type: "short",
        prompt: "Explain the original concept",
        pageIds: [],
        source: "generated",
        confidence: "low",
      })
      .run();
    let calls = 0,
      closed = 0;
    const responses: (() => void)[] = [];
    const server = http.createServer(async (req, res) => {
      for await (const _chunk of req) {
        /* consume the model request */
      }
      calls++;
      const respond = () =>
        res.end(
          JSON.stringify({
            choices: [
              {
                message: {
                  content: '{"answer":"Unexpected","analysis":"Unexpected"}',
                },
              },
            ],
          }),
        );
      responses.push(respond);
      const timeout = setTimeout(respond, 4000);
      res.on("close", () => {
        clearTimeout(timeout);
        closed++;
      });
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    t.after(
      () => new Promise<void>((resolve) => server.close(() => resolve())),
    );
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const child = spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/resume-import.ts",
        f.course.id,
        "--from",
        "answers",
      ],
      {
        env: {
          ...process.env,
          MODEL_PROVIDER: "openai-compatible",
          QUESTIONS_MODEL_PROVIDER: "openai-compatible",
          QUESTIONS_MODEL: "lease-test",
          OPENAI_BASE_URL: base,
          OPENAI_CHAT_BASE_URL: base,
          OPENAI_CHAT_MODEL: "lease-test",
          OPENAI_API_KEY: "",
          OPENAI_CHAT_API_KEY: "",
          MODEL_CONCURRENCY: "4",
          IMPORT_HEARTBEAT_MS: detection === "heartbeat" ? "40" : "10000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk;
    });
    child.stderr.on("data", (chunk) => {
      output += chunk;
    });
    const exited = once(child, "exit");
    for (let n = 0; n < 300 && calls < 2 && child.exitCode === null; n++)
      await delay(10);
    assert.equal(calls, 2, output);
    const running = db
      .select()
      .from(jobs)
      .where(and(eq(jobs.courseId, f.course.id), eq(jobs.status, "running")))
      .get()!;
    // Simulate authoritative reclamation while requests are still in flight.
    db.update(jobs)
      .set({
        leaseOwner: JSON.stringify({
          host: "other-host",
          pid: process.pid,
          token: "reclaimed",
        }),
        leaseExpiresAt: old,
      })
      .where(eq(jobs.id, running.id))
      .run();
    claimJob(f.course.id);
    const reclaimed = readJob(running.id);
    const started = performance.now();
    if (detection === "result") responses.forEach((respond) => respond());
    const [code] = await exited;
    assert.equal(code, 1, output);
    assert.ok(performance.now() - started < 2000, output);
    assert.equal(calls, 2);
    assert.match(output, /\[\d{4}-\d\d-\d\dT[^\]]+\] .*中止/);
    assert.match(output, /"event":"import_step_start".*"step":"answers"/);
    assert.match(output, /"event":"import_step_end".*"status":"aborted"/);
    assert.deepEqual(readJob(running.id), reclaimed);
    assert.equal(
      db
        .select()
        .from(questions)
        .where(eq(questions.courseId, f.course.id))
        .get()!.answer,
      null,
    );
    assert.equal(
      db
        .select()
        .from(importItems)
        .where(eq(importItems.courseId, f.course.id))
        .all().length,
      0,
    );
    for (let n = 0; n < 50 && closed < 2; n++) await delay(10);
    assert.equal(closed, 2);
  });
}

test("完成和失败的最后心跳与 finishedAt 一致；后续更新不能改变终态", () => {
  for (const status of ["done", "failed"] as const) {
    const f = fixture();
    const lease = new JobLease(claimJob(f.course.id)!);
    lease.progress(80, "Final original step", 42);
    lease.finish({ status, progress: 100 }, () => {
      database()
        .db.update(courses)
        .set({ status: "ready" })
        .where(eq(courses.id, f.course.id))
        .run();
    });
    const result = readJob(f.job.id);
    assert.equal(result.heartbeatAt, result.finishedAt);
    assert.equal(result.leaseExpiresAt, null);
    assert.equal(result.costTokens, 42);
    assert.throws(() => lease.progress(10, "Late update", 0), LeaseLostError);
    assert.deepEqual(readJob(f.job.id), result);
  }
});

test("租约迁移保留旧数据库中的已有任务", async () => {
  const sqlite = new Database(":memory:");
  try {
    sqlite.exec(await readFile("drizzle/0000_black_martin_li.sql", "utf8"));
    sqlite.exec(
      "INSERT INTO courses(id,slug,title,created_at) VALUES('migration-course','migration-course','Original','now'); INSERT INTO jobs(id,course_id,status,created_at,heartbeat_at) VALUES('migration-job','migration-course','running','now','before');",
    );
    sqlite.exec(await readFile("drizzle/0004_odd_skaar.sql", "utf8"));
    assert.deepEqual(
      sqlite
        .prepare(
          "SELECT status,heartbeat_at,lease_owner,lease_expires_at FROM jobs",
        )
        .get(),
      {
        status: "running",
        heartbeat_at: "before",
        lease_owner: null,
        lease_expires_at: null,
      },
    );
  } finally {
    sqlite.close();
  }
});
