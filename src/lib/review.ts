import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { database } from "../db";
import {
  sources,
  jobs,
  knowledgePoints,
  pages,
  pageNotes,
  questions,
} from "../db/schema";
import { getCourse, HttpError } from "./courses";
import { redactPII } from "./storage";
const ReviewSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("kp"),
    id: z.string(),
    title: z.string().trim().min(1).max(200),
    contentMd: z.string().max(30000),
  }),
  z.object({
    kind: z.literal("page"),
    id: z.string(),
    kpId: z.string(),
    title: z.string().trim().min(1).max(200),
    points: z.array(z.string().trim().min(1).max(3000)).min(1).max(8),
    keys: z.array(z.string().max(100)).max(12),
  }),
  z.object({
    kind: z.literal("question"),
    id: z.string(),
    answer: z.string().max(5000).nullable(),
    analysis: z.string().max(10000),
    verified: z.boolean(),
  }),
]);
export function reviewContent(courseId: string, body: unknown) {
  const input = ReviewSchema.parse(body),
    { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      if (getCourse(courseId).status !== "ready")
        throw new HttpError(409, "请等待课程导入完成后审核");
      if (
        db
          .select()
          .from(jobs)
          .where(and(eq(jobs.courseId, courseId), eq(jobs.status, "running")))
          .get()
      )
        throw new HttpError(409, "导入中暂不能审核");
      if (input.kind === "kp") {
        const row = db
          .update(knowledgePoints)
          .set({
            title: redactPII(input.title),
            contentMd: redactPII(input.contentMd),
          })
          .where(
            and(
              eq(knowledgePoints.id, input.id),
              eq(knowledgePoints.courseId, courseId),
            ),
          )
          .returning()
          .get();
        if (!row) throw new HttpError(404, "知识点不存在");
      } else if (input.kind === "page") {
        const kp = db
          .select()
          .from(knowledgePoints)
          .where(
            and(
              eq(knowledgePoints.id, input.kpId),
              eq(knowledgePoints.courseId, courseId),
            ),
          )
          .get();
        if (!kp) throw new HttpError(400, "知识点不属于本课程");
        const page = db
          .update(pages)
          .set({ title: redactPII(input.title), kpId: kp.id })
          .where(and(eq(pages.id, input.id), eq(pages.courseId, courseId)))
          .returning()
          .get();
        if (!page) throw new HttpError(404, "页面不存在");
        db.update(pageNotes)
          .set({
            title: redactPII(input.title),
            points: input.points.map(redactPII),
            keys: input.keys.map(redactPII),
            qaStatus: "passed",
          })
          .where(eq(pageNotes.pageId, page.id))
          .run();
        // hasSlides 始终根据实际资料类型重算。
        const coursePages = db
          .select()
          .from(pages)
          .where(eq(pages.courseId, courseId))
          .all();
        const sourceRows = db
          .select()
          .from(sources)
          .where(eq(sources.courseId, courseId))
          .all();
        for (const k of db
          .select()
          .from(knowledgePoints)
          .where(eq(knowledgePoints.courseId, courseId))
          .all())
          db.update(knowledgePoints)
            .set({
              hasSlides: coursePages.some(
                (p) =>
                  p.kpId === k.id &&
                  sourceRows.some(
                    (s) => s.id === p.sourceId && s.kind === "slides",
                  ),
              ),
            })
            .where(eq(knowledgePoints.id, k.id))
            .run();
        // 题目仍归原知识点；移走的页面不能继续作为该知识点的引用。
        for (const q of db
          .select()
          .from(questions)
          .where(eq(questions.courseId, courseId))
          .all()) {
          const candidates = coursePages.filter((p) => p.kpId === q.kpId);
          const pageIds = q.pageIds.filter((id) =>
            candidates.some((p) => p.id === id),
          );
          db.update(questions)
            .set({
              pageIds: pageIds.length
                ? pageIds
                : candidates.slice(0, 1).map((p) => p.id),
            })
            .where(eq(questions.id, q.id))
            .run();
        }
      } else {
        const q = db
          .select()
          .from(questions)
          .where(
            and(eq(questions.id, input.id), eq(questions.courseId, courseId)),
          )
          .get();
        if (!q) throw new HttpError(404, "题目不存在");
        if (input.verified && q.formulaRecovery?.status === "missing")
          throw new HttpError(400, "公式缺失，请先重跑公式恢复并核对原文");
        const answer = input.answer?.trim() || null;
        if (input.verified && !answer)
          throw new HttpError(400, "补全答案后才能确认核对");
        if (
          input.verified &&
          q.type === "choice" &&
          !q.options?.some((o) => o.id.toUpperCase() === answer!.toUpperCase())
        )
          throw new HttpError(400, "答案必须是一个有效选项 ID");
        if (
          input.verified &&
          q.type === "truefalse" &&
          !["T", "F"].includes(answer!.toUpperCase())
        )
          throw new HttpError(400, "判断题答案应为 T 或 F");
        db.update(questions)
          .set({
            answer: answer ? redactPII(answer) : null,
            analysis: redactPII(input.analysis),
            verified: input.verified,
            reviewStatus: input.verified ? "teacher_ok" : "needs_review",
          })
          .where(eq(questions.id, q.id))
          .run();
      }
      return { ok: true };
    })
    .immediate();
}
