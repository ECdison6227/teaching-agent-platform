import { CardSchema, VerdictSchema, type Card, type Figure } from "./cards";

export type StreamEvent =
  | { type: "text"; delta: string }
  | { type: "verdict"; correct: boolean; reason?: string; topic?: string }
  | { type: "card"; card: Card }
  | { type: "figure"; figure: Figure }
  | { type: "error"; message: string }
  | { type: "done" };
type FenceKind =
  "verdict" | "card" | "diagram" | "slides" | "slide" | "auto" | "raw";
const OPENERS = ["verdict", "card", "diagram", "slides", "slide", "json"].map(
  (kind) => "```" + kind,
);
const VERDICT_RE =
  /^\[判定\]\s*([^·|｜:：,，\s]+)\s*[·|｜:：,，]?\s*(K\d+)?\s*[·|｜:：,，]?\s*(.*)$/;

function emitVerdict(raw: string, emit: (event: StreamEvent) => void): boolean {
  const match = raw.trim().match(VERDICT_RE);
  if (!match) return false;
  const token = match[1].trim();
  if (/^(对|正确|√|✔|错|错误|不对|×|✘)$/.test(token)) {
    emit({
      type: "verdict",
      correct: /^(对|正确|√|✔)$/.test(token),
      topic: match[2] || undefined,
      reason: match[3] || undefined,
    });
  }
  return true;
}

export function parseSlidePages(raw: string, maxPage: number): number[] {
  const pages = new Set<number>();
  const normalized = raw.trim().replace(/(\d+)\s*[-~～到至]\s*(\d+)/g, "$1-$2");
  for (const part of normalized.split(/[,，、\s]+/).filter(Boolean)) {
    const range = part.match(/^(\d+)-(\d+)$/);
    if (range) {
      const a = Math.max(1, Math.min(Number(range[1]), Number(range[2])));
      const b = Math.min(
        maxPage,
        Math.max(Number(range[1]), Number(range[2])),
        a + 30,
      );
      for (let page = a; page <= b; page++) pages.add(page);
    } else if (/^\d+$/.test(part)) {
      const page = Number(part);
      if (page >= 1 && page <= maxPage) pages.add(page);
    }
  }
  return [...pages].sort((a, b) => a - b);
}

function handleFence(
  kind: FenceKind,
  raw: string,
  emit: (event: StreamEvent) => void,
  opening = "",
  closed = true,
  maxPage = 0,
) {
  if (kind === "auto" || kind === "raw") {
    if (kind === "auto") {
      try {
        const object: unknown = JSON.parse(raw);
        const card = CardSchema.safeParse(object);
        if (card.success) {
          emit({ type: "card", card: card.data });
          return;
        }
        const verdict = VerdictSchema.safeParse(object);
        if (verdict.success) {
          emit({ type: "verdict", ...verdict.data });
          return;
        }
      } catch {
        /* 普通代码块原样显示，不把示例误当作交互协议 */
      }
    }
    emit({ type: "text", delta: opening + raw + (closed ? "```" : "") });
    return;
  }
  if (kind === "diagram") {
    if (raw.trim())
      emit({ type: "figure", figure: { kind: "diagram", html: raw.trim() } });
    return;
  }
  if (kind === "slide" || kind === "slides") {
    const pages = parseSlidePages(raw, maxPage);
    if (pages.length === 1)
      emit({ type: "figure", figure: { kind: "slide", page: pages[0] } });
    else if (pages.length)
      emit({ type: "figure", figure: { kind: "slides", pages } });
    return;
  }
  let text = raw.trim();
  if (!text.startsWith("{")) {
    const first = text.indexOf("{");
    const last = text.lastIndexOf("}");
    if (first >= 0 && last > first) text = text.slice(first, last + 1);
  }
  let object: unknown;
  try {
    object = JSON.parse(text);
  } catch {
    emit({
      type: "error",
      message:
        kind === "card"
          ? "卡片内容不完整，请重试这一轮"
          : "判定内容不完整，请重试这一轮",
    });
    return;
  }
  if (kind === "verdict") {
    const verdict = VerdictSchema.safeParse(object);
    if (verdict.success) emit({ type: "verdict", ...verdict.data });
    else emit({ type: "error", message: "判定格式不正确，请重试这一轮" });
    return;
  }
  const card = CardSchema.safeParse(object);
  if (card.success) emit({ type: "card", card: card.data });
  else emit({ type: "error", message: "卡片格式不正确，请重试这一轮" });
}

