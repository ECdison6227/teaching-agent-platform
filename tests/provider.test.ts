import test, { after } from "node:test";
import assert from "node:assert/strict";
import { z } from "zod";
import {
  chat,
  resolveProviderConfig,
  structured,
} from "../src/lib/models/provider";
import { startMockModel } from "../scripts/mock-model.mjs";
import { PageNoteSchema } from "../src/lib/import-schemas";
const mock = await startMockModel();
after(() => mock.close());
process.env.MODEL_PROVIDER = "openai-compatible";
process.env.OPENAI_BASE_URL = mock.url;
process.env.OPENAI_CHAT_MODEL = "mock-chat";
process.env.OPENAI_VISION_MODEL = "mock-vision";
test("模型任务分别路由到 chat 与 vision，JSON 经 schema 验证", async () => {
  const text = await structured("notes", PageNoteSchema, "标题参考：样本空间");
  assert.equal(text?.model, "openai-compatible:mock-chat");
  const image = await structured(
    "notes",
    PageNoteSchema,
    "标题参考：扫描页",
    "data:image/png;base64,YQ==",
  );
  assert.equal(image?.model, "openai-compatible:mock-vision");
  assert.equal(mock.calls.filter((c) => c.vision).length, 1);
  await assert.rejects(
    structured("notes", z.object({ missing: z.string() }), "bad schema"),
    /schema/,
  );
});
test("对话通过真实 HTTP SSE 返回；无配置可降级", async () => {
  let text = "";
  for await (const piece of chat(
    [{ role: "user", content: "解释概率" }],
    AbortSignal.timeout(5000),
  ))
    text += piece;
  assert.match(text, /card/);
  process.env.MODEL_PROVIDER = "none";
  assert.equal(resolveProviderConfig(), null);
  assert.equal(await structured("notes", PageNoteSchema, "test"), null);
});
