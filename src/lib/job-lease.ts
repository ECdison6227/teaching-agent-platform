import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import { and, eq, isNull } from "drizzle-orm";
import { database } from "../db";
import { courses, jobs, type Job } from "../db/schema";

const localHost = hostname();
// Never infer ownership from a database read: the token belongs to this process.
export const leaseOwner = JSON.stringify({
  host: localHost,
  pid: process.pid,
  token: randomUUID(),
});
function setting(name: string, fallback: number) {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0 && value <= 2_147_483_647
    ? value
    : fallback;
}
const leaseMs = () => setting("IMPORT_LEASE_MS", 300_000);
const heartbeatMs = () =>
  Math.min(
    setting("IMPORT_HEARTBEAT_MS", 10_000),
    Math.max(1, Math.floor(leaseMs() / 3)),
  );
const iso = (time: number) => new Date(time).toISOString();
export function leaseFields(time = Date.now()) {
  return {
    leaseOwner,
    heartbeatAt: iso(time),
    leaseExpiresAt: iso(time + leaseMs()),
  };
}
export function leaseLog(event: string, fields: Record<string, unknown>) {
  console.info(
    JSON.stringify({ timestamp: new Date().toISOString(), event, ...fields }),
  );
}
function localOwnerAlive(owner: string | null) {
  if (!owner) return false;
  try {
    const value = JSON.parse(owner);
    if (
      value.host !== localHost ||
      !Number.isSafeInteger(value.pid) ||
      value.pid <= 0 ||
      typeof value.token !== "string" ||
      !value.token
    )
      return false;
    try {
      process.kill(value.pid, 0);
      return true;
    } catch (error) {
      // EPERM (or an unknown probe error) does not prove that a process is dead.
      return (error as NodeJS.ErrnoException).code !== "ESRCH";
    }
  } catch {
    return false;
  }
}
function owned(job: Pick<Job, "id" | "courseId" | "leaseOwner">) {
  return and(
    eq(jobs.id, job.id),
    eq(jobs.courseId, job.courseId),
    eq(jobs.status, "running"),
    job.leaseOwner === null
      ? isNull(jobs.leaseOwner)
      : eq(jobs.leaseOwner, job.leaseOwner),
  );
}
/** Call only while holding an immediate transaction. */
export function reapExpiredJobs(courseId?: string) {
  const { db } = database();
  const time = Date.now();
  const running = db
    .select()
    .from(jobs)
    .where(
      and(
        eq(jobs.status, "running"),
        courseId ? eq(jobs.courseId, courseId) : undefined,
      ),
    )
    .all();
  for (const job of running) {
    // Legacy jobs have no owner/expiry; retain the previous heartbeat timeout.
    const expiry = job.leaseExpiresAt
      ? Date.parse(job.leaseExpiresAt)
      : Date.parse(job.heartbeatAt || job.startedAt || job.createdAt) +
        leaseMs();
    if (expiry > time) continue;
    if (localOwnerAlive(job.leaseOwner)) {
      db.update(jobs)
        .set({
          leaseExpiresAt: iso(time + setting("IMPORT_LEASE_GRACE_MS", 300_000)),
        })
        .where(owned(job))
        .run();
      leaseLog("import_lease_grace", { jobId: job.id, courseId: job.courseId });
      continue;
    }
    const result = db
      .update(jobs)
      .set({
        status: "failed",
        step: "导入中断",
        error: "worker 租约已过期且无法确认存活，可从失败处继续",
        finishedAt: iso(time),
        leaseExpiresAt: null,
      })
      .where(owned(job))
      .run();
    if (result.changes) {
      db.update(courses)
        .set({ status: "failed" })
        .where(eq(courses.id, job.courseId))
        .run();
      leaseLog("import_lease_reaped", {
        jobId: job.id,
        courseId: job.courseId,
      });
    }
  }
}
/** Web and workers serialize reclamation and claiming through SQLite. */
export function claimJob(courseId?: string) {
  const { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      reapExpiredJobs(courseId);
      const row = db
        .select()
        .from(jobs)
        .where(
          and(
            eq(jobs.status, "queued"),
            courseId ? eq(jobs.courseId, courseId) : undefined,
          ),
        )
        .orderBy(jobs.createdAt)
        .get();
      if (!row) return null;
      return (
        db
          .update(jobs)
          .set({
            status: "running",
            startedAt: iso(Date.now()),
            ...leaseFields(),
            step: "准备导入",
            progress: 1,
          })
          .where(
            and(
              eq(jobs.id, row.id),
              eq(jobs.courseId, row.courseId),
              eq(jobs.status, "queued"),
            ),
          )
          .returning()
          .get() || null
      );
    })
    .immediate();
}

