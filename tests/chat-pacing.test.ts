import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import {
  chapters,
  courses,
  knowledgePoints,
  pages,
  sources,
} from "../src/db/schema";
import { courseContent, createCourse } from "../src/lib/courses";
import { buildPrompt } from "../src/lib/prompt";
import { createChatParser, type StreamEvent } from "../src/lib/chat-protocol";
import { checkChatPacing, pacedChat } from "../src/lib/chat-pacing";
import { MAX_GUIDANCE_CHARS, guidanceStats } from "../src/lib/pacing";
import { POST } from "../src/app/api/courses/[courseId]/chat/route";
import { readSseData } from "../src/lib/sse";
import { runPacingCheck } from "../scripts/pacing-check.mjs";

const dir = mkdtempSync(path.join(tmpdir(), "tap-pacing-test-"));
process.env.DATA_DIR = dir;
const originalFetch = globalThis.fetch;
after(() => {
  globalThis.fetch = originalFetch;
  database().sqlite.close();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  process.env.MODEL_PROVIDER = "openai-compatible";
  process.env.CHAT_MODEL_PROVIDER = "openai-compatible";
  process.env.OPENAI_BASE_URL = "http://pacing-model.test/v1";
  process.env.OPENAI_CHAT_MODEL = "mock-pacing";
  process.env.CHAT_PACING_REPAIR = "on";
});
const course = createCourse({
  title: "通用方法练习",
  subject: "示例",
  persona: "耐心引导",
});
const { db } = database();
db.update(courses)
  .set({ status: "ready" })
  .where(eq(courses.id, course.id))
  .run();
db.insert(chapters)
  .values({ id: "chapter", courseId: course.id, title: "方法", order: 0 })
  .run();
db.insert(knowledgePoints)
  .values({
    id: "kp",
    courseId: course.id,
    chapterId: "chapter",
    code: "TOPIC-A",
    title: "适用条件",
    order: 0,
    keywords: [],
    contentMd: "先检查方法的适用条件。",
    hasSlides: true,
  })
  .run();
db.insert(sources)
  .values({
    id: "source",
    courseId: course.id,
    kind: "slides",
    filename: "fixture.pdf",
    mime: "application/pdf",
    sha256: "fixture",
    storageKey: "fixture.pdf",
  })
  .run();
db.insert(pages)
  .values({
    id: "page",
    courseId: course.id,
    sourceId: "source",
    index: 1,
    sourcePage: 1,
    imageKey: "fixture.png",
    width: 1,
    height: 1,
    rawText: "检查条件后再选用方法。",
    title: "条件与方法",
    kpId: "kp",
  })
  .run();
const calc = {
  kind: "calc",
  prompt: "请填写当前一步的中间量。",
  fields: [{ key: "s", label: "中间量" }],
  topic: "TOPIC-A",
};
const cardFence = (card: unknown, label = "card") =>
  `\n\`\`\`${label}\n${JSON.stringify(card)}\n\`\`\``;
function parse(raw: string, chunk = raw.length) {
  const events: StreamEvent[] = [];
  const parser = createChatParser((e) => events.push(e), 1);
  for (let i = 0; i < raw.length; i += chunk)
    parser.push(raw.slice(i, i + chunk));
  parser.end();
  return events;
}
function sse(raw: string) {
  return new Response(
    new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        for (const c of raw)
          controller.enqueue(
            encoder.encode(
              `data: ${JSON.stringify({ choices: [{ delta: { content: c } }] })}\n\n`,
            ),
          );
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    }),
    { headers: { "Content-Type": "text/event-stream" } },
  );
}
async function collect(generator: AsyncIterable<string>) {
  let text = "";
  for await (const delta of generator) text += delta;
  return text;
}

test("mock 模型收到课程动态资料、节奏规则与通用格式示例，合规输出不额外请求", async () => {
  const prompt = buildPrompt(courseContent(course.id), 1);
  let calls = 0;
  globalThis.fetch = async (_, init) => {
    calls++;
    const input = JSON.parse(init!.body as string);
    assert.equal(input.model, "mock-pacing");
    const system = input.messages[0].content;
    for (const rule of [
      "1–2 句",
      "一次只问一个问题",
      "每轮最多一张卡片",
      "最多拆 3 步",
      "最多连续问 2 张",
      "阶段小结",
      "先肯定",
      "不说“你错了”",
      "回复首行必须输出判定行",
      "不出卡片",
      "缺条件 → data",
      "计算步骤 → calc",
      "choice 或 truefalse",
      "不直接给最终答案",
    ])
      assert.ok(system.includes(rule), rule);
    for (const value of [
      course.title,
      "TOPIC-A",
      "检查条件后再选用方法。",
      "耐心引导",
      "待核对",
      "<course_materials>",
    ])
      assert.ok(system.includes(value), value);
    return sse("我们先做一个中间步骤。" + cardFence(calc));
  };
  const result = await collect(
    pacedChat(
      [
        { role: "system", content: prompt },
        { role: "user", content: "已知条件求解" },
      ],
      AbortSignal.timeout(5000),
      "openai-compatible:mock-pacing",
      1,
    ),
  );
  assert.equal(parse(result).filter((e) => e.type === "card").length, 1);
  assert.equal(calls, 1);
  const other = createCourse({ title: "另一门通用课程" });
  const otherPrompt = buildPrompt(courseContent(other.id));
  assert.ok(!otherPrompt.includes(course.title));
  assert.ok(!otherPrompt.includes("TOPIC-A"));
  assert.ok(otherPrompt.includes("有效页码：[]"));
});

