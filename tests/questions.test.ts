import test, { after } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  stat,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import Database from "better-sqlite3";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import {
  chapters,
  knowledgePoints,
  pages,
  pageNotes,
  questions,
  sources,
  courses,
  jobs,
} from "../src/db/schema";
import {
  createCourse,
  saveSource,
  courseContent,
  restartQuestionSteps,
  enqueueImport,
} from "../src/lib/courses";
import {
  runQuestionExtraction,
  runQuestionAnswers,
  questionSimilarity,
} from "../src/lib/import-questions";
import {
  questionBoundaries,
  ruleQuestion,
  stripQuestionNumber,
  normalizeQuestion,
} from "../src/lib/question-parser";
import {
  importQuestionBatch,
  importQuestionConcurrency,
  importQuestionKpThreshold,
} from "../src/lib/import-settings";
import { claimJob, importJob } from "../src/lib/importer";
import { makePdf } from "../scripts/generate-samples.mjs";
import { storagePath } from "../src/lib/storage";

const dir = await mkdtemp(path.join(tmpdir(), "tap-questions-test-"));
process.env.DATA_DIR = dir;
process.env.MODEL_PROVIDER = "agnes";
process.env.AGNES_BASE_URL = "http://model.test/v1";
process.env.AGNES_CHAT_MODEL = "question-test";
process.env.MODEL_RETRY_BASE_MS = "1";
const originalFetch = globalThis.fetch;
after(async () => {
  globalThis.fetch = originalFetch;
  database().sqlite.close();
  await rm(dir, { recursive: true, force: true });
});
const response = (data: unknown) =>
  Response.json({
    choices: [
      {
        message: {
          content: typeof data === "string" ? data : JSON.stringify(data),
        },
      },
    ],
    usage: { total_tokens: 5 },
  });
const hooks = () => {
  const progress: string[] = [];
  let tokens = 0;
  return {
    progress,
    get tokens() {
      return tokens;
    },
    callbacks: {
      progress: (_: number, step: string) => {
        progress.push(step);
      },
      tokens: (amount: number) => {
        tokens += amount;
      },
    },
  };
};
function fixture() {
  const course = createCourse({ title: "Original general lesson" });
  const source = saveSource(
    course.id,
    "slides",
    "lesson.pdf",
    makePdf([["Rate and distance"]]),
  );
  const bank = saveSource(
    course.id,
    "question_bank",
    "original.pdf",
    makePdf([["QUESTION 1. Compute a rate."]]),
  );
  const { db } = database();
  const chapter = `${course.id}-chapter`,
    kp = `${course.id}-kp`,
    page = `${course.id}-page`;
  db.insert(chapters)
    .values({ id: chapter, courseId: course.id, order: 0, title: "变化" })
    .run();
  db.insert(knowledgePoints)
    .values({
      id: kp,
      courseId: course.id,
      chapterId: chapter,
      order: 0,
      code: "K1",
      title: "速率",
      keywords: ["速率", "距离", "rate"],
      contentMd: "匀速运动距离等于速率乘以时间，s=vt。",
      hasSlides: true,
    })
    .run();
  db.insert(pages)
    .values({
      id: page,
      courseId: course.id,
      sourceId: source.id,
      index: 1,
      sourcePage: 1,
      imageKey: `courses/${course.id}/page.png`,
      width: 1,
      height: 1,
      rawText: "s=vt",
      title: "速率",
      kpId: kp,
    })
    .run();
  db.insert(pageNotes)
    .values({
      pageId: page,
      title: "速率",
      points: ["距离除以时间得到速率"],
      keys: ["速率"],
      model: "test",
      qaStatus: "passed",
    })
    .run();
  db.update(courses)
    .set({ status: "ready" })
    .where(eq(courses.id, course.id))
    .run();
  return { course, source, bank, kp };
}
function insertQuestion(
  f: ReturnType<typeof fixture>,
  code: string,
  extra: Partial<typeof questions.$inferInsert> = {},
) {
  return database()
    .db.insert(questions)
    .values({
      id: `${f.course.id}-${code}`,
      courseId: f.course.id,
      code,
      type: "calc",
      prompt: "速率为 2 m/s，时间为 3 s，计算距离。",
      kpId: f.kp,
      pageIds: [],
      source: { sourceId: f.bank.id, page: 1 },
      confidence: "low",
      ...extra,
    })
    .returning()
    .get();
}

