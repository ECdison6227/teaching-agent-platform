import { ulid } from "ulid";
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { and, asc, desc, eq, inArray, like, or } from "drizzle-orm";
import { z } from "zod";
import { database } from "../db";
import {
  courses,
  sources,
  chapters,
  knowledgePoints,
  pages,
  pageNotes,
  questions,
  jobs,
  importItems,
} from "../db/schema";
import { courseDir, redactPII, storagePath } from "./storage";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}
export const uid = () => ulid();
export const now = () => new Date().toISOString();
export const CourseInput = z.object({
  title: z.string().trim().min(1).max(120),
  subject: z.string().trim().max(100).default(""),
  institution: z.string().trim().max(100).optional(),
  persona: z.string().trim().max(2000).optional(),
});
export function createCourse(input: unknown) {
  const data = CourseInput.parse(input);
  const id = uid();
  const slug = `${
    data.title
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, "-")
      .replace(/^-|-$/g, "")
      .slice(0, 50) || "course"
  }-${id.slice(-8)}`;
  return database()
    .db.insert(courses)
    .values({
      ...data,
      title: redactPII(data.title),
      id,
      slug,
      createdAt: now(),
    })
    .returning()
    .get();
}
export function listCourses() {
  return database()
    .db.select()
    .from(courses)
    .orderBy(desc(courses.createdAt))
    .all();
}
export function getCourse(id: string) {
  const result = database()
    .db.select()
    .from(courses)
    .where(eq(courses.id, id))
    .get();
  if (!result) throw new HttpError(404, "课程不存在");
  return result;
}
export function getCourseBySlug(slug: string) {
  // Next 的请求入口可能传入百分号编码后的路由参数，中文名称统一解码一次。
  try {
    return database()
      .db.select()
      .from(courses)
      .where(eq(courses.slug, decodeURIComponent(slug)))
      .get();
  } catch (error) {
    if (error instanceof URIError) return undefined;
    throw error;
  }
}
export function courseContent(id: string) {
  const course = getCourse(id),
    { db } = database();
  const coursePages = db
    .select()
    .from(pages)
    .where(eq(pages.courseId, id))
    .orderBy(asc(pages.index))
    .all();
  const notes = coursePages.length
    ? db
        .select()
        .from(pageNotes)
        .where(
          inArray(
            pageNotes.pageId,
            coursePages.map((p) => p.id),
          ),
        )
        .all()
    : [];
  return {
    course,
    sources: db.select().from(sources).where(eq(sources.courseId, id)).all(),
    chapters: db
      .select()
      .from(chapters)
      .where(eq(chapters.courseId, id))
      .orderBy(asc(chapters.order))
      .all(),
    knowledgePoints: db
      .select()
      .from(knowledgePoints)
      .where(eq(knowledgePoints.courseId, id))
      .orderBy(asc(knowledgePoints.order))
      .all(),
    pages: coursePages.map((p) => ({
      ...p,
      note: notes.find((n) => n.pageId === p.id) || null,
    })),
    questions: db
      .select()
      .from(questions)
      .where(eq(questions.courseId, id))
      .all(),
    importItems: db
      .select()
      .from(importItems)
      .where(eq(importItems.courseId, id))
      .all(),
    jobs: db
      .select()
      .from(jobs)
      .where(eq(jobs.courseId, id))
      .orderBy(desc(jobs.createdAt))
      .all(),
  };
}
export type CourseContent = ReturnType<typeof courseContent>;
export const SourceKind = z.enum([
  "slides",
  "textbook",
  "question_bank",
  "material",
]);
const formats: Record<string, string> = {
  ".pdf": "application/pdf",
  ".ppt": "application/vnd.ms-powerpoint",
  ".pptx":
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".doc": "application/msword",
  ".docx":
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".odp": "application/vnd.oasis.opendocument.presentation",
};
export const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
export function validateFile(filename: string, bytes: Buffer) {
  const ext = path.extname(filename).toLowerCase();
  if (!formats[ext])
    throw new HttpError(400, "仅支持 PDF、PPT/PPTX、DOC/DOCX、ODP");
  if (!bytes.length || bytes.length > MAX_UPLOAD_BYTES)
    throw new HttpError(400, "文件不能为空，且不能超过 200 MB");
  const magic =
    ext === ".pdf"
      ? bytes.subarray(0, 5).toString() === "%PDF-"
      : [".pptx", ".docx", ".odp"].includes(ext)
        ? bytes[0] === 0x50 && bytes[1] === 0x4b
        : bytes.subarray(0, 8).equals(Buffer.from("d0cf11e0a1b11ae1", "hex"));
  if (!magic) throw new HttpError(400, "文件内容与扩展名不符");
  return { ext, mime: formats[ext] };
}
function activeJob(courseId: string) {
  return database()
    .db.select()
    .from(jobs)
    .where(
      and(
        eq(jobs.courseId, courseId),
        inArray(jobs.status, ["queued", "running"]),
      ),
    )
    .get();
}
export function saveSource(
  courseId: string,
  kind: unknown,
  filename: string,
  bytes: Buffer,
) {
  const parsedKind = SourceKind.parse(kind),
    { ext, mime } = validateFile(filename, bytes);
  const { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      const course = getCourse(courseId);
      if (course.status === "ready" || activeJob(courseId))
        throw new HttpError(
          409,
          "课程已提交，请等待导入完成；新资料请新建课程",
        );
      const sha256 = createHash("sha256").update(bytes).digest("hex");
      const duplicate = db
        .select()
        .from(sources)
        .where(
          and(
            eq(sources.courseId, courseId),
            eq(sources.kind, parsedKind),
            eq(sources.sha256, sha256),
          ),
        )
        .get();
      if (duplicate) return duplicate;
      if (
        db.select().from(sources).where(eq(sources.courseId, courseId)).all()
          .length >= 12
      )
        throw new HttpError(400, "单课程最多上传 12 个文件");
      courseDir(courseId);
      const id = uid(),
        storageKey = `courses/${courseId}/sources/${id}${ext}`;
      mkdirSync(path.dirname(storagePath(storageKey)), { recursive: true });
      writeFileSync(storagePath(storageKey), bytes);
      return db
        .insert(sources)
        .values({
          id,
          courseId,
          kind: parsedKind,
          filename: redactPII(path.basename(filename)).slice(0, 200),
          mime,
          sha256,
          storageKey,
        })
        .returning()
        .get();
    })
    .immediate();
}
export function enqueueImport(courseId: string) {
  const { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      getCourse(courseId);
      const active = activeJob(courseId);
      if (active) return active;
      const input = db
        .select()
        .from(sources)
        .where(eq(sources.courseId, courseId))
        .all();
      if (!input.some((s) => s.kind === "slides" || s.kind === "textbook"))
        throw new HttpError(400, "至少上传一份课程 PPT 或教材（也可用 PDF）");
      db.update(courses)
        .set({ status: "importing" })
        .where(eq(courses.id, courseId))
        .run();
      const previous = db
        .select()
        .from(jobs)
        .where(eq(jobs.courseId, courseId))
        .orderBy(desc(jobs.createdAt))
        .get();
      const deferredAnswers =
        previous?.status === "done" &&
        db
          .select()
          .from(importItems)
          .where(
            and(
              eq(importItems.courseId, courseId),
              eq(importItems.status, "pending"),
              like(importItems.key, "answers:%"),
            ),
          )
          .get();
      return db
        .insert(jobs)
        .values({
          id: uid(),
          courseId,
          createdAt: now(),
          type:
            previous?.status === "failed"
              ? previous.type
              : deferredAnswers
                ? "import:answers"
                : "import",
        })
        .returning()
        .get();
    })
    .immediate();
}