test("协议只保留首张有效卡片，兼容 card/json/无标签围栏与任意 delta 边界", () => {
  for (const label of ["card", "json", ""]) {
    const raw =
      "[判定] 对·TOPIC-A·方法选择有依据\n这一步抓住了条件。" +
      cardFence(calc, label) +
      cardFence({ kind: "truefalse", prompt: "第二问" }) +
      cardFence(calc, "json");
    for (const size of [1, 2, 7, raw.length]) {
      const events = parse(raw, size);
      const cards = events.filter((e) => e.type === "card");
      assert.equal(cards.length, 1);
      assert.deepEqual(cards[0].card, calc);
      assert.deepEqual(events[0], {
        type: "verdict",
        correct: true,
        topic: "TOPIC-A",
        reason: "方法选择有依据",
      });
    }
  }
  const events = parse("```card\n{bad}\n```" + cardFence(calc));
  assert.equal(events.filter((e) => e.type === "card").length, 1);
});

test("正文兜底保留首个问题并限制长度，不截断卡片/普通代码或误判行内公式", () => {
  const raw =
    "公式 $x=?$ 与 $$y=?$$，代码 `x?`。先看哪里？第二个问题？" +
    cardFence(calc);
  for (const size of [1, 3, raw.length]) {
    const events = parse(raw, size);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("");
    assert.equal(text, "公式 $x=?$ 与 $$y=?$$，代码 `x?`。先看哪里？");
    assert.equal(events.filter((e) => e.type === "card").length, 1);
  }
  const events = parse("引导".repeat(300) + cardFence(calc), 1);
  assert.equal(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("").length,
    MAX_GUIDANCE_CHARS,
  );
  assert.equal(events.filter((e) => e.type === "card").length, 1);
  assert.equal(
    parse("```js\nconst q = '?'\n```").find((e) => e.type === "text")?.delta,
    "```js\nconst q = '?'\n```",
  );
  assert.deepEqual(guidanceStats("第一句。第二句。"), {
    chars: 8,
    questions: 0,
    sentences: 2,
  });
});

test("服务端违规仅重写一次，初稿不泄漏到 SSE，使用相同模型", async () => {
  let calls = 0;
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    assert.equal(body.model, "mock-pacing");
    if (++calls === 1)
      return sse(
        "初稿".repeat(180) +
          "问题一？问题二？" +
          cardFence(calc) +
          cardFence(calc),
      );
    assert.ok(body.messages.at(-1).content.includes("请只重写上一条助教回复"));
    return sse("我们先完成一个中间步骤。" + cardFence(calc));
  };
  const response = await POST(
    new Request("http://local/chat", {
      method: "POST",
      body: JSON.stringify({
        messages: [{ role: "user", content: "引导求解" }],
        pageContext: { page: 1 },
        model: "openai-compatible:mock-pacing",
      }),
    }),
    { params: Promise.resolve({ courseId: course.id }) },
  );
  const events = [];
  for await (const event of readSseData(response.body!))
    events.push(JSON.parse(event));
  assert.equal(calls, 2);
  assert.equal(events.filter((e) => e.type === "card").length, 1);
  assert.ok(!JSON.stringify(events).includes("初稿"));
  assert.equal(events.at(-1).type, "done");
});

