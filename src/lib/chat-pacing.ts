import { createChatParser, type StreamEvent } from "./chat-protocol";
import { chat, type ChatMessage } from "./models/provider";
import {
  guidanceStats,
  MAX_GUIDANCE_CHARS,
  MAX_GUIDANCE_SENTENCES,
} from "./pacing";

export function checkChatPacing(
  raw: string,
  maxPage: number,
  answering = false,
) {
  const events: StreamEvent[] = [];
  const parser = createChatParser((event) => events.push(event), maxPage, {
    enforcePacing: false,
  });
  parser.push(raw);
  parser.end();
  const text = events
    .filter((e) => e.type === "text")
    .map((e) => e.delta)
    .join("");
  const cards = events.filter((e) => e.type === "card");
  const stats = guidanceStats(text);
  const issues: string[] = [];
  if (cards.length > 1) issues.push("本轮超过一张卡片");
  if (stats.questions > 1 || (cards.length && stats.questions))
    issues.push("本轮有多个问题；出卡时正文不再另问");
  if (stats.chars > MAX_GUIDANCE_CHARS) issues.push("正文过长");
  if (stats.sentences > MAX_GUIDANCE_SENTENCES) issues.push("正文超过两句");
  if (answering && !/^\s*\[判定\]\s*(?:对|错|待核对)[·|｜:：,，]/.test(raw))
    issues.push("学生作答后首行缺少判定行");
  if (events.some((e) => e.type === "error")) issues.push("交互协议无效或为空");
  return { issues, stats, cards: cards.length };
}

function isCardAnswer(messages: ChatMessage[]) {
  const last = messages.at(-1);
  if (last?.role !== "user") return false;
  const text =
    typeof last.content === "string"
      ? last.content
      : last.content
          .filter((p) => p.type === "text")
          .map((p) => p.text)
          .join("\n");
  return /^\s*(?:我的选择是|我的判断是|我填写的数据|我的作答见上)/.test(text);
}

/** 默认先校验再发出，违规只请求一次重写；关闭后恢复逐 delta 输出。
 * 两次调用共享同一个请求 signal/总时限，不递归重试、不切换通道。
 * 重写失败时保留原响应，由协议层限制正文和卡片；取消/超时仍向上传递。
 */
export async function* pacedChat(
  messages: ChatMessage[],
  signal: AbortSignal,
  model: string | null | undefined,
  maxPage: number,
  options: { repair?: boolean; generate?: typeof chat } = {},
) {
  const generate = options.generate || chat;
  const repair = options.repair ?? process.env.CHAT_PACING_REPAIR !== "off";
  if (!repair) {
    yield* generate(messages, signal, model);
    return;
  }
  const collect = async (history: ChatMessage[]) => {
    let raw = "";
    for await (const delta of generate(history, signal, model)) {
      signal.throwIfAborted();
      raw += delta;
      if (raw.length > 1_000_000) throw new Error("模型响应过大，请重试");
    }
    signal.throwIfAborted();
    return raw;
  };
  const original = await collect(messages);
  const answering = isCardAnswer(messages);
  const { issues } = checkChatPacing(original, maxPage, answering);
  if (!issues.length) {
    yield original;
    return;
  }
  // 只记录规则名称，不记录课程内容、学生输入、响应原文或密钥。
  console.info(JSON.stringify({ event: "chat_pacing_repair", issues }));
  try {
    const rewritten = await collect([
      ...messages,
      { role: "assistant", content: original },
      {
        role: "user",
        content: `请只重写上一条助教回复，不要当作新任务。违规项：${issues.join("；")}。遵守系统教学节奏：正文只写 1–2 句且不超过 ${MAX_GUIDANCE_CHARS} 字，一次一个问题、最多一张 card；有卡片时正文不再提问；求解优先 data/calc，概念讲解不出卡；作答后首行判定；保留原有可靠依据，不直接给最终答案。不要解释修正过程。`,
      },
    ]);
    // 重写仍不合规时保留初稿交给解析兜底，不发起第三次请求。
    const result = checkChatPacing(rewritten, maxPage, answering);
    yield result.issues.length ? original : rewritten;
  } catch {
    signal.throwIfAborted();
    console.info(JSON.stringify({ event: "chat_pacing_repair_failed" }));
    yield original;
  }
}