/** Atomically reset only automatic question data and claim the targeted job.
 * A live worker never sees an unclaimed reset job; no process is stopped. */
export function restartQuestionSteps(
  courseId: string,
  from: "questions" | "answers" | "formulas",
) {
  const { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      getCourse(courseId);
      if (activeJob(courseId))
        throw new HttpError(
          409,
          "课程已有活跃导入任务，请在任务完成后重跑习题；未修改任何内容",
        );
      if (
        !db.select().from(pages).where(eq(pages.courseId, courseId)).get() ||
        !db
          .select()
          .from(knowledgePoints)
          .where(eq(knowledgePoints.courseId, courseId))
          .get()
      )
        throw new HttpError(400, "请先完成课程页面与知识点导入");
      if (from === "questions") {
        for (const q of db
          .select()
          .from(questions)
          .where(eq(questions.courseId, courseId))
          .all()) {
          if (q.source === "generated") continue;
          db.delete(questions)
            .where(
              and(eq(questions.courseId, courseId), eq(questions.id, q.id)),
            )
            .run();
        }
        db.delete(importItems)
          .where(
            and(
              eq(importItems.courseId, courseId),
              or(
                like(importItems.key, "questions:%"),
                like(importItems.key, "answers:%"),
                like(importItems.key, "formulas:%"),
              ),
            ),
          )
          .run();
      }
      db.update(courses)
        .set({ status: "importing" })
        .where(eq(courses.id, courseId))
        .run();
      return db
        .insert(jobs)
        .values({
          id: uid(),
          courseId,
          type: `import:${from}`,
          status: "running",
          createdAt: now(),
          startedAt: now(),
          heartbeatAt: now(),
          step:
            from === "questions"
              ? "重抽习题"
              : from === "formulas"
                ? "重跑公式恢复"
                : "续跑答案推导",
          progress: 1,
        })
        .returning()
        .get();
    })
    .immediate();
}
