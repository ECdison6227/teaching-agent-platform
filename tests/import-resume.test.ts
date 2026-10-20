import test, { after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import { courses } from "../src/db/schema";
import {
  createCourse,
  saveSource,
  enqueueImport,
  courseContent,
} from "../src/lib/courses";
import { claimJob, importJob } from "../src/lib/importer";
import { storagePath } from "../src/lib/storage";
import {
  structureSchema,
  knowledgePointRange,
  structurePrompt,
  fallbackKnowledgePointTitle,
} from "../src/lib/import-structure";
import { makePdf } from "../scripts/generate-samples.mjs";

const dir = await mkdtemp(path.join(tmpdir(), "tap-resume-test-"));
process.env.DATA_DIR = dir;
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.OPENAI_BASE_URL = "http://model.test/v1";
process.env.OPENAI_CHAT_MODEL = "resume-test";
process.env.OPENAI_VISION_MODEL = "";
process.env.MODEL_RETRY_BASE_MS = "1";
const fetchBefore = globalThis.fetch;
after(async () => {
  globalThis.fetch = fetchBefore;
  database().sqlite.close();
  await rm(dir, { recursive: true, force: true });
});
const tree = {
  chapters: [
    {
      title: "Concepts",
      knowledgePoints: [
        { title: "Concept A", pages: [1, 2] },
        { title: "Concept B", pages: [3, 4] },
      ],
    },
  ],
};
function response(raw: string) {
  return Response.json({
    choices: [{ message: { content: raw } }],
    usage: { total_tokens: 10 },
  });
}
async function run(courseId: string) {
  const job = enqueueImport(courseId);
  assert.equal(enqueueImport(courseId).id, job.id);
  assert.equal(claimJob(courseId)?.id, job.id);
  await importJob(job.id);
  return courseContent(courseId);
}
test("知识点数量随页数变化，拒绝非概念条目、页段交错、重复和遗漏", () => {
  assert.deepEqual(knowledgePointRange(148), { min: 8, max: 20 });
  assert.ok(structureSchema(4).safeParse(tree).success);
  for (const points of [
    [{ title: "习题讲解", pages: [1, 2, 3, 4] }],
    [
      { title: "A", pages: [1, 3] },
      { title: "B", pages: [2, 4] },
    ],
    [
      { title: "A", pages: [1, 2] },
      { title: "B", pages: [2, 3, 4] },
    ],
    [{ title: "A", pages: [1, 2, 3] }],
  ])
    assert.equal(
      structureSchema(4).safeParse({
        chapters: [{ title: "C", knowledgePoints: points }],
      }).success,
      false,
    );
  assert.match(structurePrompt(148), /8–20/);
  assert.equal(
    fallbackKnowledgePointTitle(["Questions", "小结", "Concept A"], 0),
    "Concept A",
  );
  assert.equal(
    fallbackKnowledgePointTitle(["习题讲解", "Summary"], 0),
    "课程概念 1（待核对）",
  );
});
test("从讲义和习题写入故障续跑，保留页图/原文/审核内容并跳过完成项；CLI 隔离课程", async () => {
  const calls: string[] = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    const task = body.messages[0].content.match(/TASK:(\w+)/)[1];
    const prompt = body.messages[1].content;
    calls.push(
      task === "textbook"
        ? `${task}:${prompt.match(/知识点 (K\d+)/)[1]}`
        : task,
    );
    if (task === "structure") return response(JSON.stringify(tree));
    if (task === "notes")
      return response(
        '{"title":"Concept","points":["Learning point"],"keys":[]}',
      );
    if (task === "textbook")
      return response(String.raw`{"content_md":"Formula $\alpha+\beta$."}`);
    const page = Number(prompt.match(/原文：\[\{"page":(\d+)/)[1]);
    return response(
      JSON.stringify({
        questions: [
          {
            type: "short",
            prompt: `Original exercise ${page}`,
            sourcePage: page,
            pages: [],
          },
        ],
      }),
    );
  };
  const course = createCourse({ title: "Original resumable course" });
  saveSource(
    course.id,
    "slides",
    "slides.pdf",
    makePdf(Array.from({ length: 4 }, (_, i) => [`Concept ${i + 1}`])),
  );
  saveSource(
    course.id,
    "question_bank",
    "exercises.pdf",
    makePdf(
      Array.from({ length: 7 }, (_, i) => [
        `QUESTION ${i + 1}. Explain the concept.`,
      ]),
    ),
  );
  const { sqlite, db } = database();
  sqlite.exec(`CREATE TEMP TRIGGER fail_lecture BEFORE UPDATE OF content_md ON knowledge_points
    WHEN OLD.course_id = '${course.id}' AND OLD.code = 'K2'
    BEGIN SELECT RAISE(ABORT, 'temporary lecture storage failure'); END;`);
  const failed = await run(course.id);
  assert.equal(failed.course.status, "failed");
  assert.equal(failed.jobs[0].status, "failed");
  assert.equal(failed.pages.length, 4);
  assert.equal(failed.pages.filter((p) => p.note).length, 4);
  assert.ok(failed.knowledgePoints[0].contentMd);
  assert.equal(failed.knowledgePoints[1].contentMd, "");
  const imageTimes = await Promise.all(
    failed.pages.map(
      async (p) => (await stat(storagePath(p.imageKey))).mtimeMs,
    ),
  );
  const before = calls.length;
  sqlite.exec("DROP TRIGGER fail_lecture");
  // A reviewed lecture must be retained as-is.
  db.update(courses)
    .set({ persona: "Retained course setting" })
    .where(eq(courses.id, course.id))
    .run();
  sqlite.exec(`CREATE TEMP TRIGGER fail_batch BEFORE INSERT ON questions
    WHEN NEW.course_id = '${course.id}' AND json_extract(NEW.source, '$.page') = 7
    BEGIN SELECT RAISE(ABORT, 'temporary batch storage failure'); END;`);
  const partial = await run(course.id);
  assert.equal(partial.jobs[0].status, "failed");
  assert.deepEqual(calls.slice(before), [
    "textbook:K2",
    "questions",
    "questions",
  ]);
  assert.equal(partial.questions.length, 1);
  assert.equal(
    partial.importItems.filter((i) => i.key.startsWith("questions:")).length,
    1,
  );
  sqlite.exec("DROP TRIGGER fail_batch");
  const secondBefore = calls.length;
  const resumed = await run(course.id);
  assert.equal(resumed.jobs[0].status, "done");
  assert.equal(resumed.course.status, "ready");
  assert.equal(resumed.course.persona, "Retained course setting");
  assert.deepEqual(calls.slice(secondBefore), ["questions"]);
  assert.deepEqual(resumed.pages, partial.pages);
  assert.deepEqual(resumed.knowledgePoints, partial.knowledgePoints);
  assert.equal(resumed.questions.length, 2);
  assert.equal(resumed.questions[0].id, partial.questions[0].id);
  assert.deepEqual(
    await Promise.all(
      resumed.pages.map(
        async (p) => (await stat(storagePath(p.imageKey))).mtimeMs,
      ),
    ),
    imageTimes,
  );
  assert.equal(resumed.jobs[0].costTokens, 10);
  // Real CLI invocation must claim this course, not an unrelated queued job.
  const other = createCourse({ title: "Other isolated course" });
  saveSource(other.id, "slides", "other.pdf", makePdf([["Other concept"]]));
  const otherJob = enqueueImport(other.id);
  db.update(courses)
    .set({ status: "failed" })
    .where(eq(courses.id, course.id))
    .run();
  const cli = await promisify(execFile)(
    process.execPath,
    ["--import", "tsx", "scripts/resume-import.ts", course.id],
    { env: process.env },
  );
  assert.match(cli.stdout, /done/);
  assert.equal(courseContent(other.id).jobs[0].id, otherJob.id);
  assert.equal(courseContent(other.id).jobs[0].status, "queued");
  assert.deepEqual(courseContent(course.id).pages, resumed.pages);
  assert.equal(courseContent(course.id).questions.length, 2);
  assert.equal(courseContent(course.id).jobs[0].costTokens, 0);
});
test("所有模型步骤持续非法 JSON 时逐项降级并标待核对，空习题批次也有检查点", async () => {
  const calls: Record<string, number> = {};
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    const task = body.messages[0].content.match(/TASK:(\w+)/)[1];
    calls[task] = (calls[task] || 0) + 1;
    return response('{"broken":');
  };
  const course = createCourse({ title: "Original fallback course" });
  saveSource(
    course.id,
    "slides",
    "slides.pdf",
    makePdf([["Concept A"], ["Concept B"]]),
  );
  saveSource(
    course.id,
    "question_bank",
    "exercises.pdf",
    makePdf([["No numbered exercise can be extracted."]]),
  );
  const result = await run(course.id);
  assert.equal(result.jobs[0].status, "done");
  assert.equal(calls.structure, 3);
  assert.equal(calls.notes, 6);
  assert.equal(calls.textbook, 3);
  assert.equal(calls.questions, 3);
  assert.ok(result.pages.every((p) => p.note?.qaStatus === "needs_review"));
  assert.ok(
    result.knowledgePoints.every((kp) => kp.contentMd.includes("待核对")),
  );
  assert.equal(result.questions.length, 0);
  assert.equal(
    result.importItems.filter((i) => i.status === "needs_review").length,
    3,
  );
  const count = Object.values(calls).reduce((a, b) => a + b, 0);
  await run(course.id);
  assert.equal(
    Object.values(calls).reduce((a, b) => a + b, 0),
    count,
  );
});

test("单项讲义和习题批次最终解析失败后仍处理后续项", async () => {
  const calls: Record<string, number> = {};
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    const task = body.messages[0].content.match(/TASK:(\w+)/)[1];
    const prompt = body.messages[1].content;
    let key = task;
    if (task === "textbook") key += ":" + prompt.match(/知识点 (K\d+)/)[1];
    if (task === "questions")
      key += ":" + prompt.match(/原文：\[\{"page":(\d+)/)[1];
    calls[key] = (calls[key] || 0) + 1;
    if (task === "structure") return response(JSON.stringify(tree));
    if (task === "notes")
      return response(
        '{"title":"Concept","points":["Learning point"],"keys":[]}',
      );
    if (key === "textbook:K1" || key === "questions:1")
      return response('{"unfinished":');
    if (task === "textbook")
      return response(
        String.raw`{"content_md":"Verified source formula $\alpha$."}`,
      );
    return response(
      '{"questions":[{"type":"short","prompt":"Final original exercise","sourcePage":7}]}',
    );
  };
  const course = createCourse({ title: "Original per-item fallback course" });
  saveSource(
    course.id,
    "slides",
    "slides.pdf",
    makePdf(Array.from({ length: 4 }, (_, i) => [`Concept ${i + 1}`])),
  );
  saveSource(
    course.id,
    "question_bank",
    "questions.pdf",
    makePdf(
      Array.from({ length: 7 }, (_, i) => [
        `QUESTION ${i + 1}. Explain this original concept.`,
      ]),
    ),
  );
  const result = await run(course.id);
  assert.equal(result.jobs[0].status, "done");
  assert.equal(calls["textbook:K1"], 3);
  assert.equal(calls["textbook:K2"], 1);
  assert.equal(calls["questions:1"], 3);
  assert.equal(calls["questions:7"], 1);
  assert.match(result.knowledgePoints[0].contentMd, /待核对/);
  assert.match(result.knowledgePoints[1].contentMd, /Verified source formula/);
  assert.equal(result.questions.length, 7);
  assert.ok(
    result.questions.some((q) => q.prompt === "Final original exercise"),
  );
  assert.equal(
    result.importItems.filter((i) => i.status === "needs_review").length,
    2,
  );
});
