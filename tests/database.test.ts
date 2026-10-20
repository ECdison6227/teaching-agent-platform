import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import {
  createCourse,
  getCourseBySlug,
  saveSource,
  enqueueImport,
  courseContent,
  validateFile,
} from "../src/lib/courses";
import {
  chapters,
  courses,
  jobs,
  knowledgePoints,
  pages,
  questions,
} from "../src/db/schema";
import { reviewContent } from "../src/lib/review";
import { claimJob, fallbackQuestions } from "../src/lib/importer";
import { makePdf } from "../scripts/generate-samples.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "tap-db-test-"));
process.env.DATA_DIR = dir;
process.env.MODEL_PROVIDER = "none";
after(() => {
  database().sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});
test("迁移可重复；课程、文件去重、队列领取与过期任务", () => {
  assert.equal(database().sqlite.pragma("foreign_keys", { simple: true }), 1);
  const first = createCourse({ title: "测试课程" }),
    second = createCourse({ title: "测试课程" });
  assert.equal(getCourseBySlug(encodeURIComponent(first.slug))?.id, first.id);
  assert.equal(getCourseBySlug("invalid%xx"), undefined);
  assert.notEqual(first.slug, second.slug);
  assert.throws(() => enqueueImport(first.id), /至少上传/);
  const bytes = makePdf([["Original sample"]]);
  const a = saveSource(first.id, "slides", "sample.pdf", bytes),
    duplicate = saveSource(first.id, "slides", "renamed.pdf", bytes);
  const b = saveSource(second.id, "textbook", "sample.pdf", bytes);
  assert.equal(a.id, duplicate.id);
  assert.notEqual(a.storageKey, b.storageKey);
  assert.equal(courseContent(first.id).sources.length, 1);
  const job = enqueueImport(first.id);
  assert.equal(enqueueImport(first.id).id, job.id);
  assert.throws(
    () => saveSource(first.id, "material", "sample.pdf", bytes),
    /已提交/,
  );
  assert.equal(claimJob()?.id, job.id);
  assert.equal(claimJob(), null);
  database()
    .db.update(jobs)
    .set({
      heartbeatAt: "2000-01-01T00:00:00.000Z",
      leaseExpiresAt: "2000-01-01T00:00:00.000Z",
      leaseOwner: null,
    })
    .where(eq(jobs.id, job.id))
    .run();
  claimJob();
  assert.equal(courseContent(first.id).jobs[0].status, "failed");
  assert.notEqual(enqueueImport(first.id).id, job.id);
});
test("上传验证拒绝伪装文件与可执行扩展", () => {
  assert.throws(() => validateFile("test.pdf", Buffer.from("fake")), /不符/);
  assert.throws(() => validateFile("test.exe", Buffer.from("MZ")), /仅支持/);
  assert.throws(() => validateFile("empty.pdf", Buffer.alloc(0)), /不能为空/);
});
test("规则题目抽取保留缺失答案与实际选项", () => {
  const items = fallbackQuestions(
    "Practice\nQUESTION 1. A sample?\nA. First\nB. Second\nAnswer: A\nQUESTION 2. Explain a concept.",
  );
  assert.equal(items.length, 2);
  assert.equal(items[0].type, "choice");
  assert.equal(items[0].answer, "A");
  assert.equal(items[1].answer, null);
});

test("审核页面改归属时更新 hasSlides 和题目页引用", () => {
  const course = createCourse({ title: "页面审核" });
  const source = saveSource(
    course.id,
    "slides",
    "original.pdf",
    makePdf([["Original text"]]),
  );
  const { db } = database();
  db.update(courses)
    .set({ status: "ready" })
    .where(eq(courses.id, course.id))
    .run();
  db.insert(chapters)
    .values({ id: "chapter", courseId: course.id, order: 0, title: "概念" })
    .run();
  for (const id of ["kp-a", "kp-b"])
    db.insert(knowledgePoints)
      .values({
        id,
        courseId: course.id,
        chapterId: "chapter",
        code: id,
        title: id,
        order: 0,
        keywords: [],
        hasSlides: id === "kp-a",
      })
      .run();
  db.insert(pages)
    .values({
      id: "page",
      courseId: course.id,
      sourceId: source.id,
      sourcePage: 1,
      index: 1,
      imageKey: "unused.png",
      width: 100,
      height: 100,
      rawText: "original",
      title: "original",
      kpId: "kp-a",
    })
    .run();
  db.insert(questions)
    .values({
      id: "question",
      courseId: course.id,
      code: "Q1",
      type: "short",
      prompt: "Explain",
      kpId: "kp-a",
      pageIds: ["page"],
      source: "generated",
      confidence: "low",
    })
    .run();
  reviewContent(course.id, {
    kind: "page",
    id: "page",
    kpId: "kp-b",
    title: "修订",
    points: ["要点"],
    keys: [],
  });
  const content = courseContent(course.id);
  assert.equal(
    content.knowledgePoints.find((k) => k.id === "kp-a")?.hasSlides,
    false,
  );
  assert.equal(
    content.knowledgePoints.find((k) => k.id === "kp-b")?.hasSlides,
    true,
  );
  assert.deepEqual(content.questions[0].pageIds, []);
  assert.throws(
    () =>
      reviewContent(course.id, {
        kind: "question",
        id: "question",
        answer: null,
        analysis: "",
        verified: true,
      }),
    /补全答案/,
  );
});
