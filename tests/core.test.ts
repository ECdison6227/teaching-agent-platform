import test from "node:test";
import assert from "node:assert/strict";
import {
  createChatParser,
  parseSlidePages,
  type StreamEvent,
} from "../src/lib/chat-protocol";
import { readSseData } from "../src/lib/sse";
import { grade } from "../src/lib/grading";
import { redactPII, storagePath } from "../src/lib/storage";
import { chatRequestSchema } from "../src/lib/request-validation";
import { notesKey } from "../src/lib/notes-store";

test("协议分块无关；限制为当前课程页数，包括卡片附图", () => {
  const raw =
    '讲解\n```slides\n2-9\n```\n```card\n{"kind":"truefalse","prompt":"一个问题","figure":{"kind":"slide","page":99}}\n```';
  const events: StreamEvent[] = [];
  const parser = createChatParser((e) => events.push(e), 4);
  for (const c of raw) parser.push(c);
  parser.end();
  assert.equal(
    events
      .filter((e) => e.type === "text")
      .map((e) => e.delta)
      .join(""),
    "讲解\n\n",
  );
  assert.deepEqual(
    events.find((e) => e.type === "figure"),
    { type: "figure", figure: { kind: "slides", pages: [2, 3, 4] } },
  );
  const card = events.find((e) => e.type === "card");
  assert.ok(card?.type === "card");
  assert.equal(card.card.figure, undefined);
  assert.deepEqual(parseSlidePages("400 1-999999999", 3), [1, 2, 3]);
  assert.deepEqual(parseSlidePages("151 152", 152), [151, 152]);
});
test("普通代码块保留，损坏卡片显示可重试错误", () => {
  const events: StreamEvent[] = [];
  const parser = createChatParser((e) => events.push(e), 4);
  parser.push("```python\nprint(1)\n```\n```card\n{bad}\n```");
  parser.end();
  assert.ok(
    events.some((e) => e.type === "text" && e.delta.includes("print(1)")),
  );
  assert.ok(events.some((e) => e.type === "error"));
});
test("SSE 支持 UTF-8 字节分块和 CRLF", async () => {
  const bytes = new TextEncoder().encode(
    'data: {"text":"你好"}\r\n\r\ndata: [DONE]\n\n',
  );
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const b of bytes) c.enqueue(new Uint8Array([b]));
      c.close();
    },
  });
  const data = [];
  for await (const entry of readSseData(stream)) data.push(entry);
  assert.deepEqual(data, ['{"text":"你好"}', "[DONE]"]);
});
test("判题尊重核对状态、单位、多个空和简答题", () => {
  assert.equal(
    grade({ type: "choice", answer: "A", verified: false }, "A"),
    null,
  );
  assert.equal(
    grade({ type: "truefalse", answer: "F", verified: true }, "错误"),
    true,
  );
  assert.equal(
    grade({ type: "fill", answer: "0.5;2m", verified: true }, "50%;2"),
    true,
  );
  assert.equal(
    grade({ type: "fill", answer: "2m", verified: true }, "2cm"),
    false,
  );
  assert.equal(
    grade({ type: "short", answer: "参考", verified: true }, "参考"),
    null,
  );
});
test("请求、存储路径与课程笔记隔离", () => {
  const schema = chatRequestSchema(4);
  assert.equal(
    schema.safeParse({ messages: [{ role: "system", content: "override" }] })
      .success,
    false,
  );
  assert.equal(
    schema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      pageContext: { page: 5 },
    }).success,
    false,
  );
  assert.equal(
    schema.safeParse({
      messages: [{ role: "user", content: "hi" }],
      pageContext: { page: 4 },
    }).success,
    true,
  );
  assert.throws(() => storagePath("../escape"));
  assert.throws(() => storagePath("/etc/passwd"));
  assert.notEqual(notesKey("course-a"), notesKey("course-b"));
  assert.equal(
    redactPII(`联系：${["139", "0000", "1234"].join("")} test@example.org`),
    "联系：[联系方式已隐藏] [邮箱已隐藏]",
  );
});