test("修正仍违规或失败时有限兜底；开关关闭不修正；取消不发后续请求", async () => {
  const bad = "先看哪里？再看哪里？" + cardFence(calc) + cardFence(calc);
  let calls = 0;
  const generate = async function* () {
    calls++;
    yield bad;
  };
  const messages = [{ role: "user" as const, content: "求解" }];
  let result = await collect(
    pacedChat(messages, AbortSignal.timeout(5000), null, 1, {
      repair: true,
      generate,
    }),
  );
  assert.equal(calls, 2);
  assert.equal(parse(result).filter((e) => e.type === "card").length, 1);
  calls = 0;
  const failure = async function* () {
    if (++calls === 2) throw new Error("unavailable");
    yield bad;
  };
  result = await collect(
    pacedChat(messages, AbortSignal.timeout(5000), null, 1, {
      repair: true,
      generate: failure,
    }),
  );
  assert.equal(result, bad);
  assert.equal(calls, 2);
  calls = 0;
  process.env.CHAT_PACING_REPAIR = "off";
  assert.equal(
    await collect(
      pacedChat(messages, AbortSignal.timeout(5000), null, 1, { generate }),
    ),
    bad,
  );
  assert.equal(calls, 1);
  const controller = new AbortController();
  calls = 0;
  const cancel = async function* () {
    calls++;
    controller.abort();
    yield bad;
  };
  await assert.rejects(
    collect(
      pacedChat(messages, controller.signal, null, 1, {
        repair: true,
        generate: cancel,
      }),
    ),
    { name: "AbortError" },
  );
  assert.equal(calls, 1);
});

test("缺判定触发修正，待核对保留为文本而非错误判分", () => {
  assert.ok(
    checkChatPacing("先看条件。", 1, true).issues.some((i) =>
      i.includes("判定"),
    ),
  );
  const raw =
    "[判定] 待核对·TOPIC-A·缺少已核对的依据，暂不判分\n我们先确认资料中的适用条件。";
  assert.deepEqual(checkChatPacing(raw, 1, true).issues, []);
  assert.equal(parse(raw, 1).filter((e) => e.type === "verdict").length, 0);
  assert.ok(
    parse(raw, 1)
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("")
      .startsWith("[判定] 待核对"),
  );
});

test("空白、损坏或丢失判定的修正不能覆盖已有判定，不再重试", async () => {
  const original =
    "[判定] 对·TOPIC-A·方法有依据\n" + "点评".repeat(200) + cardFence(calc);
  for (const correction of [
    "",
    "```card\n{bad}\n```",
    "我们先核对一个步骤。" + cardFence(calc),
  ]) {
    let calls = 0;
    const generate = async function* () {
      yield ++calls === 1 ? original : correction;
    };
    const result = await collect(
      pacedChat(
        [{ role: "user", content: "我填写的数据：中间量 = 5" }],
        AbortSignal.timeout(5000),
        null,
        1,
        { repair: true, generate },
      ),
    );
    assert.equal(calls, 2);
    assert.equal(result, original);
    assert.equal(parse(result)[0].type, "verdict");
  }
});

test("pacing 脚本通过真实课程路由和 mock SSE，验证卡片类型、判定及多轮预算", async () => {
  globalThis.fetch = async (_, init) => {
    const body = JSON.parse(init!.body as string);
    const text = body.messages.at(-1).content;
    const previousCards = body.messages.filter(
      (m: { role: string; content: string }) =>
        m.role === "assistant" && m.content.includes("[我上一轮给出的卡片]"),
    );
    if (text.includes("请只讲解"))
      return sse("适用条件决定一种方法能否使用。先检查条件，再说明选择依据。");
    if (text.includes("b 未给出"))
      return sse(
        "我们先补齐缺失的量。" +
          cardFence({
            kind: "data",
            prompt: "请填 b。",
            fields: [{ key: "b", label: "b" }],
          }),
      );
    if (text.includes("概念判断练习"))
      return sse(
        "我们只确认这个概念。" +
          cardFence({ kind: "truefalse", prompt: "使用方法需要检查条件。" }),
      );
    if (!previousCards.length)
      return sse("先算一个中间步骤。" + cardFence(calc));
    const verdict = "[判定] 对·TOPIC-A·这一步的方法有依据\n";
    return sse(
      previousCards.length === 1
        ? verdict + "我们再检查一个步骤。" + cardFence(calc)
        : verdict + "我们已经确认了条件与中间步骤。这一阶段先停在这里。",
    );
  };
  const logs: string[] = [];
  const result = await runPacingCheck({
    courseId: course.id,
    baseUrl: "http://local/prefix",
    model: "openai-compatible:mock-pacing",
    log: (line: string) => logs.push(line),
    fetcher: async (url, init) => {
      assert.ok(
        typeof url === "string" &&
          url.endsWith(`/api/courses/${course.id}/chat`),
      );
      return POST(new Request(url, init), {
        params: Promise.resolve({ courseId: course.id }),
      });
    },
  });
  assert.deepEqual(result, { turns: 6, solveCards: 2 });
  assert.match(logs.at(-1)!, /PACING PASS/);
});
