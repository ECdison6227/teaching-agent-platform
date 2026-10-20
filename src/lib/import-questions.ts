import { and, eq, asc, inArray } from "drizzle-orm";
import { database } from "../db";
import {
  importItems,
  knowledgePoints,
  pages,
  pageNotes,
  questions,
  type Question,
} from "../db/schema";
import { uid } from "./courses";
import { importWrite, type ImportHooks } from "./import-task";
import { redactPII } from "./storage";
import { formulaGapReasons, type FormulaRecovery } from "./formulas";
import { structured, ModelOutputError } from "./models/provider";
import { QuestionsSchema, QuestionAnswerSchema } from "./import-schemas";
import {
  normalizeQuestionsOutput,
  normalizeAnswerOutput,
} from "./question-normalization";
import {
  importQuestionBatch,
  importQuestionConcurrency,
  importQuestionKpThreshold,
  mapImportPages,
} from "./import-settings";
import {
  normalizeQuestion,
  questionBoundaries,
  ruleQuestion,
  type QuestionBoundary,
} from "./question-parser";

type QuestionSource = {
  sourceId: string;
  pages: { text: string }[];
  boundaries?: QuestionBoundary[];
  formulas?: Record<string, FormulaRecovery>;
};
type Context = ReturnType<typeof questionContext>;
type Hooks = ImportHooks;
type ExtractedItem = {
  data: (typeof QuestionsSchema._output.questions)[number];
  ruleBased: boolean;
};
type BatchResult = { items: ExtractedItem[]; ruleBased: boolean };
function questionContext(courseId: string) {
  const { db } = database();
  const coursePages = db
    .select()
    .from(pages)
    .where(eq(pages.courseId, courseId))
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
  return db
    .select()
    .from(knowledgePoints)
    .where(eq(knowledgePoints.courseId, courseId))
    .orderBy(asc(knowledgePoints.order))
    .all()
    .map((kp) => ({
      ...kp,
      pages: coursePages
        .filter((p) => p.kpId === kp.id)
        .map((p) => ({
          id: p.id,
          page: p.index,
          points: notes.find((n) => n.pageId === p.id)?.points || [],
        })),
    }));
}
function terms(text: string) {
  const normalized = text.toLowerCase();
  return new Set([
    ...(normalized.match(/[a-z0-9]+/g) || []),
    ...[...normalized.matchAll(/[\p{Script=Han}]{2,}/gu)].flatMap(([word]) =>
      Array.from({ length: word.length - 1 }, (_, i) => word.slice(i, i + 2)),
    ),
  ]);
}
export function questionSimilarity(question: string, reference: string) {
  const a = terms(question),
    b = terms(reference);
  return a.size ? [...a].filter((term) => b.has(term)).length / a.size : 0;
}
function references(
  prompt: string,
  context: Context,
  linkedId?: string | null,
) {
  const ranked = context
    .map((kp) => ({
      kp,
      similarity: questionSimilarity(
        prompt,
        `${kp.title} ${kp.keywords.join(" ")} ${kp.contentMd} ${kp.pages.flatMap((p) => p.points).join(" ")}`,
      ),
    }))
    .sort((a, b) => b.similarity - a.similarity);
  return (
    linkedId
      ? ranked.filter(({ kp }) => kp.id === linkedId)
      : ranked.slice(0, 5)
  ).map(({ kp, similarity }) => ({
    kpId: kp.id,
    title: kp.title,
    keywords: kp.keywords,
    similarity,
    lecture: kp.contentMd.slice(0, 5000),
    pagePoints: kp.pages
      .map(({ page, points }) => ({ page, points }))
      .slice(0, 20),
  }));
}
async function extractBatch(
  batch: QuestionBoundary[],
  courseId: string,
  context: Context,
  hooks: Hooks,
): Promise<BatchResult> {
  const numbered = batch.filter((q) => q.numbered);
  const schema = QuestionsSchema.superRefine((output, ctx) => {
    if (!numbered.length) return;
    const ids = output.questions.map((q) => q.sourceQuestionId);
    if (
      output.questions.length !== batch.length ||
      (ids.some(Boolean) &&
        (new Set(ids).size !== batch.length ||
          ids.some((id) => !batch.some((q) => q.id === id))))
    )
      ctx.addIssue({
        code: "custom",
        path: ["questions"],
        message: "必须逐题返回当前批全部题目，并保留 sourceQuestionId",
      });
  });
  const candidates = new Map(
    batch.map((q) => [q.id, references(q.text, context)]),
  );
  const referenceIndex = [
    ...new Map(
      [...candidates.values()].flat().map((r) => [r.kpId, r]),
    ).values(),
  ].map((r) => ({
    ...r,
    lecture: r.lecture.slice(0, 2000),
    pagePoints: r.pagePoints.slice(0, 4).map((p) => ({
      ...p,
      points: p.points.slice(0, 2).map((point) => point.slice(0, 400)),
    })),
  }));
  try {
    const result = await structured(
      "questions",
      schema,
      `课程 ID：${courseId}。步骤：习题抽取与知识点关联。只抽原文已有题目，不编题，本步骤不推导答案。按题目边界逐题返回，不合并、不遗漏。\n返回 {"questions":[{"sourceQuestionId":"原题id","type":"choice|truefalse|fill|calc|short","prompt":"去除题号与选项的题干","options":[{"id":"A","text":"选项"}],"answer":null,"analysis":"原文解析或空字符串","kpId":null,"kpConfidence":0,"pages":[],"sourcePage":1,"confidence":"high|mid|low"}]}。识别 A．/A./A、/（A）及行内多选项，选项只能放 options；公式保留原样或合法 LaTeX。typeHint 是大题标题提示。缺答案必须 null。判断答案 T/F。\n知识点必须根据标题、关键词、讲义、页要点与题意的相似度判断，返回候选中的 kpId 与 0–1 置信度。课程没有对应概念时 kpId=null，不能挂到宽泛或相邻主题。pages 只引用匹配知识点的真实课件页码。\n共享知识点资料：${JSON.stringify(referenceIndex)}\n原文：${JSON.stringify(batch.map((q) => ({ page: q.page, id: q.id, typeHint: q.typeHint, text: q.text, preprocessed: q.numbered ? ruleQuestion(q) : undefined, candidates: candidates.get(q.id)?.map(({ kpId, title, keywords, similarity }) => ({ kpId, title, keywords, similarity, pagePoints: referenceIndex.find((r) => r.kpId === kpId)?.pagePoints.map((p) => ({ page: p.page })) })) })))}`,
      undefined,
      {
        signal: hooks.signal,
        normalize: normalizeQuestionsOutput,
        diagnostic: {
          courseId,
          item: `extract:${batch.map((q) => q.id).join(",")}`,
        },
      },
    );
    hooks.tokens(result?.tokens || 0);
    if (result)
      return {
        ruleBased: false,
        items: result.data.questions.map((data, index) => ({
          data: {
            ...data,
            sourceQuestionId:
              data.sourceQuestionId ??
              (result.data.questions.length === batch.length
                ? batch[index].id
                : undefined),
          },
          ruleBased: false,
        })),
      };
  } catch (error) {
    hooks.signal?.throwIfAborted();
    // Splitting a throttled request would amplify upstream load.
    if (error instanceof ModelOutputError && error.status === 429) throw error;
    if (
      batch.length > 1 &&
      error instanceof ModelOutputError &&
      error.kind !== "transport"
    ) {
      const size = batch.length > 5 ? Math.ceil(batch.length / 2) : 1;
      console.info(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: "import_question_batch_split",
          courseId,
          size: batch.length,
          retrySize: size,
        }),
      );
      const recovered: BatchResult = { items: [], ruleBased: false };
      // Sequential sub-batches keep a failed batch from multiplying concurrency.
      for (let start = 0; start < batch.length; start += size) {
        const result = await extractBatch(
          batch.slice(start, start + size),
          courseId,
          context,
          hooks,
        );
        recovered.items.push(...result.items);
        recovered.ruleBased ||= result.ruleBased;
      }
      return recovered;
    }
    console.warn(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        event: "import_question_batch_fallback",
        courseId,
        error: error instanceof Error ? error.message : "模型抽取失败",
      }),
    );
  }
  return {
    ruleBased: true,
    items: batch
      .filter((q) => q.numbered)
      .map((q) => ({ data: ruleQuestion(q), ruleBased: true })),
  };
}
export function normalizeQuestionAnswer(
  question: { type: Question["type"]; options?: Question["options"] },
  answer?: string | null,
) {
  if (!answer?.trim()) return null;
  if (question.type === "choice") {
    const id = answer
      .normalize("NFKC")
      .replace(/[\s.、()]/g, "")
      .toUpperCase();
    return question.options?.some((o) => o.id === id) ? id : null;
  }
  if (question.type === "truefalse") {
    const value = answer
      .normalize("NFKC")
      .trim()
      .toLowerCase()
      .replace(/[。.!！]/g, "");
    if (["t", "true", "正确", "对", "是", "√"].includes(value)) return "T";
    if (["f", "false", "错误", "错", "否", "×"].includes(value)) return "F";
    return null;
  }
  return answer.trim();
}
async function deriveAnswer(
  question: Question,
  courseId: string,
  context: Context,
  hooks: Hooks,
) {
  let rateLimited = false;
  const material = references(question.prompt, context, question.kpId);
  const base = `课程 ID：${courseId}。步骤：答案推导（独立于抽取）。依据当前课程讲义与页要点推导原题答案。仅用配置的当前 questions 模型通道。资料不足或题目条件不全，answer=null，analysis 说明原因；不假装原文提供答案。只返回 {"answer":"最终答案或null","analysis":"供学生核对的简明解法与依据"}。choice 仅返回选项 ID，truefalse 仅返回 T/F，其他题型返回完整结果（保留单位/公式）。\n题目：${JSON.stringify({ type: question.type, prompt: question.prompt, options: question.options })}\n课程依据：${JSON.stringify(material)}`;
  const attempt = async (
    round: number,
    instruction: string,
    temperature: number,
  ) => {
    try {
      const result = await structured(
        "questions",
        QuestionAnswerSchema,
        `${base}\n推导轮次：${round}。${instruction}`,
        undefined,
        {
          signal: hooks.signal,
          temperature,
          normalize: normalizeAnswerOutput,
          diagnostic: { courseId, item: `answer:${question.id}:${round}` },
        },
      );
      hooks.tokens(result?.tokens || 0);
      if (!result) return null;
      const answer = normalizeQuestionAnswer(question, result.data.answer);
      return answer ? { answer, analysis: result.data.analysis } : null;
    } catch (error) {
      hooks.signal?.throwIfAborted();
      if (error instanceof ModelOutputError && error.status === 429)
        rateLimited = true;
      console.warn(
        JSON.stringify({
          timestamp: new Date().toISOString(),
          event: rateLimited
            ? "import_question_answer_deferred"
            : "import_question_answer_failed",
          courseId,
          questionId: question.id,
          round,
          error: error instanceof Error ? error.message : "答案推导失败",
        }),
      );
      return null;
    }
  };
  // Neither independent prompt contains the other's result.
  const [first, second] = await Promise.all([
    attempt(1, "从定义和已知条件出发，独立求解，并检查答案满足条件。", 0.1),
    attempt(2, "换一种解法或反向验算，独立求解，尤其检查干扰选项与单位。", 0.6),
  ]);
  if (rateLimited) return { pending: true as const };
  const canonical = (text: string) =>
    text.normalize("NFKC").replace(/\s+/g, "");
  if (first && second && canonical(first.answer) === canonical(second.answer))
    return {
      answer: first.answer,
      analysis: `两轮独立推导一致，待教师核对。\n\n${first.analysis}\n\n独立验算：${second.analysis}`,
      confidence: "high" as const,
      answerMethod: "consensus" as const,
    };
  if (!first && !second) return null;
  const arbitration = await attempt(
    3,
    `两轮独立推导未达成一致。逐项检查下面两份结果与课程依据，独立裁决，不做多数猜测；无法确定时返回 null。候选：${JSON.stringify([first, second])}。仲裁结果仍需人工核对。`,
    0.2,
  );
  if (rateLimited) return { pending: true as const };
  return arbitration
    ? {
        ...arbitration,
        analysis: `两轮推导不一致或不完整；第三轮仲裁，仍需人工核对。\n\n${arbitration.analysis}`,
        confidence: "low" as const,
        answerMethod: "arbitrated" as const,
      }
    : null;
}
export async function runQuestionAnswers(courseId: string, hooks: Hooks) {
  const { db } = database();
  const context = questionContext(courseId);
  const pending = db
    .select()
    .from(questions)
    .where(eq(questions.courseId, courseId))
    .all()
    .filter(
      (q) =>
        !q.answer?.trim() &&
        !q.verified &&
        q.formulaRecovery?.status !== "missing",
    );
  let throttled = false;
  await mapImportPages(
    pending,
    async (question) => {
      hooks.signal?.throwIfAborted();
      // Once this run exhausts the 429 budget, leave the remaining queue resumable.
      // In-flight independent rounds still settle before the worker finishes.
      const derived = throttled
        ? { pending: true as const }
        : await deriveAnswer(question, courseId, context, hooks);
      const deferred = !!derived && "pending" in derived;
      throttled ||= deferred;
      const result = derived && !("pending" in derived) ? derived : null;
      const status = result
        ? ("done" as const)
        : deferred
          ? ("pending" as const)
          : ("needs_review" as const);
      const message = result
        ? null
        : deferred
          ? "上游限流，答案待处理，可续跑"
          : "答案未能可靠推导，可从 answers 步骤续跑或人工补充";
      importWrite(hooks, () =>
        db.transaction((tx) => {
          if (result)
            tx.update(questions)
              .set({
                ...result,
                answer: redactPII(result.answer),
                analysis: redactPII(result.analysis),
                reviewStatus: "needs_review",
                verified: false,
              })
              .where(
                and(
                  eq(questions.courseId, courseId),
                  eq(questions.id, question.id),
                ),
              )
              .run();
          tx.insert(importItems)
            .values({
              courseId,
              key: `answers:${question.id}`,
              status,
              message,
            })
            .onConflictDoUpdate({
              target: [importItems.courseId, importItems.key],
              set: {
                status,
                message,
              },
            })
            .run();
        }),
      );
    },
    (completed) =>
      hooks.progress(
        92 + Math.round((completed / Math.max(1, pending.length)) * 4),
        `推导习题答案 ${completed}/${pending.length}`,
      ),
    Math.max(1, Math.floor(importQuestionConcurrency() / 2)),
  );
}
export async function runQuestionExtraction(
  courseId: string,
  sources: QuestionSource[],
  hooks: Hooks,
) {
  const { db } = database();
  const context = questionContext(courseId);
  const size = importQuestionBatch();
  const batches = sources.flatMap((source) => {
    const boundaries = source.boundaries || questionBoundaries(source.pages);
    const result = [];
    // Empty documents still get a durable completion marker.
    for (let start = 0; start < Math.max(1, boundaries.length); start += size)
      result.push({
        ...source,
        batch: boundaries.slice(start, start + size),
        key: `questions:v2:${source.sourceId}:${size}:${start}`,
      });
    return result;
  });
  const completed = new Set(
    db
      .select()
      .from(importItems)
      .where(eq(importItems.courseId, courseId))
      .all()
      .map((item) => item.key),
  );
  let number = db
    .select()
    .from(questions)
    .where(eq(questions.courseId, courseId))
    .all()
    .reduce(
      (max, q) => Math.max(max, Number(q.code.replace(/^Q-/, "")) || 0),
      0,
    );
  await mapImportPages(
    batches,
    async ({ sourceId, pages: sourcePages, formulas, batch, key }) => {
      hooks.signal?.throwIfAborted();
      if (completed.has(key)) return;
      const result = batch.length
        ? await extractBatch(batch, courseId, context, hooks)
        : { items: [], ruleBased: true };
      const items = result.items;
      const fallbackCount = items.filter((item) => item.ruleBased).length;
      importWrite(hooks, () =>
        db.transaction((tx) => {
          for (const [index, { data: item, ruleBased }] of items.entries()) {
            const boundary =
              batch.find((q) => q.id === item.sourceQuestionId) ||
              (items.length === batch.length ? batch[index] : undefined);
            const rules = boundary?.numbered
              ? ruleQuestion(boundary)
              : undefined;
            const recovery = boundary && formulas?.[boundary.id];
            const q = normalizeQuestion(
              {
                ...item,
                ...(recovery && rules ? { prompt: rules.prompt } : {}),
                options: rules?.options || item.options,
              },
              boundary?.typeHint,
            );
            const kp =
              item.kpConfidence >= importQuestionKpThreshold()
                ? context.find((k) => k.id === item.kpId)
                : undefined;
            const linked =
              kp?.pages.filter((p) => item.pages.includes(p.page)) || [];
            const pageIds = (
              linked.length ? linked : kp?.pages.slice(0, 1) || []
            ).map((p) => p.id);
            const sourcePage =
              boundary?.page ||
              (item.sourcePage && item.sourcePage <= sourcePages.length
                ? item.sourcePage
                : batch[0]?.page || 1);
            const prompt = redactPII(q.prompt);
            const duplicate = tx
              .select()
              .from(questions)
              .where(
                and(
                  eq(questions.courseId, courseId),
                  eq(questions.prompt, prompt),
                ),
              )
              .all()
              .some(
                (existing) =>
                  existing.source !== "generated" &&
                  existing.source.sourceId === sourceId &&
                  existing.source.page === sourcePage,
              );
            if (duplicate) continue;
            // An extraction response must not bypass independent derivation for a source without an answer.
            const answer = normalizeQuestionAnswer(
              q,
              rules ? rules.answer : item.answer,
            );
            tx.insert(questions)
              .values({
                id: uid(),
                courseId,
                code: `Q-${String(++number).padStart(3, "0")}`,
                type: q.type,
                prompt,
                options: q.options?.map((o) => ({
                  ...o,
                  text: redactPII(o.text),
                })),
                answer: answer ? redactPII(answer) : null,
                analysis: redactPII(item.analysis || ""),
                formulaRecovery:
                  recovery ||
                  (formulaGapReasons(q.prompt, q.options).length
                    ? {
                        status: "missing",
                        evidence: [],
                        reasons: formulaGapReasons(q.prompt, q.options),
                      }
                    : null),
                answerMethod: answer ? "source" : null,
                kpId: kp?.id || null,
                kpConfidence: kp ? item.kpConfidence : 0,
                pageIds,
                source: {
                  sourceId,
                  page: sourcePage,
                  questionId: boundary?.id,
                  endPage: boundary?.endPage,
                },
                confidence: ruleBased ? "low" : item.confidence,
                verified: false,
                reviewStatus: "needs_review",
              })
              .run();
          }
          tx.insert(importItems)
            .values({
              courseId,
              key,
              status: result.ruleBased ? "needs_review" : "done",
              message: result.ruleBased
                ? fallbackCount
                  ? `该批 ${fallbackCount} 题使用规则抽取，待核对`
                  : "该批习题未能抽取，待核对"
                : null,
            })
            .onConflictDoNothing()
            .run();
        }),
      );
    },
    (count) =>
      hooks.progress(
        81 + Math.round((count / Math.max(1, batches.length)) * 10),
        `抽取习题 ${count}/${batches.length} 批（每批最多 ${size} 题）`,
      ),
    importQuestionConcurrency(),
  );
}
