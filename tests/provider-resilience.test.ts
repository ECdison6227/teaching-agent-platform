import test, { after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import { structured, chat, ModelOutputError } from "../src/lib/models/provider";
import { parseModelJson } from "../src/lib/models/json";
import {
  PageNoteSchema,
  StructureSchema,
  TextbookSchema,
  QuestionsSchema,
} from "../src/lib/import-schemas";

const originalFetch = globalThis.fetch;
let scenario = 0;
after(() => {
  globalThis.fetch = originalFetch;
});
beforeEach(() => {
  process.env.MODEL_PROVIDER = "openai-compatible";
  process.env.OPENAI_BASE_URL = `http://model-${++scenario}.test/v1`;
  process.env.OPENAI_CHAT_MODEL = "test-json";
  process.env.OPENAI_JSON_MODE = "auto";
  process.env.MODEL_RETRY_BASE_MS = "1";
  process.env.MODEL_RATE_LIMIT_BASE_MS = "1";
  for (const key of [
    "OPENAI_RATE_LIMIT_RETRIES",
    "MODEL_RATE_LIMIT_RETRIES",
    "OPENAI_RATE_LIMIT_BASE_MS",
    "MODEL_CONCURRENCY",
  ])
    delete process.env[key];
  delete process.env.MODEL_TIMEOUT_MS;
});
function envelope(raw: string, finish_reason = "stop") {
  return Response.json({
    choices: [{ message: { content: raw }, finish_reason }],
    usage: { total_tokens: 7 },
  });
}
test("LaTeX、合法转义、围栏和前后说明均可解析，截断不能抢救成局部对象", () => {
  const data = parseModelJson(
    "说明\n```json\n" +
      String.raw`{"value":"$\alpha+\beta+\frac{1}{2}+\theta+\nabla+\rho+\nu+\tau$","escaped":"$\\alpha$","line":"a\nb","quote":"a\"b"}` +
      "\n```\n完成",
  ) as Record<string, string>;
  assert.equal(
    data.value,
    String.raw`$\alpha+\beta+\frac{1}{2}+\theta+\nabla+\rho+\nu+\tau$`,
  );
  assert.equal(data.escaped, String.raw`$\alpha$`);
  assert.equal(data.line, "a\nb");
  assert.equal(data.quote, 'a"b');
  assert.throws(() => parseModelJson('{"outer":{"value":"complete"}'), /截断/);
  assert.throws(() => parseModelJson('{"value":"unfinished'), /截断/);
});
const samples = [
  [
    "structure",
    StructureSchema,
    String.raw`{"chapters":[{"title":"$\alpha$","knowledgePoints":[{"title":"$\beta$","pages":[1]}]}]}`,
  ],
  [
    "notes",
    PageNoteSchema,
    String.raw`{"title":"概念","points":["$\frac{1}{2}$"],"keys":["$\theta$"]}`,
  ],
  [
    "textbook",
    TextbookSchema,
    String.raw`{"content_md":"$\alpha + \beta = \frac{1}{2}$"}`,
  ],
  [
    "questions",
    QuestionsSchema,
    String.raw`{"questions":[{"type":"short","prompt":"$\nabla$","answer":"$\tau$"}]}`,
  ],
] as const;
for (const [task, schema, raw] of samples) {
  test(`${task} 全流程共用容错 JSON 且优先 json_object`, async () => {
    globalThis.fetch = async (_, init) => {
      const request = JSON.parse(init!.body as string);
      assert.deepEqual(request.response_format, { type: "json_object" });
      if (task === "structure") assert.equal(request.temperature, 0.2);
      return envelope("前言\n```json\n" + raw + "\n```\n后记");
    };
    const result = await structured(task, schema, "input");
    assert.ok(result);
    assert.equal(result.metrics.requests, 1);
    assert.equal(result.metrics.parseRetries, 0);
  });
}
test("非法 JSON 和 finish_reason=length 各自触发解析重试，第三次可恢复", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1
      ? envelope('{"value":')
      : calls === 2
        ? envelope('{"value":"partial"}', "length")
        : envelope('{"value":"ok"}');
  const result = await structured(
    "notes",
    z.object({ value: z.string() }),
    "input",
  );
  assert.equal(calls, 3);
  assert.equal(result?.data.value, "ok");
  assert.equal(result?.metrics.parseRetries, 2);
});
test("持续解析失败至少重试两次并带有计数", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return envelope("truncated");
  };
  await assert.rejects(
    structured("textbook", TextbookSchema, "input"),
    (error: unknown) =>
      error instanceof ModelOutputError && error.metrics.parseRetries === 2,
  );
  assert.equal(calls, 3);
});
test("空响应包络作为解析失败重试，不绕过结构化重试预算", async () => {
  let calls = 0;
  globalThis.fetch = async () =>
    ++calls === 1 ? Response.json(null) : envelope('{"content_md":"ok"}');
  const result = await structured("textbook", TextbookSchema, "input");
  assert.equal(calls, 2);
  assert.equal(result?.data.content_md, "ok");
  assert.equal(result?.metrics.parseRetries, 1);
});
test("网络错误、429、5xx 的传输重试无额外解析重试放大", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    calls++;
    if (calls === 1) throw new TypeError("fetch failed");
    if (calls === 2) return new Response("limited", { status: 429 });
    if (calls === 3) return new Response("unavailable", { status: 503 });
    return envelope('{"value":"ok"}');
  };
  const result = await structured(
    "notes",
    z.object({ value: z.string() }),
    "input",
  );
  assert.equal(calls, 4);
  assert.equal(result?.metrics.networkRetries, 3);
  assert.equal(result?.metrics.rateLimits, 1);
  assert.equal(result?.metrics.serverErrors, 1);
  assert.equal(result?.metrics.parseRetries, 0);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("down", { status: 503 });
  };
  await assert.rejects(structured("notes", PageNoteSchema, "input"), /503/);
  assert.equal(calls, 4);
});
test("响应体网络中断和超时也会重试，401 立即失败", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls < 4)
      return new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new TypeError("terminated"));
          },
        }),
      );
    return envelope('{"content_md":"ok"}');
  };
  assert.equal(
    (await structured("textbook", TextbookSchema, "input"))?.metrics
      .networkRetries,
    3,
  );
  calls = 0;
  process.env.MODEL_TIMEOUT_MS = "2";
  globalThis.fetch = async (_, init) => {
    calls++;
    return new Promise((_, reject) =>
      init!.signal!.addEventListener("abort", () =>
        reject(init!.signal!.reason),
      ),
    );
  };
  // Keep the event loop alive while the mocked fetch waits on an unref'ed timeout.
  const timer = setInterval(() => {}, 1000);
  try {
    await assert.rejects(
      structured("notes", PageNoteSchema, "input"),
      /timeout/i,
    );
  } finally {
    clearInterval(timer);
  }
  assert.equal(calls, 4);
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("no", { status: 401 });
  };
  await assert.rejects(structured("notes", PageNoteSchema, "input"), /401/);
  assert.equal(calls, 1);
});
test("不支持 response_format 的通道自动降级并缓存能力", async () => {
  process.env.OPENAI_CHAT_MODEL = "legacy-json";
  let calls = 0;
  globalThis.fetch = async (_, init) => {
    calls++;
    const request = JSON.parse(init!.body as string);
    if (calls === 1) {
      assert.ok(request.response_format);
      return new Response("response_format unsupported", { status: 400 });
    }
    assert.equal(request.response_format, undefined);
    return envelope('{"content_md":"ok"}');
  };
  await structured("textbook", TextbookSchema, "input");
  await structured("textbook", TextbookSchema, "input");
  assert.equal(calls, 3);
});
test("chat 初始网络请求同样重试，用户停止不重试", async () => {
  let calls = 0;
  globalThis.fetch = async () => {
    if (++calls < 4) throw new TypeError("fetch failed");
    return new Response(
      'data: {"choices":[{"delta":{"content":"ok"}}]}\n\ndata: [DONE]\n\n',
    );
  };
  let text = "";
  for await (const piece of chat(
    [{ role: "user", content: "test" }],
    AbortSignal.timeout(1000),
  ))
    text += piece;
  assert.equal(text, "ok");
  assert.equal(calls, 4);
  const controller = new AbortController();
  controller.abort();
  calls = 0;
  await assert.rejects(async () => {
    for await (const piece of chat([], controller.signal)) void piece;
  });
  assert.equal(calls, 0);
});