export class LeaseLostError extends Error {
  constructor(jobId: string, reason = "任务已被回收或租约归属已改变") {
    super(`任务 ${jobId} 中止：${reason}`);
    this.name = "LeaseLostError";
  }
}
type Clock = { wall: () => number; monotonic: () => number };
export class JobLease {
  private controller = new AbortController();
  readonly signal = this.controller.signal;
  private timer?: ReturnType<typeof setInterval>;
  private lastWall: number;
  private lastMonotonic: number;
  constructor(
    readonly job: Job,
    private clock: Clock = {
      wall: Date.now,
      monotonic: () => performance.now(),
    },
  ) {
    this.lastWall = clock.wall();
    this.lastMonotonic = clock.monotonic();
    if (job.leaseOwner !== leaseOwner || job.status !== "running") this.lose();
  }
  private lose(reason?: string): never {
    if (!this.signal.aborted) {
      const error = new LeaseLostError(this.job.id, reason);
      this.controller.abort(error);
      leaseLog("import_lease_lost", {
        jobId: this.job.id,
        courseId: this.job.courseId,
        reason: error.message,
      });
    }
    throw this.signal.reason;
  }
  private checkClock() {
    const wall = this.clock.wall(),
      monotonic = this.clock.monotonic();
    const wallElapsed = wall - this.lastWall,
      elapsed = monotonic - this.lastMonotonic;
    this.lastWall = wall;
    this.lastMonotonic = monotonic;
    if (
      Math.abs(wallElapsed - elapsed) >=
        setting("IMPORT_CLOCK_JUMP_MS", 30_000) ||
      elapsed >= heartbeatMs() * 2
    ) {
      leaseLog("import_clock_jump", {
        jobId: this.job.id,
        courseId: this.job.courseId,
        wallElapsedMs: wallElapsed,
        monotonicElapsedMs: elapsed,
      });
      return true;
    }
    return false;
  }
  private update(values: Partial<typeof jobs.$inferInsert>) {
    this.signal.throwIfAborted();
    const result = database()
      .db.update(jobs)
      .set(values)
      .where(owned(this.job))
      .run();
    if (!result.changes) this.lose();
  }
  renew = () => {
    this.checkClock();
    this.update(leaseFields(this.clock.wall()));
  };
  progress = (progress: number, step: string, costTokens: number) => {
    this.checkClock();
    this.update({
      progress,
      step,
      costTokens,
      ...leaseFields(this.clock.wall()),
    });
  };
  start() {
    this.renew();
    this.timer = setInterval(() => {
      try {
        this.renew();
      } catch (error) {
        if (!this.signal.aborted) {
          try {
            this.lose(
              `续租失败：${error instanceof Error ? error.message : "数据库错误"}`,
            );
          } catch {
            /* signal carries the failure */
          }
        }
        this.stop();
      }
    }, heartbeatMs());
    this.timer.unref();
  }
  stop() {
    clearInterval(this.timer);
  }
  /** Fence all result/checkpoint writes in an immediate transaction, including helpers. */
  write = <T>(work: () => T): T => {
    this.signal.throwIfAborted();
    const { db, sqlite } = database();
    return sqlite
      .transaction(() => {
        if (this.checkClock()) this.update(leaseFields(this.clock.wall()));
        if (!db.select({ id: jobs.id }).from(jobs).where(owned(this.job)).get())
          this.lose();
        return work();
      })
      .immediate();
  };
  finish(values: Partial<typeof jobs.$inferInsert>, work: () => void) {
    this.write(() => {
      const finishedAt = iso(this.clock.wall());
      this.update({
        ...values,
        heartbeatAt: finishedAt,
        finishedAt,
        leaseExpiresAt: null,
      });
      work();
    });
  }
  async step<T>(step: string, work: () => Promise<T>): Promise<T> {
    this.write(() => {});
    const started = this.clock.monotonic();
    const fields = { jobId: this.job.id, courseId: this.job.courseId, step };
    leaseLog("import_step_start", fields);
    let status = "failed";
    try {
      const result = await work();
      this.write(() => {});
      status = "done";
      return result;
    } finally {
      leaseLog("import_step_end", {
        ...fields,
        status: this.signal.aborted ? "aborted" : status,
        elapsedMs: Math.round(this.clock.monotonic() - started),
      });
    }
  }
}
