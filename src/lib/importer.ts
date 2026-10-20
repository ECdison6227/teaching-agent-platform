import { mkdir, readFile, writeFile, copyFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import katex from "katex";
import { and, eq, lt } from "drizzle-orm";
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
  type Source,
} from "../db/schema";
import { now, uid } from "./courses";
import { storagePath, redactPII, courseDir } from "./storage";
import { structured, resolveProviderConfig } from "./models/provider";
import {
  PageNoteSchema,
  QuestionsSchema,
  StructureSchema,
  TextbookSchema,
} from "./import-schemas";
import { z } from "zod";
import { command } from "./import-command";
import { mapImportPages } from "./import-settings";
import {
  generatePageNote,
  pageTitle,
  type PageNoteResult,
} from "./import-page-notes";

type ParsedPage = {
  text: string;
  imageKey: string;
  width: number;
  height: number;
  cachedNote?: PageNoteResult;
};
type ParsedSource = { source: Source; pages: ParsedPage[] };
function qaNote(note: z.infer<typeof PageNoteSchema>, ruleBased = false) {
  if (ruleBased) return "needs_review" as const;
  try {
    for (const text of [note.title, ...note.points])
      for (const m of text.matchAll(
        /\$\$([\s\S]+?)\$\$|(?<!\\)\$([^$\n]+?)\$/g,
      ))
        katex.renderToString(m[1] || m[2], {
          throwOnError: true,
          strict: "error",
        });
    return "passed" as const;
  } catch {
    return "needs_review" as const;
  }
}
/** 原子领取：Web 与多个 worker 使用同一个 SQLite 队列。 */
export function claimJob() {
  const { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      // 心跳每 10 秒更新；进程意外退出后，过期任务标记失败，可由界面重试。
      db.update(jobs)
        .set({
          status: "failed",
          error: "worker 心跳已过期，请重新导入",
          step: "导入中断",
          finishedAt: now(),
        })
        .where(
          and(
            eq(jobs.status, "running"),
            lt(jobs.heartbeatAt, new Date(Date.now() - 300_000).toISOString()),
          ),
        )
        .run();
      const row = db
        .select()
        .from(jobs)
        .where(eq(jobs.status, "queued"))
        .orderBy(jobs.createdAt)
        .get();
      if (!row) return null;
      return (
        db
          .update(jobs)
          .set({
            status: "running",
            startedAt: now(),
            heartbeatAt: now(),
            step: "准备导入",
            progress: 1,
          })
          .where(and(eq(jobs.id, row.id), eq(jobs.status, "queued")))
          .returning()
          .get() || null
      );
    })
    .immediate();
}
export async function runOneJob() {
  const job = claimJob();
  if (!job) return false;
  await importJob(job.id);
  return true;
}
export async function importJob(jobId: string) {
  const { db } = database();
  const job = db.select().from(jobs).where(eq(jobs.id, jobId)).get();
  if (!job || job.status !== "running")
    throw new Error("任务必须先由 worker 领取");
  const courseId = job.courseId;
  let tokens = 0;
  const progress = (value: number, step: string) =>
    db
      .update(jobs)
      .set({ progress: value, step, costTokens: tokens, heartbeatAt: now() })
      .where(eq(jobs.id, jobId))
      .run();
  const heartbeat = setInterval(
    () =>
      db
        .update(jobs)
        .set({ heartbeatAt: now() })
        .where(and(eq(jobs.id, jobId), eq(jobs.status, "running")))
        .run(),
    10_000,
  );
  heartbeat.unref();
  try {
    const course = db
      .select()
      .from(courses)
      .where(eq(courses.id, courseId))
      .get()!;
    const language = course.language?.trim() || "zh";
    const input = db
      .select()
      .from(sources)
      .where(eq(sources.courseId, courseId))
      .all();
    // 重跑替换派生内容，保留上传原件。失败课程不会发布。
    db.transaction((tx) => {
      tx.delete(pages).where(eq(pages.courseId, courseId)).run();
      tx.delete(chapters).where(eq(chapters.courseId, courseId)).run();
      tx.update(sources)
        .set({ status: "processing" })
        .where(eq(sources.courseId, courseId))
        .run();
    });
    courseDir(courseId);
    let totalPages = 0;
    const parsed: ParsedSource[] = [];
    for (let si = 0; si < input.length; si++) {
      const source = input[si],
        folderKey = `courses/${courseId}/derived/${source.id}`;
      const folder = storagePath(folderKey);
      await mkdir(folder, { recursive: true });
      progress(
        3 + Math.round((si / input.length) * 27),
        `转换资料 ${si + 1}/${input.length}：${source.filename}`,
      );
      const pdfKey = `${folderKey}/document.pdf`,
        pdf = storagePath(pdfKey);
      if (source.mime === "application/pdf")
        await copyFile(storagePath(source.storageKey), pdf);
      else {
        const profile = path.join(folder, "lo-profile");
        await command("soffice", [
          `-env:UserInstallation=${pathToFileURL(profile).href}`,
          "--headless",
          "--convert-to",
          "pdf",
          "--outdir",
          folder,
          storagePath(source.storageKey),
        ]);
        await copyFile(
          path.join(
            folder,
            path.basename(source.storageKey, path.extname(source.storageKey)) +
              ".pdf",
          ),
          pdf,
        );
        await rm(profile, { recursive: true, force: true });
      }
      const info = await command("pdfinfo", [pdf]);
      const count = Number(info.stdout.match(/^Pages:\s+(\d+)/m)?.[1]);
      if (!count) throw new Error("PDF 页数为空或不可读取");
      totalPages += count;
      if (totalPages > 500)
        throw new Error("MVP 单课程总页数上限为 500，请拆分课程资料");
      const sourcePages = await mapImportPages(
        Array.from({ length: count }, (_, i) => i + 1),
        async (i): Promise<ParsedPage> => {
          const imageKey = `${folderKey}/page-${i}.png`,
            textFile = path.join(folder, `page-${i}.txt`);
          await command("pdftoppm", [
            "-f",
            String(i),
            "-l",
            String(i),
            "-singlefile",
            "-scale-to",
            "1400",
            "-png",
            pdf,
            storagePath(imageKey).slice(0, -4),
          ]);
          await command("pdftotext", [
            "-f",
            String(i),
            "-l",
            String(i),
            "-layout",
            "-enc",
            "UTF-8",
            pdf,
            textFile,
          ]);
          let text = redactPII(
            (await readFile(textFile, "utf8")).replace(/\f/g, "").trim(),
          );
          const bytes = await readFile(storagePath(imageKey));
          const page: ParsedPage = {
            text,
            imageKey,
            width: bytes.readUInt32BE(16),
            height: bytes.readUInt32BE(20),
          };
          if (!text && resolveProviderConfig("notes", true)) {
            const result = await generatePageNote({
              text,
              language,
              image: `data:image/png;base64,${bytes.toString("base64")}`,
              transcribe: true,
            });
            tokens += result.tokens;
            text = redactPII(result.note.text || "");
            page.text = text;
            page.cachedNote = result;
          }
          await writeFile(textFile, text);
          return page;
        },
        (completed) =>
          progress(
            3 + Math.round(((si + completed / count) / input.length) * 27),
            `提取页图与文本：资料 ${si + 1}/${input.length} · ${completed}/${count} 页`,
          ),
      );
      const textKey = `${folderKey}/text.txt`;
      await writeFile(
        storagePath(textKey),
        sourcePages.map((p) => p.text).join("\n\f\n"),
      );
      db.update(sources)
        .set({ pdfKey, textKey, pages: count, status: "ready" })
        .where(eq(sources.id, source.id))
        .run();
      parsed.push({ source, pages: sourcePages });
    }
    const primary = parsed.filter((s) => s.source.kind === "slides");
    if (!primary.length)
      primary.push(...parsed.filter((s) => s.source.kind === "textbook"));
    const allPages = primary.flatMap((s) =>
      s.pages.map((p, i) => ({ ...p, source: s.source, sourcePage: i + 1 })),
    );
    if (!allPages.length) throw new Error("缺少课程 PPT 或教材页面");
    const summaries = allPages.map((p, i) => ({
      page: i + 1,
      title: p.cachedNote?.note.title || pageTitle(p.text, language),
      text: p.text.slice(0, 800),
    }));
    progress(33, "划分章节与知识点");
    const result = await structured(
      "structure",
      StructureSchema,
      `课程：${course.title}\n按页面内容划分章节和知识点，所有课内页码 1–${allPages.length} 均须归属知识点。返回 {"chapters":[{"title":"章节","summary":"概述","knowledgePoints":[{"title":"知识点","keywords":["词"],"pages":[1,2]}]}]}。教材可增加没有课件页的知识点。\n页面：${JSON.stringify(summaries).slice(0, 65000)}\n教材：${parsed
        .filter((s) => s.source.kind === "textbook")
        .flatMap((s) => s.pages.map((p) => p.text))
        .join("\n")
        .slice(0, 18000)}`,
    );
    tokens += result?.tokens || 0;
    const tree = result?.data || {
      chapters: [
        {
          title: course.title,
          summary: "规则整理，待核对",
          knowledgePoints: Array.from(
            { length: Math.ceil(allPages.length / 4) },
            (_, i) => ({
              title: summaries[i * 4].title,
              keywords: [summaries[i * 4].title],
              pages: Array.from(
                { length: Math.min(4, allPages.length - i * 4) },
                (_, j) => i * 4 + j + 1,
              ),
            }),
          ),
        },
      ],
    };
    const kps: (typeof knowledgePoints.$inferSelect & {
      pageNumbers: number[];
    })[] = [];
    const pageToKp = new Map<number, string>();
    db.transaction((tx) => {
      for (const [ci, chapter] of tree.chapters.entries()) {
        const chapterId = uid();
        tx.insert(chapters)
          .values({
            id: chapterId,
            courseId,
            order: ci,
            title: redactPII(chapter.title),
            summary: redactPII(chapter.summary || ""),
          })
          .run();
        for (const kp of chapter.knowledgePoints) {
          const pageNumbers = [
            ...new Set(
              kp.pages.filter(
                (n) => n >= 1 && n <= allPages.length && !pageToKp.has(n),
              ),
            ),
          ];
          const row = {
            id: uid(),
            courseId,
            chapterId,
            code: `K${kps.length + 1}`,
            order: kps.length,
            title: redactPII(kp.title),
            keywords: kp.keywords.map(redactPII),
            contentMd: "",
            hasSlides: pageNumbers.some(
              (n) => allPages[n - 1].source.kind === "slides",
            ),
          };
          tx.insert(knowledgePoints).values(row).run();
          for (const n of pageNumbers) pageToKp.set(n, row.id);
          kps.push({ ...row, pageNumbers });
        }
      }
      // LLM 遗漏页也有确定归属，避免孤立页面。
      for (let n = 1; n <= allPages.length; n++)
        if (!pageToKp.has(n)) {
          pageToKp.set(n, kps[0].id);
          kps[0].pageNumbers.push(n);
        }
      if (
        allPages.some(
          (p, i) =>
            p.source.kind === "slides" && pageToKp.get(i + 1) === kps[0].id,
        )
      ) {
        kps[0].hasSlides = true;
        tx.update(knowledgePoints)
          .set({ hasSlides: true })
          .where(eq(knowledgePoints.id, kps[0].id))
          .run();
      }
    });
    progress(36, `整理逐页要点 0/${allPages.length}`);
    const persistedPages = await mapImportPages(
      allPages,
      async (page, i) => {
        let result = page.cachedNote;
        if (!result) {
          const image = resolveProviderConfig("notes", true)
            ? `data:image/png;base64,${(await readFile(storagePath(page.imageKey))).toString("base64")}`
            : undefined;
          result = await generatePageNote({ text: page.text, language, image });
          tokens += result.tokens;
        }
        const { note, model, ruleBased } = result;
        const row = db
          .insert(pages)
          .values({
            id: uid(),
            courseId,
            sourceId: page.source.id,
            sourcePage: page.sourcePage,
            index: i + 1,
            imageKey: page.imageKey,
            width: page.width,
            height: page.height,
            rawText: page.text,
            title: redactPII(note.title),
            kpId: pageToKp.get(i + 1)!,
          })
          .returning()
          .get();
        db.insert(pageNotes)
          .values({
            pageId: row.id,
            title: row.title,
            points: note.points.map(redactPII),
            keys: note.keys.map(redactPII),
            model,
            qaStatus: qaNote(note, ruleBased),
          })
          .run();
        return row;
      },
      (completed) =>
        progress(
          36 + Math.round((completed / allPages.length) * 29),
          `整理逐页要点 ${completed}/${allPages.length}`,
        ),
    );
    const textbookPages = parsed
      .filter((s) => s.source.kind === "textbook")
      .flatMap((s) => s.pages);
    for (const [i, kp] of kps.entries()) {
      progress(
        67 + Math.round((i / kps.length) * 13),
        `整理知识点讲义 ${i + 1}/${kps.length}`,
      );
      const selected = textbookPages.filter((p) =>
        [kp.title, ...kp.keywords].some((k) =>
          p.text.toLowerCase().includes(k.toLowerCase()),
        ),
      );
      const reference = (
        selected.length
          ? selected
          : textbookPages.length
            ? textbookPages
            : allPages.filter((_, pi) => pageToKp.get(pi + 1) === kp.id)
      )
        .map((p) => p.text)
        .join("\n")
        .slice(0, 40000);
      const content = await structured(
        "textbook",
        TextbookSchema,
        `知识点 ${kp.code} ${kp.title}。依据下列教材/页面整理讲义，引用具体定义和例子；无资料时明确说明。返回 {"content_md":"Markdown 讲义"}。\n资料：\n${reference}`,
      );
      tokens += content?.tokens || 0;
      db.update(knowledgePoints)
        .set({
          contentMd: redactPII(
            content?.data.content_md ||
              `## ${kp.title}\n\n> 规则整理，待核对。\n\n${reference || "请结合页图学习此知识点。"}`,
          ),
        })
        .where(eq(knowledgePoints.id, kp.id))
        .run();
    }
    const questionSources = parsed.filter(
      (s) => s.source.kind === "question_bank",
    );
    let questionNumber = 0;
    for (const [qi, source] of questionSources.entries()) {
      // 分批抽取，避免长题库静默截断。
      for (let start = 0; start < source.pages.length; start += 6) {
        progress(
          81 + Math.round((qi / Math.max(1, questionSources.length)) * 13),
          `抽取习题：资料 ${qi + 1} · ${start + 1} 页起`,
        );
        const chunk = source.pages.slice(start, start + 6);
        const extracted = await structured(
          "questions",
          QuestionsSchema,
          `只抽取原文已有习题，不编题、不推导缺失答案。返回 {"questions":[{"type":"choice|truefalse|fill|short","prompt":"题干","options":[{"id":"A","text":"选项"}],"answer":null,"analysis":"原文解析","kpCode":"K1","pages":[1],"sourcePage":1,"confidence":"high|mid|low"}]}。options 仅选择题。answer 缺失必须 null；判断题答案用 T/F。pages 指课件页码；sourcePage 为原资料页码。知识点索引：${JSON.stringify(kps.map((k) => ({ code: k.code, title: k.title, pages: k.pageNumbers })))}\n原文：${JSON.stringify(chunk.map((p, i) => ({ page: start + i + 1, text: p.text.slice(0, 12000) })))}`,
        );
        tokens += extracted?.tokens || 0;
        const items =
          extracted?.data.questions ||
          fallbackQuestions(chunk.map((p) => p.text).join("\n"));
        for (const q of items) {
          const kp =
            kps.find((k) => k.code === q.kpCode) ||
            kps.find((k) =>
              k.keywords.some((word) => q.prompt.includes(word)),
            ) ||
            kps[0];
          let linked = persistedPages.filter(
            (p) => p.kpId === kp.id && q.pages.includes(p.index),
          );
          if (!linked.length)
            linked = persistedPages.filter((p) => p.kpId === kp.id).slice(0, 1);
          let answer = q.answer?.trim() || null;
          if (
            q.type === "choice" &&
            answer &&
            !q.options?.some(
              (o) => o.id.toUpperCase() === answer!.toUpperCase(),
            )
          )
            answer = null;
          if (
            q.type === "truefalse" &&
            answer &&
            !["T", "F"].includes(answer.toUpperCase())
          )
            answer = null;
          db.insert(questions)
            .values({
              id: uid(),
              courseId,
              code: `Q-${String(++questionNumber).padStart(3, "0")}`,
              type: q.type,
              prompt: redactPII(q.prompt),
              options: q.options?.map((o) => ({
                ...o,
                text: redactPII(o.text),
              })),
              answer: answer ? redactPII(answer) : null,
              analysis: redactPII(q.analysis || ""),
              kpId: kp.id,
              pageIds: linked.map((p) => p.id),
              source: {
                sourceId: source.source.id,
                page:
                  q.sourcePage && q.sourcePage <= source.pages.length
                    ? q.sourcePage
                    : start + 1,
              },
              confidence: extracted ? q.confidence : "low",
              verified: false,
              reviewStatus: "needs_review",
            })
            .run();
        }
      }
    }
    progress(97, "检查课程完整性");
    if (persistedPages.length !== allPages.length || !kps.length)
      throw new Error("课程完整性检查失败");
    db.transaction((tx) => {
      tx.update(courses)
        .set({ status: "ready" })
        .where(eq(courses.id, courseId))
        .run();
      tx.update(jobs)
        .set({
          status: "done",
          progress: 100,
          step: "导入完成",
          costTokens: tokens,
          finishedAt: now(),
          heartbeatAt: now(),
          error: null,
        })
        .where(eq(jobs.id, jobId))
        .run();
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? redactPII(error.message).slice(0, 600)
        : "导入失败";
    db.update(jobs)
      .set({
        status: "failed",
        step: "导入失败，可重新导入",
        error: message,
        costTokens: tokens,
        finishedAt: now(),
      })
      .where(eq(jobs.id, jobId))
      .run();
    db.update(sources)
      .set({ status: "failed" })
      .where(
        and(eq(sources.courseId, courseId), eq(sources.status, "processing")),
      )
      .run();
    console.error(`Import ${jobId}: ${message}`);
  } finally {
    clearInterval(heartbeat);
  }
}

/** 无模型时仅按题号/QUESTION 分段抽原文，保留缺失答案，绝不伪造模型结果。 */
export function fallbackQuestions(
  text: string,
): z.infer<typeof QuestionsSchema>["questions"] {
  return text
    .split(/(?=^\s*(?:\d+[.、)]|Q\d+[.:]|QUESTION\s+\d+))/gim)
    .map((s) => s.trim())
    .filter((s) => /^(?:\d+[.、)]|Q\d+[.:]|QUESTION\s+\d+)/i.test(s))
    .slice(0, 200)
    .map((raw) => {
      const answer =
        raw.match(/(?:答案|Answer)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim() || null;
      const prompt = raw.replace(/(?:答案|Answer)\s*[:：][\s\S]*/i, "").trim();
      const options = [...prompt.matchAll(/^\s*([A-D])[.、)]\s*(.+)$/gm)].map(
        (m) => ({ id: m[1], text: m[2] }),
      );
      return {
        type:
          options.length >= 2
            ? "choice"
            : /_{2,}/.test(prompt)
              ? "fill"
              : /true\s*\/\s*false|判断/i.test(prompt)
                ? "truefalse"
                : "short",
        prompt,
        options: options.length >= 2 ? options : undefined,
        answer,
        confidence: "low",
        pages: [],
      };
    });
}