test("选项多种标记、全角、行内多选项、公式与题号清理", () => {
  for (const [a, b, c, d] of [
    ["A.", "B.", "C.", "D."],
    ["A．", "B．", "C．", "D．"],
    ["A、", "B、", "C、", "D、"],
    ["（A）", "（B）", "（C）", "（D）"],
    ["(A)", "(B)", "(C)", "(D)"],
    ["Ａ．", "Ｂ．", "Ｃ．", "Ｄ．"],
  ]) {
    for (const separator of [" ", "\n", ""]) {
      const q = normalizeQuestion({
        type: "short",
        prompt: `12．表达式 $x^2+\\alpha$ 等于？\n${a} $x$${separator}${b} $x^2$${separator}${c} $\\alpha$${separator}${d} 以上皆非`,
      });
      assert.equal(q.type, "choice");
      assert.equal(q.prompt, "表达式 $x^2+\\alpha$ 等于？");
      assert.deepEqual(
        q.options?.map((o) => o.id),
        ["A", "B", "C", "D"],
      );
      assert.equal(q.options?.[2].text, "$\\alpha$");
    }
  }
  for (const prefix of [
    "1.",
    "２．",
    "3、",
    "4)",
    "（5）",
    "(6)",
    "Q7:",
    "QUESTION 8.",
  ])
    assert.equal(stripQuestionNumber(`${prefix} 通用题干`), "通用题干");
  const math = normalizeQuestion({
    prompt: "1. 比较 $P(A)+P(B)$ 与 $A.B.$，再说明含义。",
  });
  assert.equal(math.type, "short");
  assert.equal(math.prompt, "比较 $P(A)+P(B)$ 与 $A.B.$，再说明含义。");
  assert.equal(
    stripQuestionNumber("1.25 m/s 表示什么？"),
    "1.25 m/s 表示什么？",
  );
});
test("大题标题传递类型、跨页题目边界、不截断题库与五类题型", () => {
  const boundaries = questionBoundaries([
    {
      text: "一、单项选择题\n1. 选择一个数。\nA. 1 B. 2\n二、判断题\n1. 数值可以为零。",
    },
    {
      text: "说明：此行仍属于上页判断题。\n三、填空题\n1. 结果为____。\n四、计算题\n1. 已知 s=vt，求 s。\n五、简答题\n1. 说明一种观察方法。",
    },
  ]);
  assert.deepEqual(
    boundaries.map((q) => ruleQuestion(q).type),
    ["choice", "truefalse", "fill", "calc", "short"],
  );
  assert.match(boundaries[1].text, /上页判断题/);
  assert.deepEqual(
    boundaries.map((q) => q.page),
    [1, 1, 2, 2, 2],
  );
  assert.equal(
    questionBoundaries([
      {
        text: Array.from({ length: 260 }, (_, i) => `${i + 1}. 自拟问题`).join(
          "\n",
        ),
      },
    ]).length,
    260,
  );
  assert.equal(normalizeQuestion({ prompt: "计算 2+3。" }).type, "calc");
});
test("习题配置默认值与无效输入回退", () => {
  for (const key of [
    "IMPORT_QUESTION_BATCH",
    "IMPORT_QUESTION_CONCURRENCY",
    "IMPORT_QUESTION_KP_THRESHOLD",
  ])
    delete process.env[key];
  assert.equal(importQuestionBatch(), 10);
  assert.equal(importQuestionConcurrency(), 4);
  assert.equal(importQuestionKpThreshold(), 0.7);
  process.env.IMPORT_QUESTION_BATCH = "0";
  process.env.IMPORT_QUESTION_CONCURRENCY = "NaN";
  process.env.IMPORT_QUESTION_KP_THRESHOLD = "-1";
  assert.equal(importQuestionBatch(), 10);
  assert.equal(importQuestionConcurrency(), 4);
  assert.equal(importQuestionKpThreshold(), 0.7);
  process.env.IMPORT_QUESTION_BATCH = "2";
  process.env.IMPORT_QUESTION_CONCURRENCY = "2";
  delete process.env.IMPORT_QUESTION_KP_THRESHOLD;
});
test("按题分批并发、失败批重试后独立降级、进度按批与持久化跳过", async () => {
  const f = fixture(),
    other = fixture();
  let active = 0,
    maxActive = 0;
  const calls: Record<string, number> = {};
  globalThis.fetch = async (url, init) => {
    assert.equal(String(url), "http://model.test/v1/chat/completions");
    const body = JSON.parse(init!.body as string),
      prompt = body.messages[1].content;
    const original = JSON.parse(prompt.split("\n原文：")[1]);
    assert.equal(body.model, "question-test");
    assert.match(prompt, /速率/);
    assert.match(prompt, /距离等于/);
    const id = original[0].id;
    calls[id] = (calls[id] || 0) + 1;
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 15));
    active--;
    if (id === "3") return response('{"unfinished":');
    return response({
      questions: original.map(
        (q: { id: string; text: string; page: number }) => ({
          sourceQuestionId: q.id,
          type: "short",
          prompt: q.text,
          kpId: q.id === "1" ? f.kp : other.kp,
          kpConfidence: q.id === "5" ? 0.4 : 0.95,
          pages: [1],
          sourcePage: q.page,
        }),
      ),
    });
  };
  const h = hooks();
  const source = [
    {
      sourceId: f.bank.id,
      pages: [
        {
          text: "一、单项选择题\n1. 速率等于什么？ A．距离除以时间 B．距离乘以时间\n二、判断题\n2. 速率有单位。\n3. 时间可测量。\n4. 速率与时间有关。\n5. 另一概念。",
        },
      ],
    },
  ];
  await runQuestionExtraction(f.course.id, source, h.callbacks);
  assert.equal(maxActive, 2);
  assert.deepEqual(calls, { "1": 1, "3": 3, "5": 1 });
  assert.equal(h.progress.length, 3);
  assert.match(h.progress[2], /3\/3 批/);
  const content = courseContent(f.course.id);
  assert.equal(content.questions.length, 5);
  assert.equal(
    content.questions.find((q) => q.type === "choice")?.options?.length,
    2,
  );
  assert.equal(content.questions.filter((q) => q.kpId === f.kp).length, 1);
  assert.ok(
    content.questions.filter((q) => !q.kpId).every((q) => !q.pageIds.length),
  );
  assert.equal(
    content.importItems.filter((i) => i.status === "needs_review").length,
    1,
  );
  await runQuestionExtraction(f.course.id, source, h.callbacks);
  assert.deepEqual(calls, { "1": 1, "3": 3, "5": 1 });
  assert.equal(courseContent(f.course.id).questions.length, 5);
  assert.ok(
    questionSimilarity("速率距离", "速率与距离") >
      questionSimilarity("速率距离", "色彩形状"),
  );
});
test("模型遗漏题目触发批重试，规则恢复全部原题", async () => {
  const f = fixture();
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response({ questions: [] });
  };
  await runQuestionExtraction(
    f.course.id,
    [
      {
        sourceId: f.bank.id,
        pages: [{ text: "1. 解释一个概念。\n2. 说明一个现象。" }],
      },
    ],
    hooks().callbacks,
  );
  assert.equal(calls, 3);
  assert.equal(courseContent(f.course.id).questions.length, 2);
});
test("低置信度和无匹配保持未关联，规则类型与选项修复模型输出", async () => {
  const f = fixture();
  globalThis.fetch = async (_, init) => {
    const original = JSON.parse(
      JSON.parse(init!.body as string).messages[1].content.split("\n原文：")[1],
    );
    return response({
      questions: original.map((q: { id: string; text: string }) => ({
        sourceQuestionId: q.id,
        type: "short",
        prompt: q.text,
        kpId: q.id === "1" ? f.kp : null,
        kpConfidence: q.id === "1" ? 0.2 : 0.99,
        answer: "A",
      })),
    });
  };
  await runQuestionExtraction(
    f.course.id,
    [
      {
        sourceId: f.bank.id,
        pages: [{ text: "1. 色彩的组合？ A、红 B、蓝\n2. 计算面积。" }],
      },
    ],
    hooks().callbacks,
  );
  const result = courseContent(f.course.id).questions;
  assert.ok(result.every((q) => q.kpId === null && q.pageIds.length === 0));
  assert.ok(
    result.every((q) => !q.answer),
    "原文缺答案时不可用模型抽取响应绕过独立推导",
  );
  assert.deepEqual(
    result.map((q) => q.type),
    ["choice", "calc"],
  );
});
test("独立答案两轮一致、不同提示/温度、已有答案跳过及续跑", async () => {
  const f = fixture();
  insertQuestion(f, "Q-001");
  insertQuestion(f, "Q-002", {
    answer: "Original answer",
    answerMethod: "source",
  });
  const bodies: any[] = [];
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    bodies.push(body);
    return response({ answer: "6 m", analysis: "依据 s=vt，代入得到 6 m。" });
  };
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  assert.equal(bodies.length, 2);
  assert.notEqual(bodies[0].temperature, bodies[1].temperature);
  assert.notEqual(bodies[0].messages[1].content, bodies[1].messages[1].content);
  assert.ok(
    bodies.every(
      (b) =>
        b.model === "question-test" &&
        !b.messages[1].content.includes("候选：") &&
        b.messages[1].content.includes("距离除以时间"),
    ),
  );
  const result = courseContent(f.course.id).questions.find(
    (q) => q.code === "Q-001",
  )!;
  assert.equal(result.answer, "6 m");
  assert.equal(result.confidence, "high");
  assert.equal(result.answerMethod, "consensus");
  assert.equal(result.verified, false);
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  assert.equal(bodies.length, 2);
});
test("两轮不一致需第三轮仲裁，仍标 needs_review；缺答案可独立续跑", async () => {
  const f = fixture();
  const q = insertQuestion(f, "Q-001");
  const rounds: number[] = [];
  globalThis.fetch = async (_, init) => {
    const prompt = JSON.parse(init!.body as string).messages[1].content;
    const round = Number(prompt.match(/推导轮次：(\d)/)[1]);
    rounds.push(round);
    return response({
      answer: round === 2 ? "8 m" : "6 m",
      analysis: "按课程公式验算。",
    });
  };
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  assert.deepEqual(rounds.sort(), [1, 2, 3]);
  let result = courseContent(f.course.id).questions[0];
  assert.equal(result.answer, "6 m");
  assert.equal(result.answerMethod, "arbitrated");
  assert.equal(result.reviewStatus, "needs_review");
  assert.equal(result.confidence, "low");
  database()
    .db.update(questions)
    .set({ answer: null })
    .where(eq(questions.id, q.id))
    .run();
  globalThis.fetch = async () =>
    response({ answer: null, analysis: "资料不足" });
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  assert.equal(courseContent(f.course.id).questions[0].answer, null);
  globalThis.fetch = async () =>
    response({ answer: "6 m", analysis: "依据公式" });
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  result = courseContent(f.course.id).questions[0];
  assert.equal(result.answerMethod, "consensus");
  assert.equal(result.answer, "6 m");
});
test("答案写入中断后只续跑缺答案题，不重算已保存答案", async () => {
  const f = fixture();
  const first = insertQuestion(f, "Q-001"),
    second = insertQuestion(f, "Q-002");
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return response({ answer: "6 m", analysis: "依据 s=vt。" });
  };
  const { sqlite } = database();
  sqlite.exec(
    `CREATE TEMP TRIGGER fail_answer BEFORE UPDATE OF answer ON questions WHEN OLD.id = '${second.id}' BEGIN SELECT RAISE(ABORT, 'temporary answer storage failure'); END;`,
  );
  await assert.rejects(
    runQuestionAnswers(f.course.id, hooks().callbacks),
    /storage failure/,
  );
  const saved = courseContent(f.course.id).questions.find(
    (q) => q.id === first.id,
  )!;
  assert.equal(saved.answer, "6 m");
  assert.equal(
    courseContent(f.course.id).questions.find((q) => q.id === second.id)
      ?.answer,
    null,
  );
  sqlite.exec("DROP TRIGGER fail_answer");
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  assert.equal(calls, 6);
  assert.deepEqual(
    courseContent(f.course.id).questions.find((q) => q.id === first.id),
    saved,
  );
  assert.ok(
    courseContent(f.course.id).questions.every((q) => q.answer === "6 m"),
  );
});
test("无效选项答案不能被两轮一致误判为可靠答案", async () => {
  const f = fixture();
  insertQuestion(f, "Q-001", {
    type: "choice",
    options: [
      { id: "A", text: "一" },
      { id: "B", text: "二" },
    ],
  });
  globalThis.fetch = async () =>
    response({ answer: "D", analysis: "无依据的答案" });
  await runQuestionAnswers(f.course.id, hooks().callbacks);
  assert.equal(courseContent(f.course.id).questions[0].answer, null);
});
test("CLI --from questions 清理旧自动题且只重跑习题，隔离课程；--from answers 跳过已有答案", async () => {
  const f = fixture(),
    other = fixture();
  const reviewed = insertQuestion(f, "Q-002", {
    answer: "Reviewed",
    verified: true,
    reviewStatus: "teacher_ok",
  });
  insertQuestion(f, "Q-001");
  insertQuestion(f, "Q-003", { source: "generated", answer: "Generated" });
  insertQuestion(other, "Q-001");
  const key = `courses/${f.course.id}/bank.txt`;
  await writeFile(storagePath(key), "计算题\n1. 计算 2+3。\n答案：5");
  database()
    .db.update(sources)
    .set({ textKey: key, status: "ready", pages: 1 })
    .where(eq(sources.id, f.bank.id))
    .run();
  const image = storagePath(courseContent(f.course.id).pages[0].imageKey);
  await writeFile(image, "original image placeholder");
  const imageTime = (await stat(image)).mtimeMs;
  const before = courseContent(f.course.id),
    otherBefore = courseContent(other.course.id);
  const cli = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/resume-import.ts",
      f.course.id,
      "--from",
      "questions",
    ],
    { env: { ...process.env, MODEL_PROVIDER: "none" } },
  );
  assert.match(cli.stdout, /done/);
  const result = courseContent(f.course.id);
  assert.deepEqual(result.pages, before.pages);
  assert.deepEqual(result.sources, before.sources);
  assert.deepEqual(result.chapters, before.chapters);
  assert.deepEqual(result.knowledgePoints, before.knowledgePoints);
  assert.equal((await stat(image)).mtimeMs, imageTime);
  assert.deepEqual(courseContent(other.course.id), otherBefore);
  assert.ok(!result.questions.some((q) => q.id === `${f.course.id}-Q-001`));
  assert.ok(!result.questions.some((q) => q.id === reviewed.id));
  assert.ok(
    result.questions.some(
      (q) => q.source === "generated" && q.answer === "Generated",
    ),
  );
  assert.equal(
    result.questions.find((q) => q.prompt === "计算 2+3。")?.answer,
    "5",
  );
  const answers = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      "tsx",
      "scripts/resume-import.ts",
      f.course.id,
      "--from",
      "answers",
    ],
    { env: { ...process.env, MODEL_PROVIDER: "none" } },
  );
  assert.match(answers.stdout, /done/);
  assert.deepEqual(courseContent(f.course.id).questions, result.questions);
});
test("已有活跃任务时不删除习题；定向失败续跑保留步骤与已完成题目", async () => {
  const f = fixture();
  insertQuestion(f, "Q-001", { answer: "Source answer" });
  const active = restartQuestionSteps(f.course.id, "answers");
  const before = courseContent(f.course.id);
  assert.throws(
    () => restartQuestionSteps(f.course.id, "questions"),
    /活跃导入任务/,
  );
  assert.deepEqual(courseContent(f.course.id), before);
  database()
    .db.update(jobs)
    .set({ status: "failed" })
    .where(eq(jobs.id, active.id))
    .run();
  const resumed = enqueueImport(f.course.id);
  assert.equal(resumed.type, "import:answers");
  assert.equal(claimJob(f.course.id)?.id, resumed.id);
  await importJob(resumed.id);
  assert.equal(courseContent(f.course.id).jobs[0].status, "done");
  assert.equal(courseContent(f.course.id).questions.length, 1);
});
test("SQLite 升级保留旧题、答案与引用，并允许未关联", async () => {
  const sqlite = new Database(":memory:");
  try {
    for (const name of ["0000_black_martin_li.sql", "0001_cute_black_tom.sql"])
      sqlite.exec(await readFile(path.join("drizzle", name), "utf8"));
    sqlite.exec(`INSERT INTO courses(id,slug,title,created_at) VALUES('course','course','Original','now');
      INSERT INTO chapters(id,course_id,"order",title) VALUES('chapter','course',0,'Chapter');
      INSERT INTO knowledge_points(id,course_id,chapter_id,code,title,"order",keywords) VALUES('kp','course','chapter','K1','Rate',0,'[]');
      INSERT INTO questions(id,course_id,code,type,prompt,answer,kp_id,page_ids,source,confidence) VALUES('q','course','Q1','calc','Compute','5','kp','[]','"generated"','high');`);
    sqlite.exec(await readFile("drizzle/0002_dizzy_blob.sql", "utf8"));
    const saved = sqlite.prepare("SELECT * FROM questions").get() as any;
    assert.equal(saved.answer, "5");
    assert.equal(saved.kp_id, "kp");
    assert.equal(saved.answer_method, "source");
    sqlite.exec("UPDATE questions SET kp_id=NULL");
    assert.equal(
      (sqlite.prepare("SELECT kp_id FROM questions").get() as any).kp_id,
      null,
    );
    assert.deepEqual(sqlite.pragma("foreign_key_check"), []);
  } finally {
    sqlite.close();
  }
});
