import "./env";
import {
  enqueueImport,
  getCourse,
  restartQuestionSteps,
} from "../src/lib/courses";
import { claimJob, importJob } from "../src/lib/importer";
import { database } from "../src/db";
import { jobs } from "../src/db/schema";
import { and, eq } from "drizzle-orm";

async function main() {
  const courseId = process.argv[2];
  const args = process.argv.slice(3);
  const from =
    args.length === 2 &&
    args[0] === "--from" &&
    ["questions", "answers", "formulas"].includes(args[1])
      ? (args[1] as "questions" | "answers" | "formulas")
      : undefined;
  if (!courseId || (args.length && !from))
    throw new Error(
      "用法：npm run import:resume -- <courseId> [--from questions|answers|formulas]",
    );
  const course = getCourse(courseId);
  if (!from && course.status === "ready") {
    console.log(`课程 ${courseId} 已完成，无需续跑。`);
    return;
  }
  // Reap expired leases without touching a live worker, then claim only this course.
  const expiredOrQueued = from
    ? restartQuestionSteps(courseId, from)
    : claimJob(courseId);
  const job = expiredOrQueued || enqueueImport(courseId);
  if (!expiredOrQueued && job.status === "running") {
    console.log(`课程已有运行任务 ${job.id}，由现有 worker 继续处理。`);
    return;
  }
  const claimed = expiredOrQueued || claimJob(courseId);
  if (!claimed) {
    console.log(`任务 ${job.id} 已交给其他 worker。`);
    return;
  }
  await importJob(claimed.id);
  const result = database()
    .db.select()
    .from(jobs)
    .where(and(eq(jobs.id, claimed.id), eq(jobs.courseId, courseId)))
    .get()!;
  console.log(`任务 ${result.id}：${result.status} · ${result.step}`);
  if (result.status === "failed") {
    console.error(result.error);
    process.exitCode = 1;
  }
}
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
