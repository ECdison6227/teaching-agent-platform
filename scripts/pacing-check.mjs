import "./env.ts";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { readSseData } from "../src/lib/sse.ts";
import { formatAnswer } from "../src/lib/cards.ts";
import { guidanceStats, MAX_GUIDANCE_CHARS } from "../src/lib/pacing.ts";

/** 只调用指定课程的聊天 API，不导入/修改课程，不保存模型原文。 */
export async function runPacingCheck({
  courseId,
  baseUrl = "http://127.0.0.1:3000",
  model,
  fetcher = fetch,
  log = console.log,
}) {
  assert.ok(
    courseId,
    "用法：npm run pacing:check -- <courseId> [baseUrl] [modelId]",
  );
  let turns = 0;
  async function turn(label, messages, answering = false) {
    const response = await fetcher(
      `${baseUrl.replace(/\/+$/, "")}/api/courses/${encodeURIComponent(courseId)}/chat`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ messages: messages.slice(-24), model }),
        signal: AbortSignal.timeout(130_000),
      },
    );
    assert.ok(
      response.ok && response.body,
      `${label}: HTTP ${response.status}`,
    );
    const events = [];
    for await (const data of readSseData(response.body))
      events.push(JSON.parse(data));
    assert.ok(
      !events.some((e) => e.type === "error"),
      `${label}: API 返回错误`,
    );
    assert.equal(events.at(-1)?.type, "done", `${label}: SSE 未正常完成`);
    const cards = events.filter((e) => e.type === "card").map((e) => e.card);
    const text = events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join("");
    const stats = guidanceStats(text);
    assert.ok(cards.length <= 1, `${label}: 同轮多张卡片`);
    assert.ok(
      stats.chars <= MAX_GUIDANCE_CHARS && stats.sentences <= 2,
      `${label}: 正文过长`,
    );
    assert.ok(stats.questions + cards.length <= 1, `${label}: 同轮多个问题`);
    if (answering) {
      const first = events.find((e) => e.type !== "text" || e.delta.trim());
      assert.ok(
        first?.type === "verdict" ||
          (first?.type === "text" && /^\s*\[判定\] 待核对/.test(first.delta)),
        `${label}: 作答后没有先输出判定`,
      );
    }
    turns++;
    log(
      `PASS ${label}: cards=${cards.length}, chars=${stats.chars}, questions=${stats.questions}`,
    );
    // 与前端相同，把实际收到的卡片放回历史，供模型累计题目/知识点预算。
    const verdict = events.find((e) => e.type === "verdict");
    messages.push({
      role: "assistant",
      content: `${verdict ? `[判定] ${verdict.correct ? "对" : "错"}·${verdict.topic || ""}·${verdict.reason || ""}\n` : ""}${text}${cards[0] ? `\n\n[我上一轮给出的卡片] ${JSON.stringify(cards[0])}` : ""}`,
    });
    return { cards, text, stats };
  }

  const concept = await turn("概念讲解", [
    {
      role: "user",
      content:
        "请只讲解：为什么使用一种方法前需要检查适用条件？暂时不要出练习。",
    },
  ]);
  assert.equal(concept.cards.length, 0, "概念讲解不应出卡");
  assert.equal(concept.stats.questions, 0, "概念讲完就停");

  const missing = await turn("缺条件", [
    {
      role: "user",
      content:
        "练习关系 s=a+b：已知 a=2，b 未给出，请引导我补齐条件后求 s，不要编造 b。",
    },
  ]);
  assert.equal(missing.cards[0]?.kind, "data", "缺条件应优先 data 卡");
  assert.ok(missing.cards[0].fields.length, "data 卡应有输入框");

  const judgment = await turn("概念判断练习", [
    {
      role: "user",
      content:
        "我想做一道概念判断练习：采用一种方法前是否需要检查适用条件？请用卡片让我判断，不要先讲答案。",
    },
  ]);
  assert.ok(
    ["choice", "truefalse"].includes(judgment.cards[0]?.kind),
    "概念判断应使用 choice/truefalse",
  );

  const messages = [
    {
      role: "user",
      content:
        "请引导我分步求 (a+b)×c，已知 a=2、b=3、c=4；条件都给出了，让我先填写一个中间计算步骤，不要告诉我最终结果。",
    },
  ];
  let result = await turn("已知条件求解", messages);
  assert.equal(result.cards[0]?.kind, "calc", "条件齐全的求解应直接 calc");
  let total = 0;
  let topic;
  let sameTopic = 0;
  while (result.cards.length) {
    const card = result.cards[0];
    total++;
    assert.ok(total <= 3, "一道题累计超过三张卡片");
    sameTopic = card.topic === topic ? sameTopic + 1 : 1;
    topic = card.topic;
    assert.ok(sameTopic <= 2, "同知识点连续超过两张卡片，应先小结");
    const answer =
      card.kind === "choice"
        ? { kind: "choice", choiceId: card.options[0].id }
        : card.kind === "truefalse"
          ? { kind: "truefalse", value: true }
          : {
              kind: card.kind,
              values: Object.fromEntries(card.fields.map((f) => [f.key, "5"])),
            };
    messages.push({ role: "user", content: formatAnswer(card, answer) });
    result = await turn(`求解作答 ${total}`, messages, true);
    if (sameTopic >= 2 || total >= 3)
      assert.equal(result.cards.length, 0, "达到预算后应阶段小结");
  }
  assert.ok(
    result.text.trim() && result.stats.questions === 0,
    "求解结束应简短小结且停止追问",
  );
  log(`PACING PASS: turns=${turns}, solveCards=${total}`);
  return { turns, solveCards: total };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const [, , courseId, baseUrl, model] = process.argv;
  runPacingCheck({ courseId, baseUrl, model }).catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
