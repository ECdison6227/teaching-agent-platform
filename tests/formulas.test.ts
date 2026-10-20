import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import { courses, questions } from "../src/db/schema";
import {
  createCourse,
  saveSource,
  courseContent,
  enqueueImport,
  restartQuestionSteps,
} from "../src/lib/courses";
import { claimJob, importJob } from "../src/lib/importer";
import { runQuestionAnswers } from "../src/lib/import-questions";
import { recoverSourceFormulas } from "../src/lib/import-formulas";
import {
  docxMathParagraphs,
  ommlToLatex,
  applyOmml,
} from "../src/lib/docx-formulas";
import { formulaGapReasons } from "../src/lib/formulas";
import { reviewContent } from "../src/lib/review";
import { storagePath } from "../src/lib/storage";
import { makePdf } from "../scripts/generate-samples.mjs";
import {
  fractionOmml,
  makeFormulaDocx,
} from "../scripts/generate-formula-sample.mjs";
import { startMockModel } from "../scripts/mock-model.mjs";

const dir = await mkdtemp(path.join(tmpdir(), "tap-formulas-test-"));
process.env.DATA_DIR = dir;
process.env.MODEL_PROVIDER = "none";
const originalFetch = globalThis.fetch;
const hooks = { progress: () => {}, tokens: (_: number) => {} };
after(async () => {
  globalThis.fetch = originalFetch;
  database().sqlite.close();
  await rm(dir, { recursive: true, force: true });
});
test("原创 OMML 分式、上下标、根式和不可解析对象", () => {
  assert.equal(ommlToLatex(fractionOmml), String.raw`\frac{x+1}{3}`);
  const wrap = (body: string) =>
    `<m:oMath xmlns:m="http://schemas.openxmlformats.org/officeDocument/2006/math">${body}</m:oMath>`;
  assert.equal(
    ommlToLatex(
      wrap(
        "<m:sSubSup><m:e><m:r><m:t>α</m:t></m:r></m:e><m:sub><m:r><m:t>i</m:t></m:r></m:sub><m:sup><m:r><m:t>2</m:t></m:r></m:sup></m:sSubSup>",
      ),
    ),
    String.raw`{\alpha }_{i}^{2}`,
  );
  assert.equal(
    ommlToLatex(
      wrap(
        "<m:rad><m:deg><m:r><m:t>3</m:t></m:r></m:deg><m:e><m:r><m:t>x</m:t></m:r></m:e></m:rad>",
      ),
    ),
    String.raw`\sqrt[3]{x}`,
  );
  assert.throws(() => ommlToLatex(wrap("<m:unknown/>")));
  assert.throws(() => ommlToLatex("<!DOCTYPE x><m:oMath/>"));
  const xml = `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>1. If </w:t></w:r><w:object/><w:r><w:t> is positive, explain.</w:t></w:r></w:p></w:body></w:document>`;
  const paragraphs = docxMathParagraphs(xml);
  const applied = applyOmml("1. If     is positive, explain.", paragraphs);
  assert.equal(applied.unresolved, true);
  assert.match(applied.text, /公式缺失/);
});
test("公式缺失启发式保留普通选择括号与填空槽", () => {
  assert.equal(
    formulaGapReasons("Choose a shape. ( )", [
      { text: "square" },
      { text: "circle" },
    ]).length,
    0,
  );
  assert.equal(formulaGapReasons("Calculate 2 + 3 = ____. ").length, 0);
  assert.ok(formulaGapReasons("若 ____ ,则说明（ ）").length);
  assert.ok(formulaGapReasons("若    ,则说明（ ）").length);
  assert.ok(formulaGapReasons("若（ ）成立，则求结果。").length);
  assert.ok(
    formulaGapReasons("Choose one.", [{ text: "" }, { text: "1" }]).length,
  );
});
test("DOCX 真实转换与 OMML 回填；教材公式进原文、习题题干和选项保留来源", async () => {
  const course = createCourse({ title: "Original symbolic comparison" });
  const book = saveSource(
    course.id,
    "textbook",
    "original.docx",
    makeFormulaDocx({ textbook: true }),
  );
  const bank = saveSource(
    course.id,
    "question_bank",
    "original.docx",
    makeFormulaDocx(),
  );
  const job = enqueueImport(course.id);
  assert.equal(claimJob(course.id)?.id, job.id);
  await importJob(job.id);
  const content = courseContent(course.id);
  assert.equal(content.jobs[0].status, "done", content.jobs[0].error || "");
  assert.equal(content.questions.length, 1);
  const q = content.questions[0];
  assert.match(q.prompt, /\$\\frac\{x\+1\}\{3\}\$/);
  assert.equal(q.options?.[0].text, "${x}^{2}$");
  assert.equal(q.options?.[1].text, "$\\sqrt{x}$");
  assert.equal(q.formulaRecovery?.status, "recovered");
  assert.ok(
    q.formulaRecovery?.evidence.every(
      (e) => e.source === "omml" && e.confidence === 1,
    ),
  );
  assert.match(content.pages[0].rawText, /\\frac/);
  assert.match(
    await readFile(
      storagePath(content.sources.find((s) => s.id === book.id)!.textKey!),
      "utf8",
    ),
    /\\frac/,
  );
  // Simulate the text extractor losing every formula, keeping the actual DOCX as evidence.
  const lost = await recoverSourceFormulas(
    course.id,
    bank,
    [
      {
        text: "1. If ____ is positive, which expression is shown? ( )\nA. \nB. \nAnswer: A",
      },
    ],
    hooks,
    true,
  );
  assert.match(lost.boundaries[0].text, /\\frac/);
  assert.match(lost.boundaries[0].text, /\\sqrt/);
  assert.equal(lost.formulas["1"].status, "recovered");
});
test("视觉 mock 回填题干/空选项；低置信度、无模型和重跑隔离", async () => {
  const course = createCourse({ title: "Original visual recovery" });
  saveSource(
    course.id,
    "slides",
    "original.pdf",
    makePdf([["Original expression comparison"]]),
  );
  saveSource(
    course.id,
    "question_bank",
    "gaps.docx",
    makeFormulaDocx({ gaps: true }),
  );
  const job = enqueueImport(course.id);
  claimJob(course.id);
  await importJob(job.id);
  const before = courseContent(course.id),
    q = before.questions[0];
  assert.equal(q.formulaRecovery?.status, "missing");
  assert.equal(q.reviewStatus, "needs_review");
  assert.ok(
    before.importItems.some(
      (i) => i.key.startsWith("formulas:") && i.status === "needs_review",
    ),
  );
  assert.throws(
    () =>
      reviewContent(course.id, {
        kind: "question",
        id: q.id,
        answer: "A",
        analysis: "",
        verified: true,
      }),
    /公式缺失/,
  );
  const imageTime = (await stat(storagePath(before.pages[0].imageKey))).mtimeMs;
  process.env.MODEL_PROVIDER = "openai-compatible";
  process.env.OPENAI_BASE_URL = "http://model.test/v1";
  process.env.OPENAI_CHAT_MODEL = "mock-chat";
  process.env.OPENAI_VISION_MODEL = "mock-vision";
  process.env.VISION_MODEL_PROVIDER = "openai-compatible";
  process.env.MODEL_RETRY_BASE_MS = "1";
  process.env.MODEL_TIMEOUT_MS = "1000";
  let calls = 0;
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, "mock-vision");
    assert.ok(
      body.messages[1].content.some(
        (p: { type: string }) => p.type === "image_url",
      ),
    );
    const prompt = body.messages[1].content[0].text;
    assert.match(prompt, new RegExp(course.id));
    calls++;
    const text = prompt
      .split("完整原文：\n")[1]
      .replace("____", "$x>0$")
      .replace(/A\.\s*\n/, "A. $x$\n");
    return Response.json({
      choices: [
        {
          message: {
            content: JSON.stringify({ text, complete: true, confidence: 0.4 }),
          },
        },
      ],
    });
  };
  const lowJob = restartQuestionSteps(course.id, "formulas");
  await importJob(lowJob.id);
  assert.equal(
    courseContent(course.id).questions[0].formulaRecovery?.status,
    "missing",
  );
  assert.equal(calls, 1);
  // Missing-formula questions must not request a guessed answer.
  await runQuestionAnswers(course.id, hooks);
  assert.equal(calls, 1);
  const mock = await startMockModel();
  globalThis.fetch = originalFetch;
  process.env.OPENAI_BASE_URL = mock.url;
  process.env.OPENAI_CHAT_BASE_URL = mock.url;
  process.env.OPENAI_VISION_BASE_URL = mock.url;
  try {
    const other = createCourse({ title: "Other formula course" });
    saveSource(other.id, "slides", "other.pdf", makePdf([["Other"]]));
    const otherJob = enqueueImport(other.id);
    const cli = await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/resume-import.ts",
        course.id,
        "--from",
        "formulas",
      ],
      { env: process.env },
    );
    assert.match(cli.stdout, /done/);
    const recovered = courseContent(course.id),
      fixed = recovered.questions[0];
    assert.equal(fixed.id, q.id);
    assert.equal(
      fixed.formulaRecovery?.status,
      "recovered",
      JSON.stringify({ fixed, calls: mock.calls, stdout: cli.stdout }),
    );
    assert.equal(fixed.formulaRecovery?.evidence[0].source, "vision");
    assert.equal(fixed.formulaRecovery?.evidence[0].confidence, 0.94);
    assert.match(fixed.prompt, /\$x>0\$/);
    assert.equal(fixed.options?.[0].text, "$x$");
    assert.equal(fixed.verified, false);
    assert.equal(fixed.answer, null);
    assert.deepEqual(recovered.pages, before.pages);
    assert.deepEqual(recovered.knowledgePoints, before.knowledgePoints);
    assert.equal(
      (await stat(storagePath(before.pages[0].imageKey))).mtimeMs,
      imageTime,
    );
    assert.equal(courseContent(other.id).jobs[0].id, otherJob.id);
    assert.equal(courseContent(other.id).jobs[0].status, "queued");
    assert.ok(mock.calls.some((c: { vision: boolean }) => c.vision));
    // --from questions must run formula recovery before extracting, even with a prior cache.
    const restart = restartQuestionSteps(course.id, "questions");
    await importJob(restart.id);
    assert.equal(
      courseContent(course.id).questions[0].formulaRecovery?.status,
      "recovered",
    );
    database()
      .db.update(courses)
      .set({ status: "ready" })
      .where(eq(courses.id, course.id))
      .run();
    const teacher = courseContent(course.id).questions[0];
    database()
      .db.update(questions)
      .set({
        verified: true,
        reviewStatus: "teacher_ok",
        prompt: "Teacher edited prompt",
      })
      .where(eq(questions.id, teacher.id))
      .run();
    const again = restartQuestionSteps(course.id, "formulas");
    await importJob(again.id);
    assert.equal(
      courseContent(course.id).questions[0].prompt,
      "Teacher edited prompt",
    );
  } finally {
    await mock.close();
    process.env.MODEL_PROVIDER = "none";
  }
});

