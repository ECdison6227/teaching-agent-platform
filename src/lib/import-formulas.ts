import { createHash } from "node:crypto";
import {
  access,
  copyFile,
  mkdir,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { database } from "../db";
import {
  importItems,
  pages,
  pageNotes,
  questions,
  sources,
  type Source,
} from "../db/schema";
import { command } from "./import-command";
import { readCachedPage, type ParsedPage } from "./import-cache";
import {
  applyOmml,
  docxMathParagraphs,
  validLatex,
  type MathParagraph,
} from "./docx-formulas";
import {
  FormulaRecoverySchema,
  formulaGapReasons,
  latexFormulas,
  type FormulaRecovery,
} from "./formulas";
import { structured, resolveProviderConfig } from "./models/provider";
import {
  questionBoundaries,
  ruleQuestion,
  stripQuestionNumber,
  type QuestionBoundary,
} from "./question-parser";
import { redactPII, storagePath } from "./storage";

export type FormulaHooks = {
  tokens: (amount: number) => void;
  progress: (value: number, step: string) => void;
};
export type FormulaSource = {
  sourceId: string;
  pages: { text: string }[];
  boundaries: QuestionBoundary[];
  formulas: Record<string, FormulaRecovery>;
};
const UnitSchema = z.object({
  id: z.string(),
  text: z.string(),
  recovery: FormulaRecoverySchema.nullable(),
});
const CacheSchema = z.object({ hash: z.string(), units: z.array(UnitSchema) });
const VisionSchema = z.object({
  text: z.string().min(1).max(30000).nullable(),
  confidence: z.number().min(0).max(1),
  complete: z.boolean(),
});
const exists = (file: string) =>
  access(file).then(
    () => true,
    () => false,
  );
export const formulaDocument = (source: Source) =>
  ["question_bank", "textbook"].includes(source.kind) &&
  /\.docx?$/i.test(source.filename);
const folderKey = (source: Source) =>
  `courses/${source.courseId}/derived/${source.id}`;
function marker(courseId: string, key: string, recovery: FormulaRecovery) {
  const { db } = database();
  const values = {
    status:
      recovery.status === "missing"
        ? ("needs_review" as const)
        : ("done" as const),
    message:
      recovery.status === "missing"
        ? "公式缺失：" + recovery.reasons.join("；")
        : null,
  };
  db.insert(importItems)
    .values({ courseId, key, ...values })
    .onConflictDoUpdate({
      target: [importItems.courseId, importItems.key],
      set: values,
    })
    .run();
}
async function documentMath(source: Source): Promise<MathParagraph[]> {
  let docx = storagePath(source.storageKey);
  if (/\.doc$/i.test(source.filename)) {
    const key = `${folderKey(source)}/omml`,
      folder = storagePath(key);
    await mkdir(folder, { recursive: true });
    const converted = path.join(
      folder,
      path.basename(source.storageKey, path.extname(source.storageKey)) +
        ".docx",
    );
    if (!(await exists(converted)))
      await command("soffice", [
        `-env:UserInstallation=${pathToFileURL(path.join(folder, "lo-profile")).href}`,
        "--headless",
        "--convert-to",
        "docx:Office Open XML Text",
        "--outdir",
        folder,
        docx,
      ]);
    docx = converted;
  }
  const { stdout } = await command("unzip", ["-p", docx, "word/document.xml"]);
  return docxMathParagraphs(stdout);
}
/** The same PDF and page image naming used by the main importer, including legacy resumes. */
async function pageImage(source: Source, page: number) {
  const key = folderKey(source),
    folder = storagePath(key);
  await mkdir(folder, { recursive: true });
  const imageKey = `${key}/page-${page}.png`;
  if (!(await exists(storagePath(imageKey)))) {
    const pdf = storagePath(source.pdfKey || `${key}/document.pdf`);
    if (!(await exists(pdf))) {
      await command("soffice", [
        `-env:UserInstallation=${pathToFileURL(path.join(folder, "formula-lo-profile")).href}`,
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
    }
    await command("pdftoppm", [
      "-f",
      String(page),
      "-l",
      String(page),
      "-singlefile",
      "-scale-to",
      "1400",
      "-png",
      pdf,
      storagePath(imageKey).slice(0, -4),
    ]);
  }
  return `data:image/png;base64,${(await readFile(storagePath(imageKey))).toString("base64")}`;
}
function prose(text: string) {
  return stripQuestionNumber(text)
    .replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*?\$|\[公式缺失\]|[_＿]+/g, "")
    .replace(/[\s\p{P}\p{S}]/gu, "")
    .toLowerCase();
}
/** Require original prose in order. Formula repair cannot silently rewrite an exercise. */
function preservesProse(before: string, after: string) {
  const number = (text: string) => {
    const full = text.trim(),
      stripped = stripQuestionNumber(text);
    return full
      .slice(0, full.length - stripped.length)
      .normalize("NFKC")
      .match(/\d+/)?.[0];
  };
  if (number(before) !== number(after)) return false;
  const a = prose(before),
    b = prose(after);
  let i = 0;
  for (const c of b) if (c === a[i]) i++;
  return a.length > 0 && i === a.length && b.length <= a.length + 12;
}
async function repairUnit(
  courseId: string,
  source: Source,
  unit: QuestionBoundary,
  paragraphs: MathParagraph[],
  hooks: FormulaHooks,
) {
  const applied = applyOmml(
    unit.text,
    paragraphs,
    source.kind === "question_bank" ? unit.id : undefined,
  );
  let text = applied.text;
  const evidence: FormulaRecovery["evidence"] = applied.latex.length
    ? [{ source: "omml", confidence: 1, latex: applied.latex }]
    : [];
  const gaps = (value: string) => {
    const q = ruleQuestion({ ...unit, text: value });
    return formulaGapReasons(q.prompt, q.options);
  };
  const reasons = gaps(text);
  const unlocated =
    !applied.latex.length &&
    !applied.unresolved &&
    paragraphs.some((p) => {
      if (p.questionId)
        return source.kind === "question_bank" && p.questionId === unit.id;
      const anchors = p.text
        .split(/\$[^$\n]+\$|\[公式缺失\]/)
        .map((s) => s.replace(/\s/g, ""));
      return (
        anchors.every((a) => a.length < 8) ||
        anchors.some(
          (a) => a.length >= 8 && unit.text.replace(/\s/g, "").includes(a),
        )
      );
    });
  if (unlocated) reasons.push("嵌入式公式未能可靠定位");
  let incomplete = applied.unresolved;
  if (reasons.length) {
    incomplete = true;
    if (resolveProviderConfig("questions", true)) {
      for (let page = unit.page; page <= (unit.endPage || unit.page); page++) {
        try {
          const result = await structured(
            "questions",
            VisionSchema,
            `课程 ID：${courseId}。步骤：公式视觉回填。资料 ID：${source.id}，页码：${page}，题目定位 ID：${unit.id}。只查看此页原文，按题号定位下列题目（教材则为整页），将遗漏的嵌入式公式转为 $LaTeX$ 并回填题干和全部选项。保留题号、所有原文字句、选项 ID、答题括号/填空槽及原文答案；禁止推导、补题或猜测。看不清或题号不匹配时 text=null。返回 {"text":"含公式的完整原文或null","confidence":0到1,"complete":是否已补齐全部缺失公式}。完整原文：\n${text}`,
            await pageImage(source, page),
          );
          hooks.tokens(result?.tokens || 0);
          const data = result?.data;
          if (
            !data?.text ||
            data.confidence < 0.75 ||
            !validLatex(data.text) ||
            !preservesProse(text, data.text)
          )
            continue;
          // Keep option identities and count; a model must not remove an empty option.
          const oldOptions =
            ruleQuestion({ ...unit, text }).options?.map((o) => o.id) || [];
          const newOptions =
            ruleQuestion({ ...unit, text: data.text }).options?.map(
              (o) => o.id,
            ) || [];
          if (JSON.stringify(oldOptions) !== JSON.stringify(newOptions))
            continue;
          text = redactPII(data.text);
          evidence.push({
            source: "vision",
            confidence: data.confidence,
            latex: latexFormulas(text),
          });
          incomplete = !data.complete || gaps(text).length > 0;
          if (!incomplete) break;
        } catch {
          // Individual page/model errors must not prevent later questions from importing.
          console.warn(
            JSON.stringify({
              event: "formula_vision_fallback",
              courseId,
              sourceId: source.id,
              page,
              questionId: unit.id,
            }),
          );
        }
      }
    }
  }
  const recovery: FormulaRecovery | null =
    evidence.length || reasons.length || incomplete
      ? {
          status: incomplete || gaps(text).length ? "missing" : "recovered",
          evidence,
          reasons:
            incomplete || gaps(text).length
              ? [
                  ...new Set([
                    ...reasons,
                    ...gaps(text),
                    ...(incomplete ? ["未能可靠补齐公式"] : []),
                  ]),
                ]
              : [],
        }
      : null;
  return { id: unit.id, text, recovery };
}
export async function recoverSourceFormulas(
  courseId: string,
  source: Source,
  input: { text: string }[],
  hooks: FormulaHooks,
  force = false,
): Promise<FormulaSource> {
  if (source.courseId !== courseId) throw new Error("公式资料不属于本课程");
  const boundaries = questionBoundaries(input);
  const unchanged = {
    sourceId: source.id,
    pages: input,
    boundaries,
    formulas: {},
  };
  if (!formulaDocument(source)) return unchanged;
  const units: QuestionBoundary[] =
    source.kind === "question_bank"
      ? boundaries
      : input.map((p, i) => ({
          id: String(i + 1),
          text: p.text,
          page: i + 1,
          numbered: false,
        }));
  const key = `${folderKey(source)}/formulas-v1.json`,
    cache = storagePath(key);
  const hash = createHash("sha256")
    .update(source.sha256 + JSON.stringify(units))
    .digest("hex");
  let saved: z.infer<typeof CacheSchema> | undefined;
  if (!force)
    try {
      const value = CacheSchema.parse(
        JSON.parse(await readFile(cache, "utf8")),
      );
      if (value.hash === hash) saved = value;
    } catch {
      /* First pass or invalid cache. */
    }
  if (!saved) {
    let paragraphs: MathParagraph[] = [];
    try {
      paragraphs = await documentMath(source);
    } catch {
      console.warn(
        JSON.stringify({
          event: "formula_omml_fallback",
          courseId,
          sourceId: source.id,
        }),
      );
    }
    saved = { hash, units: [] };
    for (const unit of units) {
      saved.units.push(
        await repairUnit(courseId, source, unit, paragraphs, hooks),
      );
      hooks.progress(
        30,
        `检查嵌入式公式 ${saved.units.length}/${units.length}`,
      );
    }
    await mkdir(path.dirname(cache), { recursive: true });
    await writeFile(`${cache}.tmp`, JSON.stringify(saved));
    await rename(`${cache}.tmp`, cache);
  }
  const formulas: Record<string, FormulaRecovery> = {};
  for (const unit of saved.units)
    if (unit.recovery) {
      formulas[unit.id] = unit.recovery;
      marker(
        courseId,
        `formulas:v1:${source.id}:${source.kind === "textbook" ? "page" : "question"}:${unit.id}`,
        unit.recovery,
      );
    }
  return {
    sourceId: source.id,
    pages:
      source.kind === "textbook"
        ? input.map((p, i) => ({ ...p, text: saved.units[i]?.text ?? p.text }))
        : input,
    boundaries: boundaries.map((q) => ({
      ...q,
      text: saved.units.find((u) => u.id === q.id)?.text ?? q.text,
    })),
    formulas,
  };
}
/** Reuse raw extraction caches so explicit formula reruns can replace a prior recovery. */
export async function loadFormulaPages(source: Source): Promise<ParsedPage[]> {
  if (!source.textKey) throw new Error("资料原文缓存缺失，请先完成资料导入");
  const fallback = (await readFile(storagePath(source.textKey), "utf8")).split(
    /\f/,
  );
  return Promise.all(
    fallback.map(
      async (text, i) =>
        (await readCachedPage(`${folderKey(source)}/page-${i + 1}.json`)) || {
          text: text.trim(),
          imageKey: `${folderKey(source)}/page-${i + 1}.png`,
          width: 1,
          height: 1,
        },
    ),
  );
}
export async function runFormulaStep(
  courseId: string,
  hooks: FormulaHooks,
  force = false,
) {
  const { db } = database();
  const recovered: FormulaSource[] = [];
  for (const source of db
    .select()
    .from(sources)
    .where(eq(sources.courseId, courseId))
    .all()
    .filter(formulaDocument)) {
    const result = await recoverSourceFormulas(
      courseId,
      source,
      await loadFormulaPages(source),
      hooks,
      force,
    );
    recovered.push(result);
    if (source.kind === "textbook") {
      for (const [i, page] of result.pages.entries()) {
        const row = db
          .update(pages)
          .set({ rawText: page.text })
          .where(
            and(
              eq(pages.courseId, courseId),
              eq(pages.sourceId, source.id),
              eq(pages.sourcePage, i + 1),
            ),
          )
          .returning()
          .get();
        if (row && result.formulas[String(i + 1)]?.status === "missing")
          db.update(pageNotes)
            .set({ qaStatus: "needs_review" })
            .where(eq(pageNotes.pageId, row.id))
            .run();
      }
      const textKey = `${folderKey(source)}/formula-text.txt`;
      await writeFile(
        storagePath(textKey),
        result.pages.map((p) => p.text).join("\n\f\n"),
      );
      db.update(sources)
        .set({ textKey })
        .where(and(eq(sources.courseId, courseId), eq(sources.id, source.id)))
        .run();
    } else {
      const existing = db
        .select()
        .from(questions)
        .where(eq(questions.courseId, courseId))
        .all()
        .filter(
          (q) => q.source !== "generated" && q.source.sourceId === source.id,
        );
      for (const q of existing) {
        if (q.verified || q.source === "generated") continue;
        const candidates = result.boundaries.filter(
          (b) =>
            q.source !== "generated" &&
            (q.source.questionId
              ? b.id === q.source.questionId
              : b.page === q.source.page &&
                preservesProse(ruleQuestion(b).prompt, q.prompt)),
        );
        if (candidates.length !== 1) {
          if (Object.keys(result.formulas).length)
            db.update(questions)
              .set({
                formulaRecovery: {
                  status: "missing",
                  evidence: [],
                  reasons: [
                    "无法按题号可靠定位公式，请核对原文或从 questions 重抽",
                  ],
                },
                reviewStatus: "needs_review",
              })
              .where(
                and(eq(questions.courseId, courseId), eq(questions.id, q.id)),
              )
              .run();
          continue;
        }
        const boundary = candidates[0],
          recovery = result.formulas[boundary.id];
        if (!recovery) continue;
        const repaired = ruleQuestion(boundary);
        const changed =
          q.prompt !== repaired.prompt ||
          JSON.stringify(q.options || []) !==
            JSON.stringify(repaired.options || []);
        db.update(questions)
          .set({
            prompt: redactPII(repaired.prompt),
            options: repaired.options,
            formulaRecovery: recovery,
            verified: false,
            reviewStatus: "needs_review",
            ...(changed && q.answerMethod !== "source"
              ? { answer: null, answerMethod: null, analysis: "" }
              : {}),
          })
          .where(and(eq(questions.courseId, courseId), eq(questions.id, q.id)))
          .run();
      }
    }
  }
  return recovered;
}