/** 每次消费当前缓冲区中的全部完整块，结果不依赖模型 delta 的边界。 */
export function createChatParser(
  emitRaw: (event: StreamEvent) => void,
  maxPage: number,
) {
  let buffer = "";
  let fence: FenceKind | null = null;
  let fenceOpening = "";
  let verdictChecked = false;
  let spoke = false;
  let ended = false;
  const emit = (event: StreamEvent) => {
    const figure =
      event.type === "figure"
        ? event.figure
        : event.type === "card"
          ? event.card.figure
          : undefined;
    if (
      figure?.kind === "slide" &&
      (figure.page < 1 || figure.page > maxPage)
    ) {
      if (event.type === "figure") return;
      if (event.type === "card")
        event = { ...event, card: { ...event.card, figure: undefined } };
    }
    if (figure?.kind === "slides") {
      const pages = figure.pages.filter((p) => p >= 1 && p <= maxPage);
      if (event.type === "figure") {
        if (!pages.length) return;
        event = { ...event, figure: { ...figure, pages } };
      }
      if (event.type === "card")
        event = {
          ...event,
          card: {
            ...event.card,
            figure: pages.length ? { ...figure, pages } : undefined,
          },
        };
    }
    spoke = true;
    emitRaw(event);
  };
  const consume = (final: boolean) => {
    if (!verdictChecked) {
      const newline = buffer.indexOf("\n");
      if (newline >= 0) {
        if (emitVerdict(buffer.slice(0, newline), emit))
          buffer = buffer.slice(newline + 1);
      } else {
        const head = buffer.trimStart();
        if (!final && ("[判定]".startsWith(head) || head.startsWith("[判定")))
          return;
        if (final && emitVerdict(buffer, emit)) buffer = "";
      }
      verdictChecked = true;
    }
    while (buffer.length) {
      if (fence) {
        const end = buffer.indexOf("```");
        if (end < 0) {
          if (final) {
            handleFence(fence, buffer, emit, fenceOpening, false, maxPage);
            buffer = "";
            fence = null;
          }
          return;
        }
        handleFence(
          fence,
          buffer.slice(0, end),
          emit,
          fenceOpening,
          true,
          maxPage,
        );
        buffer = buffer.slice(end + 3);
        fence = null;
        continue;
      }
      // 等标签后的空白，避免把被切开的 slides 提前识别成 slide。
      const match =
        /```(?:(verdict|card|diagram|slides|slide)(?=\s)|([A-Za-z0-9_-]*)[ \t]*\r?\n)/.exec(
          buffer,
        );
      if (match) {
        if (match.index)
          emit({ type: "text", delta: buffer.slice(0, match.index) });
        buffer = buffer.slice(match.index + match[0].length);
        fenceOpening = match[0];
        fence = match[1]
          ? (match[1] as FenceKind)
          : !match[2] || match[2].toLowerCase() === "json"
            ? "auto"
            : "raw";
        continue;
      }
      let keep = 0;
      if (!final)
        for (const opener of OPENERS)
          for (let size = 1; size <= opener.length; size++) {
            if (buffer.endsWith(opener.slice(0, size)))
              keep = Math.max(keep, size);
          }
      if (!final) {
        const partial = /```[A-Za-z0-9_-]{0,100}[ \t]*\r?$/.exec(buffer);
        if (partial) keep = Math.max(keep, buffer.length - partial.index);
      }
      const text = buffer.slice(0, buffer.length - keep);
      if (text) emit({ type: "text", delta: text });
      buffer = keep ? buffer.slice(-keep) : "";
      return;
    }
  };
  return {
    push(delta: string) {
      if (ended) throw new Error("响应解析已结束");
      buffer += delta;
      if (buffer.length > 1_000_000)
        throw new Error("模型响应过大，请缩短问题后重试");
      consume(false);
    },
    end() {
      if (ended) return;
      ended = true;
      consume(true);
      if (!spoke)
        emitRaw({
          type: "error",
          message: "模型这次没有返回内容，请重试或切换模型。",
        });
    },
  };
}