test("旧 DOC 先转换 DOCX 读取 OMML，无法解析时仍能视觉回填", async () => {
  process.env.MODEL_PROVIDER = "none";
  const office = path.join(dir, "legacy-original");
  await mkdir(office, { recursive: true });
  const original = path.join(office, "original.docx");
  await writeFile(original, makeFormulaDocx({ gaps: true }));
  await promisify(execFile)("soffice", [
    `-env:UserInstallation=${pathToFileURL(path.join(office, "profile")).href}`,
    "--headless",
    "--convert-to",
    "doc:MS Word 97",
    "--outdir",
    office,
    original,
  ]);
  const course = createCourse({ title: "Original legacy document recovery" });
  saveSource(
    course.id,
    "slides",
    "original.pdf",
    makePdf([["Original expression comparison"]]),
  );
  const bank = saveSource(
    course.id,
    "question_bank",
    "original.doc",
    await readFile(path.join(office, "original.doc")),
  );
  const job = enqueueImport(course.id);
  claimJob(course.id);
  await importJob(job.id);
  const before = courseContent(course.id);
  assert.equal(before.jobs[0].status, "done", before.jobs[0].error || "");
  assert.equal(before.questions[0].formulaRecovery?.status, "missing");
  const converted = storagePath(
    `courses/${course.id}/derived/${bank.id}/omml/${path.basename(bank.storageKey, ".doc")}.docx`,
  );
  assert.ok((await stat(converted)).size > 0);
  const mock = await startMockModel();
  process.env.MODEL_PROVIDER = "openai-compatible";
  process.env.OPENAI_BASE_URL = mock.url;
  process.env.OPENAI_CHAT_BASE_URL = mock.url;
  process.env.OPENAI_VISION_BASE_URL = mock.url;
  try {
    const retry = restartQuestionSteps(course.id, "formulas");
    await importJob(retry.id);
    const fixed = courseContent(course.id).questions[0];
    assert.equal(fixed.formulaRecovery?.status, "recovered");
    assert.equal(fixed.formulaRecovery?.evidence[0].source, "vision");
    assert.equal(fixed.options?.[0].text, "$x$");
  } finally {
    await mock.close();
    process.env.MODEL_PROVIDER = "none";
  }
});