test("429 遵守 Retry-After，默认重试多于三次，耗尽后保留 HTTP 状态且不乘解析预算", async () => {
  let calls = 0;
  const starts: number[] = [];
  globalThis.fetch = async () => {
    starts.push(Date.now());
    calls++;
    return calls <= 4
      ? new Response("limited", {
          status: 429,
          headers: { "Retry-After": calls === 1 ? "1" : "0" },
        })
      : envelope('{"content_md":"ok"}');
  };
  const result = await structured("textbook", TextbookSchema, "input");
  assert.equal(calls, 5);
  assert.ok(starts[1] - starts[0] >= 1000);
  assert.equal(result?.metrics.rateLimits, 4);
  assert.equal(result?.metrics.parseRetries, 0);
  process.env.OPENAI_RATE_LIMIT_RETRIES = "1";
  process.env.MODEL_RATE_LIMIT_RETRIES = "6";
  calls = 0;
  globalThis.fetch = async () => {
    calls++;
    return new Response("limited", { status: 429 });
  };
  await assert.rejects(
    structured("textbook", TextbookSchema, "input"),
    (error: unknown) =>
      error instanceof ModelOutputError &&
      error.status === 429 &&
      error.kind === "transport" &&
      error.metrics.parseRetries === 0,
  );
  assert.equal(calls, 2);
});

test("chat 等待全局限流冷却时可立即取消", async () => {
  globalThis.fetch = async () =>
    new Response("limited", { status: 429, headers: { "Retry-After": "60" } });
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error("user stopped")),
    20,
  );
  try {
    await assert.rejects(async () => {
      for await (const chunk of chat([], controller.signal)) void chunk;
    }, /abort|user stopped/i);
  } finally {
    clearTimeout(timer);
  }
});

test("聊天流与结构化任务共享并发许可，流退出后才启动排队请求", async () => {
  process.env.MODEL_CONCURRENCY = "1";
  let calls = 0;
  globalThis.fetch = async (_, init) => {
    calls++;
    return JSON.parse(init!.body as string).stream
      ? new Response(
          'data: {"choices":[{"delta":{"content":"first"}}]}\n\ndata: [DONE]\n\n',
        )
      : envelope('{"content_md":"ok"}');
  };
  const stream = chat([], AbortSignal.timeout(5000));
  assert.equal((await stream.next()).value, "first");
  const queued = structured("textbook", TextbookSchema, "input");
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(calls, 1);
  await stream.return(undefined);
  assert.equal((await queued)?.data.content_md, "ok");
  assert.equal(calls, 2);
});
