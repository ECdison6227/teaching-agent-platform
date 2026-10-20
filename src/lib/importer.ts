import {
  mkdir,
  readFile,
  writeFile,
  copyFile,
  rm,
  access,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import katex from "katex";
import { and, eq, lt, asc } from "drizzle-orm";
import { database } from "../db";
import {
  courses,
  sources,
  chapters,
  knowledgePoints,
  pages,
  pageNotes,
  jobs,
  importItems,
  type Source,
} from "../db/schema";
import { now, uid } from "./courses";
import { storagePath, redactPII, courseDir } from "./storage";
import {
  structured,
  resolveProviderConfig,
  type ModelTask,
  type ModelMetrics,
} from "./models/provider";
import { PageNoteSchema, TextbookSchema } from "./import-schemas";
import { z } from "zod";
import { runQuestionExtraction, runQuestionAnswers } from "./import-questions";
import { runFormulaStep } from "./import-formulas";
import { questionBoundaries, ruleQuestion } from "./question-parser";
import { command } from "./import-command";
import { mapImportPages, importPageConcurrency } from "./import-settings";
import { generatePageNote, pageTitle } from "./import-page-notes";

import { cachePage, readCachedPage, type ParsedPage } from "./import-cache";
import {
  knowledgePointRange,
  fallbackKnowledgePointTitle,
  structurePrompt,
  structureSchema,
} from "./import-structure";

async function optionalModel<S extends z.ZodTypeAny>(
  task: ModelTask,
  schema: S,
  input: string,
) {
  try {
    return await structured(task, schema, input);
  } catch (error) {
    console.warn(
      JSON.stringify({
        event: "import_model_fallback",
        task,
        error: error instanceof Error ? error.message : "模型返回无效内容",
      }),
    );
    return null;
  }
}
function logPage(
  jobId: string,
  courseId: string,
  sourceId: string,
  page: number,
  phase: string,
  started: number,
  metrics?: ModelMetrics,
  writeMs = 0,
) {
  console.info(
    JSON.stringify({
      event: "import_page",
      jobId,
      courseId,
      sourceId,
      page,
      phase,
      elapsedMs: Math.round(performance.now() - started),
      requests: metrics?.requests || 0,
      networkRetries: metrics?.networkRetries || 0,
      parseRetries: metrics?.parseRetries || 0,
      rateLimits: metrics?.rateLimits || 0,
      serverErrors: metrics?.serverErrors || 0,
      modelMs: metrics?.elapsedMs || 0,
      writeMs: Math.round(writeMs * 100) / 100,
    }),
  );
}
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
export function claimJob(courseId?: string) {
  const { db, sqlite } = database();
  return sqlite
    .transaction(() => {
      // 心跳每 10 秒更新；进程意外退出后，过期任务标记失败，可由界面重试。
      const expired = db
        .update(jobs)
        .set({
          status: "failed",
          error: "worker 心跳已过期，可从失败处继续",
          step: "导入中断",
          finishedAt: now(),
        })
        .where(
          and(
            eq(jobs.status, "running"),
            courseId ? eq(jobs.courseId, courseId) : undefined,
            lt(jobs.heartbeatAt, new Date(Date.now() - 300_000).toISOString()),
          ),
        )
        .returning()
        .all();
      for (const job of expired)
        db.update(courses)
          .set({ status: "failed" })
          .where(eq(courses.id, job.courseId))
          .run();
      const row = db
        .select()
        .from(jobs)
        .where(
          courseId
            ? and(eq(jobs.status, "queued"), eq(jobs.courseId, courseId))
            : eq(jobs.status, "queued"),
        )
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
  const completedItem = (key: string) =>
    db
      .select()
      .from(importItems)
      .where(and(eq(importItems.courseId, courseId), eq(importItems.key, key)))
      .get();
  const markItem = (key: string, ok: boolean, message: string) =>
    db
      .insert(importItems)
      .values({
        courseId,
        key,
        status: ok ? "done" : "needs_review",
        message: ok ? null : message,
      })
      .onConflictDoNothing()
      .run();
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
    if (
      ["import:questions", "import:answers", "import:formulas"].includes(
        job.type,
      )
    ) {
      const hooks = {
        progress,
        tokens: (amount: number) => {
          tokens += amount;
        },
      };
      const recovered =
        job.type !== "import:answers"
          ? await runFormulaStep(courseId, hooks, true)
          : [];
      if (job.type === "import:questions") {
        const questionSources = db
          .select()
          .from(sources)
          .where(
            and(
              eq(sources.courseId, courseId),
              eq(sources.kind, "question_bank"),
            ),
          )
          .all();
        const texts = [];
        for (const source of questionSources) {
          if (!source.textKey)
            throw new Error("习题原文缓存缺失，请先完成资料导入");
          const text = await readFile(storagePath(source.textKey), "utf8");
          texts.push({
            sourceId: source.id,
            pages: text.split(/\f/).map((text) => ({ text })),
            ...recovered.find((s) => s.sourceId === source.id),
          });
        }
        await runQuestionExtraction(courseId, texts, hooks);
      }
      if (job.type !== "import:formulas")
        await runQuestionAnswers(courseId, hooks);
      db.transaction((tx) => {
        tx.update(courses)
          .set({ status: "ready" })
          .where(eq(courses.id, courseId))
          .run();
        tx.update(jobs)
          .set({
            status: "done",
            progress: 100,
            step:
              job.type === "import:formulas" ? "公式步骤完成" : "习题步骤完成",
            costTokens: tokens,
            finishedAt: now(),
            heartbeatAt: now(),
            error: null,
          })
          .where(eq(jobs.id, jobId))
          .run();
      });
      return;
    }
    const language = course.language?.trim() || "zh";
    const input = db
      .select()
      .from(sources)
      .where(eq(sources.courseId, courseId))
      .all();
    console.info(
      JSON.stringify({
        event: "import_start",
        jobId,
        courseId,
        pageConcurrency: importPageConcurrency(),
      }),
    );
    db.update(courses)
      .set({ status: "importing" })
      .where(eq(courses.id, courseId))
      .run();
    const existingPages = db
      .select()
      .from(pages)
      .where(eq(pages.courseId, courseId))
      .all();
    const primaryIds = new Set(
      input
        .filter(
          (source) =>
            source.kind ===
            (input.some((s) => s.kind === "slides") ? "slides" : "textbook"),
        )
        .map((source) => source.id),
    );
    let primaryOffset = 0;
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
      const pdfExists = await access(pdf).then(
        () => true,
        () => false,
      );
      if (!pdfExists && source.mime === "application/pdf")
        await copyFile(storagePath(source.storageKey), pdf);
      else if (!pdfExists) {
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
      const count =
        source.pages > 0 && pdfExists
          ? source.pages
          : Number(
              (await command("pdfinfo", [pdf])).stdout.match(
                /^Pages:\s+(\d+)/m,
              )?.[1],
            );
      if (!count) throw new Error("PDF 页数为空或不可读取");
      totalPages += count;
      if (totalPages > 500)
        throw new Error("MVP 单课程总页数上限为 500，请拆分课程资料");
      db.update(sources)
        .set({ pdfKey, pages: count, status: "processing" })
        .where(and(eq(sources.id, source.id), eq(sources.courseId, courseId)))
        .run();
      const offset = primaryOffset;
      if (primaryIds.has(source.id)) primaryOffset += count;
      const sourcePages = await mapImportPages(
        Array.from({ length: count }, (_, i) => i + 1),
        async (i): Promise<ParsedPage> => {
          const started = performance.now();
          const imageKey = `${folderKey}/page-${i}.png`,
            textFile = path.join(folder, `page-${i}.txt`),
            cacheKey = `${folderKey}/page-${i}.json`;
          const existing = existingPages.find(
            (p) => p.sourceId === source.id && p.sourcePage === i,
          );
          let cached = await readCachedPage(cacheKey);
          // Reuse completed conversions from workers predating durable page caches.
          if (!cached && !existing && source.status === "ready") {
            try {
              const bytes = await readFile(storagePath(imageKey));
              cached = {
                text: await readFile(textFile, "utf8"),
                imageKey,
                width: bytes.readUInt32BE(16),
                height: bytes.readUInt32BE(20),
              };
            } catch {
              /* Incomplete files are regenerated. */
            }
          }
          let page: ParsedPage;
          if (cached) page = cached;
          else if (
            existing &&
            (await access(storagePath(existing.imageKey)).then(
              () => true,
              () => false,
            ))
          ) {
            page = {
              text: existing.rawText,
              imageKey: existing.imageKey,
              width: existing.width,
              height: existing.height,
            };
          } else {
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
            page = {
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
            await cachePage(cacheKey, page);
          }
          if (primaryIds.has(source.id) && !existing) {
            db.insert(pages)
              .values({
                id: uid(),
                courseId,
                sourceId: source.id,
                sourcePage: i,
                index: offset + i,
                imageKey: page.imageKey,
                width: page.width,
                height: page.height,
                rawText: page.text,
                title: pageTitle(page.text, language),
              })
              .run();
          }
          logPage(
            jobId,
            courseId,
            source.id,
            i,
            cached || existing ? "extract_cached" : "extract",
            started,
            cached || existing ? undefined : page.cachedNote?.metrics,
          );
          return page;
        },
        (completed) =>
          progress(
            3 + Math.round(((si + completed / count) / input.length) * 27),
            `提取页图与文本：资料 ${si + 1}/${input.length} · ${completed}/${count} 页`,
          ),
      );
      const textKey = `${folderKey}/text.txt`;
      if (
        source.status !== "ready" ||
        !(await access(storagePath(textKey)).then(
          () => true,
          () => false,
        ))
      ) {
        await writeFile(
          storagePath(textKey),
          sourcePages.map((p) => p.text).join("\n\f\n"),
        );
      }
      db.update(sources)
        .set({ pdfKey, textKey, pages: count, status: "ready" })
        .where(and(eq(sources.id, source.id), eq(sources.courseId, courseId)))
        .run();
      parsed.push({ source, pages: sourcePages });
    }
    const questionHooks = {
      progress,
      tokens: (amount: number) => {
        tokens += amount;
      },
    };
    const formulaSources = await runFormulaStep(courseId, questionHooks);
    for (const entry of parsed) {
      const recovered = formulaSources.find(
        (s) => s.sourceId === entry.source.id,
      );
      if (recovered && entry.source.kind === "textbook")
        entry.pages = entry.pages.map((p, i) => ({
          ...p,
          text: recovered.pages[i].text,
        }));
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
    const existingKps = db
      .select()
      .from(knowledgePoints)
      .where(eq(knowledgePoints.courseId, courseId))
      .orderBy(asc(knowledgePoints.order))
      .all();
    const kps: (typeof knowledgePoints.$inferSelect & {
      pageNumbers: number[];
    })[] = [];
    const pageToKp = new Map<number, string>();
    if (existingKps.length) {
      const savedPages = db
        .select()
        .from(pages)
        .where(eq(pages.courseId, courseId))
        .all();
      for (const kp of existingKps) {
        const pageNumbers = savedPages
          .filter((p) => p.kpId === kp.id)
          .map((p) => p.index);
        kps.push({ ...kp, pageNumbers });
        for (const n of pageNumbers) pageToKp.set(n, kp.id);
      }
      // Compatibility with tasks interrupted between structure and page persistence.
      for (let n = 1; n <= allPages.length; n++)
        if (!pageToKp.has(n)) {
          const kp =
            kps.find((k) => k.pageNumbers.some((page) => page >= n)) ||
            kps.at(-1)!;
          pageToKp.set(n, kp.id);
          kp.pageNumbers.push(n);
        }
    } else {
      const result = await optionalModel(
        "structure",
        structureSchema(allPages.length),
        `课程：${course.title}\n${structurePrompt(allPages.length)}\n页面：${JSON.stringify(summaries).slice(0, 65000)}\n教材：${parsed
          .filter((s) => s.source.kind === "textbook")
          .flatMap((s) => s.pages.map((p) => p.text))
          .join("\n")
          .slice(0, 18000)}`,
      );
      tokens += result?.tokens || 0;
      const { min, max } = knowledgePointRange(allPages.length);
      const count = Math.min(
        max,
        Math.max(min, Math.ceil(allPages.length / 10)),
      );
      const tree = result?.data || {
        chapters: [
          {
            title: course.title,
            summary: "规则整理，待核对",
            knowledgePoints: Array.from({ length: count }, (_, i) => {
              const start = Math.floor((i * allPages.length) / count);
              const end = Math.floor(((i + 1) * allPages.length) / count);
              return {
                title: fallbackKnowledgePointTitle(
                  summaries.slice(start, end).map((p) => p.title),
                  i,
                ),
                keywords: [],
                pages: Array.from(
                  { length: end - start },
                  (_, j) => start + j + 1,
                ),
              };
            }),
          },
        ],
      };
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
            const row = {
              id: uid(),
              courseId,
              chapterId,
              code: `K${kps.length + 1}`,
              order: kps.length,
              title: redactPII(kp.title),
              keywords: kp.keywords.map(redactPII),
              contentMd: "",
              hasSlides: kp.pages.some(
                (n) => allPages[n - 1].source.kind === "slides",
              ),
            };
            tx.insert(knowledgePoints).values(row).run();
            for (const n of kp.pages) pageToKp.set(n, row.id);
            kps.push({ ...row, pageNumbers: kp.pages });
          }
        }
        for (const [index, kpId] of pageToKp)
          tx.update(pages)
            .set({ kpId })
            .where(and(eq(pages.courseId, courseId), eq(pages.index, index)))
            .run();
        markItem("structure", !!result, "章节与知识点使用规则划分，待核对");
      });
    }
    const savedPages = db
      .select()
      .from(pages)
      .where(eq(pages.courseId, courseId))
      .all();
    const savedNotes = new Set(
      db
        .select({ pageId: pageNotes.pageId })
        .from(pageNotes)
        .innerJoin(pages, eq(pageNotes.pageId, pages.id))
        .where(eq(pages.courseId, courseId))
        .all()
        .map((n) => n.pageId),
    );
    let completedNotes = savedPages.filter((p) => savedNotes.has(p.id)).length;
    const noteProgress = () =>
      progress(
        36 + Math.round((completedNotes / allPages.length) * 29),
        `整理逐页要点 ${completedNotes}/${allPages.length}`,
      );
    noteProgress();
    await mapImportPages(
      allPages.filter(
        (_, i) =>
          !savedNotes.has(savedPages.find((p) => p.index === i + 1)!.id),
      ),
      async (page) => {
        const started = performance.now();
        const row = savedPages.find(
          (p) =>
            p.sourceId === page.source.id && p.sourcePage === page.sourcePage,
        )!;
        let result = page.cachedNote;
        if (!result) {
          const image = resolveProviderConfig("notes", true)
            ? `data:image/png;base64,${(await readFile(storagePath(page.imageKey))).toString("base64")}`
            : undefined;
          result = await generatePageNote({
            text: page.text,
            language,
            image,
            transcribe: !page.text && !!image,
          });
          tokens += result.tokens;
        }
        const { note, model, ruleBased } = result;
        const writeStart = performance.now();
        db.transaction((tx) => {
          tx.update(pages)
            .set({
              title: redactPII(note.title),
              kpId: pageToKp.get(row.index)!,
              rawText: page.text || redactPII(note.text || ""),
            })
            .where(and(eq(pages.id, row.id), eq(pages.courseId, courseId)))
            .run();
          tx.insert(pageNotes)
            .values({
              pageId: row.id,
              title: redactPII(note.title),
              points: note.points.map(redactPII),
              keys: note.keys.map(redactPII),
              model,
              qaStatus:
                formulaSources.find((s) => s.sourceId === page.source.id)
                  ?.formulas[String(page.sourcePage)]?.status === "missing"
                  ? "needs_review"
                  : qaNote(note, ruleBased),
            })
            .run();
        });
        logPage(
          jobId,
          courseId,
          page.source.id,
          page.sourcePage,
          page.cachedNote ? "notes_cached_ocr" : "notes",
          started,
          page.cachedNote ? undefined : result.metrics,
          performance.now() - writeStart,
        );
      },
      () => {
        completedNotes++;
        noteProgress();
      },
    );
    // Fill only missing legacy mappings; preserve teacher-reviewed assignments.
    for (const row of savedPages)
      if (!row.kpId)
        db.update(pages)
          .set({ kpId: pageToKp.get(row.index) })
          .where(and(eq(pages.id, row.id), eq(pages.courseId, courseId)))
          .run();
    const persistedPages = db
      .select()
      .from(pages)
      .where(eq(pages.courseId, courseId))
      .orderBy(asc(pages.index))
      .all();
    const textbookPages = parsed
      .filter((s) => s.source.kind === "textbook")
      .flatMap((s) => s.pages);
    for (const [i, kp] of kps.entries()) {
      if (kp.contentMd.trim() || completedItem(`textbook:${kp.id}`)) continue;
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
      const content = await optionalModel(
        "textbook",
        TextbookSchema,
        `知识点 ${kp.code} ${kp.title}。依据下列教材/页面整理讲义，引用具体定义和例子；无资料时明确说明。返回 {"content_md":"Markdown 讲义"}。\n资料：\n${reference}`,
      );
      tokens += content?.tokens || 0;
      db.transaction((tx) => {
        tx.update(knowledgePoints)
          .set({
            contentMd: redactPII(
              content?.data.content_md ||
                `## ${kp.title}\n\n> 规则整理，待核对。\n\n${reference || "请结合页图学习此知识点。"}`,
            ),
          })
          .where(
            and(
              eq(knowledgePoints.id, kp.id),
              eq(knowledgePoints.courseId, courseId),
            ),
          )
          .run();
        markItem(
          `textbook:${kp.id}`,
          !!content,
          `${kp.code} 讲义使用原文降级，待核对`,
        );
      });
    }
    await runQuestionExtraction(
      courseId,
      parsed
        .filter((s) => s.source.kind === "question_bank")
        .map((s) => ({
          sourceId: s.source.id,
          pages: s.pages,
          ...formulaSources.find((r) => r.sourceId === s.source.id),
        })),
      questionHooks,
    );
    await runQuestionAnswers(courseId, questionHooks);
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
        step: `${db.select().from(jobs).where(eq(jobs.id, jobId)).get()?.step || "导入"}（失败，可继续）`,
        error: message,
        costTokens: tokens,
        finishedAt: now(),
      })
      .where(eq(jobs.id, jobId))
      .run();
    db.update(courses)
      .set({ status: "failed" })
      .where(eq(courses.id, courseId))
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

/** 无模型时按题目边界抽取原文，答案仅保留原文提供的内容。 */
export function fallbackQuestions(text: string) {
  return questionBoundaries([{ text }])
    .filter((q) => q.numbered)
    .map(ruleQuestion);
}
