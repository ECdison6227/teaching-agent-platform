import katex from "katex";

/**
 * 把模型回答里的公式整理成 remark-math / KaTeX 能排的样子。
 *
 * 模型经常把 LaTeX 直接写进中文括号，例如（ q = 2 , \text{kN/m}^2 ），
 * 没有 $...$。这里先把这类片段补上定界符。
 * 已经写好的 $...$ / $$...$$ 继续交给 KaTeX。
 * 流式输出里如果最后一个 $ 还没闭合，只把后面仍像公式的那一截包进去，
 * 不把随后的整段正文吞进公式。
 * ==术语== 只涂在公式外面，不切进公式中间。
 */

const TEXT_CMD =
  "text|textrm|textit|textbf|textsf|texttt|mathrm|mathbf|mathit|mathsf|mathtt|mathcal|mathbb|boldsymbol|operatorname";

const SYMBOLS: Record<string, string> = {
  alpha: "α",
  beta: "β",
  gamma: "γ",
  delta: "δ",
  epsilon: "ε",
  varepsilon: "ε",
  zeta: "ζ",
  eta: "η",
  theta: "θ",
  vartheta: "θ",
  iota: "ι",
  kappa: "κ",
  lambda: "λ",
  mu: "μ",
  nu: "ν",
  xi: "ξ",
  pi: "π",
  rho: "ρ",
  sigma: "σ",
  tau: "τ",
  phi: "φ",
  varphi: "φ",
  chi: "χ",
  psi: "ψ",
  omega: "ω",
  Gamma: "Γ",
  Delta: "Δ",
  Theta: "Θ",
  Lambda: "Λ",
  Xi: "Ξ",
  Pi: "Π",
  Sigma: "Σ",
  Phi: "Φ",
  Psi: "Ψ",
  Omega: "Ω",
  times: "×",
  cdot: "·",
  div: "÷",
  pm: "±",
  mp: "∓",
  leq: "≤",
  geq: "≥",
  neq: "≠",
  approx: "≈",
  equiv: "≡",
  infty: "∞",
  to: "→",
  rightarrow: "→",
  leftarrow: "←",
  Rightarrow: "⇒",
  Leftarrow: "⇐",
  partial: "∂",
  nabla: "∇",
  degree: "°",
  circ: "°",
  prime: "′",
};

/** 公式里允许直接出现的函数名，不把它们当成英文单词截断 */
const FUNCS = new Set([
  "sin",
  "cos",
  "tan",
  "cot",
  "sec",
  "csc",
  "sinh",
  "cosh",
  "tanh",
  "log",
  "ln",
  "exp",
  "max",
  "min",
  "lim",
  "det",
  "gcd",
  "mod",
  "sup",
  "inf",
  "dim",
  "ker",
  "deg",
  "arg",
]);

type MathTok = { t: "math"; body: string; display: boolean };
type TextTok = { t: "text"; s: string };
type Tok = MathTok | TextTok;

type HastNode = {
  type?: string;
  value?: string;
  properties?: { className?: unknown };
  children?: HastNode[];
};

function isCjk(ch: string): boolean {
  return /[\u3400-\u9fff]/.test(ch);
}

function isCjkPunct(ch: string): boolean {
  return "，。；：、！？（）【】《》「」『』“”‘’…—·".includes(ch);
}

function isMathChar(ch: string): boolean {
  return (
    /[0-9A-Za-z=+\-*/.,:;|<>()[\]!~&%']/.test(ch) || ch === "’" || ch === "′"
  );
}

function skipBrace(text: string, open: number): number {
  if (text[open] !== "{") return open;
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (ch === "\\") {
      i += 1;
      continue;
    }
    if (ch === "{") {
      depth += 1;
      continue;
    }
    if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
      continue;
    }
    // 花括号没合上就写进正文时，不要把整段话卷进去
    if (depth > 0 && (ch === "\n" || ch === "。" || ch === "！" || ch === "？"))
      return i;
    if (depth > 0 && i - open > 48 && isCjk(ch)) return i;
  }
  return text.length;
}

function consumeTex(text: string, i: number): number {
  if (text[i] !== "\\") return i;
  const m = /^\\[a-zA-Z]+/.exec(text.slice(i));
  if (!m) return Math.min(text.length, i + 2);
  let j = i + m[0].length;
  if (text[j] === "{") j = skipBrace(text, j);
  return j;
}

function longWordAt(text: string, i: number): boolean {
  if (!/[A-Za-z]/.test(text[i] || "")) return false;
  if (i > 0 && !/\s/.test(text[i - 1])) return false;
  const word = /^[A-Za-z]+/.exec(text.slice(i))?.[0] ?? "";
  return word.length >= 4 && !FUNCS.has(word);
}

function isHighlightEq(text: string, i: number): boolean {
  return text[i] === "=" && (text[i + 1] === "=" || text[i - 1] === "=");
}

/** 从公式起点往后，停在正文开始的地方（中文、句号、未闭合 $ 之前） */
function mathPrefixEnd(text: string, start: number): number {
  let i = start;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "$") break;
    if (ch === "\\") {
      const next = consumeTex(text, i);
      if (next === i) break;
      i = next;
      continue;
    }
    if (ch === "{") {
      i = skipBrace(text, i);
      continue;
    }
    if (ch === "^" || ch === "_") {
      i += 1;
      if (text[i] === "{") i = skipBrace(text, i);
      else if (text[i] && /[0-9A-Za-z]/.test(text[i])) i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      const nl = ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      const after = text.slice(i + nl);
      const c = /^[ \t]*(\S)/.exec(after)?.[1];
      if (
        !c ||
        c === "$" ||
        isCjk(c) ||
        isCjkPunct(c) ||
        longWordAt(after.trimStart(), 0)
      )
        break;
      if (c === "\\" || c === "{" || c === "^" || c === "_" || isMathChar(c)) {
        i += nl;
        continue;
      }
      break;
    }
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (isHighlightEq(text, i) || isCjk(ch) || isCjkPunct(ch)) break;
    if (longWordAt(text, i)) break;
    if (isMathChar(ch)) {
      i += 1;
      continue;
    }
    break;
  }
  return i;
}

function findClosing(text: string, from: number, display: boolean): number {
  for (let i = from; i < text.length; i++) {
    if (text[i] === "\\") {
      i += 1;
      continue;
    }
    if (text[i] !== "$") continue;
    if (display) {
      if (text[i + 1] === "$") return i;
      continue;
    }
    return i;
  }
  return -1;
}

/** 去掉 \text{...} 这类分组后，看定界符中间是不是大段中文 */
function cjkOutsideGroups(inner: string): { cjk: number; sentence: boolean } {
  const stripped = inner.replace(/\\[a-zA-Z]+\s*\{[^{}]*\}/g, " ");
  const cjk = (stripped.match(/[\u3400-\u9fff]/g) || []).length;
  return {
    cjk,
    sentence: /[。！？]/.test(stripped) || stripped.includes("\n\n"),
  };
}

function shouldKeepPair(inner: string): boolean {
  const { cjk, sentence } = cjkOutsideGroups(inner);
  if (sentence) return false;
  if (cjk > 8) return false;
  return true;
}

function splitMathRegions(input: string): Tok[] {
  const out: Tok[] = [];
  let buf = "";
  let i = 0;
  const flush = () => {
    if (buf) out.push({ t: "text", s: buf });
    buf = "";
  };

  while (i < input.length) {
    if (input[i] === "\\" && input[i + 1] === "$") {
      buf += "\\$";
      i += 2;
      continue;
    }
    if (input[i] !== "$") {
      buf += input[i];
      i += 1;
      continue;
    }

    let j = i;
    while (input[j] === "$") j += 1;
    const marker = j - i;
    const display = marker >= 2;
    const from = display ? i + 2 : i + 1;
    const close = findClosing(input, from, display);
    const inner = close >= 0 ? input.slice(from, close) : null;

    if (inner != null && shouldKeepPair(inner)) {
      flush();
      out.push({ t: "math", body: inner, display });
      i = close + (display ? 2 : 1);
      continue;
    }

    const end = mathPrefixEnd(input, from);
    const raw = input.slice(from, end);
    const body = raw.trim();
    flush();
    if (body) {
      out.push({ t: "math", body, display });
      i = from + raw.trimEnd().length;
    } else {
      buf += display ? "\\$\\$" : "\\$";
      i = from;
    }
  }
  flush();
  return out;
}

function expandLeft(text: string, from: number): number {
  let i = from;
  while (i > 0) {
    const ch = text[i - 1];
    if (ch === "}") {
      let depth = 0;
      let k = i - 1;
      let open = -1;
      for (; k >= 0; k--) {
        if (text[k] === "}") depth += 1;
        else if (text[k] === "{") {
          depth -= 1;
          if (depth === 0) {
            open = k;
            break;
          }
        }
      }
      if (open < 0) break;
      i = open;
      const cmd = /\\[a-zA-Z]+$/.exec(text.slice(0, i));
      if (cmd) i -= cmd[0].length;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\n" || ch === "\r") {
      i -= 1;
      continue;
    }
    if (ch === "\\") {
      i -= 1;
      continue;
    }
    if (isHighlightEq(text, i - 1) || isCjk(ch) || isCjkPunct(ch)) break;
    if (/[A-Za-z]/.test(ch)) {
      let k = i - 1;
      while (k > 0 && /[A-Za-z]/.test(text[k - 1])) k -= 1;
      const word = text.slice(k, i);
      if (
        word.length >= 4 &&
        !FUNCS.has(word) &&
        (k === 0 || /\s/.test(text[k - 1]))
      )
        break;
      i -= 1;
      continue;
    }
    if (isMathChar(ch) || ch === "{" || ch === "^" || ch === "_") {
      i -= 1;
      continue;
    }
    break;
  }
  while (i < from && /\s/.test(text[i])) i += 1;
  return i;
}

function expandRight(text: string, from: number): number {
  let i = from;
  while (i < text.length) {
    const ch = text[i];
    if (ch === "\\") {
      const next = consumeTex(text, i);
      if (next === i) break;
      i = next;
      continue;
    }
    if (ch === "{") {
      i = skipBrace(text, i);
      continue;
    }
    if (ch === "^" || ch === "_") {
      i += 1;
      if (text[i] === "{") i = skipBrace(text, i);
      else if (text[i] && /[0-9A-Za-z]/.test(text[i])) i += 1;
      continue;
    }
    if (ch === "\n" || ch === "\r") {
      const nl = ch === "\r" && text[i + 1] === "\n" ? 2 : 1;
      const after = text.slice(i + nl);
      const c = /^[ \t]*(\S)/.exec(after)?.[1];
      if (
        !c ||
        isCjk(c) ||
        isCjkPunct(c) ||
        c === "$" ||
        longWordAt(after.trimStart(), 0)
      )
        break;
      if (c === "\\" || c === "{" || c === "^" || c === "_" || isMathChar(c)) {
        i += nl;
        continue;
      }
      break;
    }
    if (ch === " " || ch === "\t") {
      i += 1;
      continue;
    }
    if (
      isHighlightEq(text, i) ||
      isCjk(ch) ||
      isCjkPunct(ch) ||
      longWordAt(text, i)
    )
      break;
    if (isMathChar(ch)) {
      i += 1;
      continue;
    }
    break;
  }
  while (i > from && /\s/.test(text[i - 1])) i -= 1;
  return i;
}

function wrapBareLatex(segment: string): string {
  let out = "";
  let i = 0;
  while (i < segment.length) {
    const m = /\\([a-zA-Z]{2,})/.exec(segment.slice(i));
    if (!m) {
      out += segment.slice(i);
      break;
    }
    const cmdStart = i + m.index;
    const cmdEnd = cmdStart + m[0].length;
    let start = expandLeft(segment, cmdStart);
    const end = expandRight(segment, cmdEnd);
    if (start < i) start = i;
    if (end <= start) {
      i = cmdEnd;
      continue;
    }
    out += segment.slice(i, start);
    out += finalize(segment.slice(start, end), false);
    i = end;
  }
  return out;
}

function soften(src: string): string {
  let s = src.replace(/\r\n/g, "\n");
  if (!/\\begin\b/.test(s)) s = s.replace(/[ \t]*\n[ \t]*/g, " ");
  return s.replace(/[ \t]{2,}/g, " ").trim();
}

/** 把 \text{kN/m^2} 里的上下标挪到花括号外，并收掉多余空格 */
function repairLatex(src: string): string {
  let s = soften(src);
  s = s.replace(/\\([a-zA-Z]+)\s+\{/g, "\\$1{");
  s = s.replace(/\s*([_^])\s*/g, "$1");
  s = s.replace(
    new RegExp(`\\\\(${TEXT_CMD})\\{([^{}]*)\\}`, "g"),
    (_full, cmd: string, inner: string) => {
      const scripts: string[] = [];
      const cleaned = inner
        .replace(
          /([_^])\s*(\{[^{}]*\}|[0-9A-Za-z]+)/g,
          (_m, op: string, arg: string) => {
            scripts.push(op + (arg.startsWith("{") ? arg : `{${arg}}`));
            return "";
          },
        )
        .replace(/\s+/g, " ")
        .trim();
      return `\\${cmd}{${cleaned}}${scripts.join("")}`;
    },
  );
  s = s.replace(/([_^])([0-9A-Za-z])/g, "$1{$2}");
  s = s.replace(/\s+,/g, ",");
  s = s.replace(/,\s+/g, ", ");
  s = balanceBraces(s);
  s = s.replace(/[_^](?=$|[^\\{0-9A-Za-z])/g, "");
  const lefts = (s.match(/\\left\b/g) || []).length;
  const rights = (s.match(/\\right\b/g) || []).length;
  if (lefts !== rights) s = s.replace(/\\(?:left|right)\b/g, "");
  return s.trim();
}

function balanceBraces(s: string): string {
  let depth = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "\\") {
      i += 1;
      continue;
    }
    if (s[i] === "{") depth += 1;
    else if (s[i] === "}") depth = Math.max(0, depth - 1);
  }
  return depth > 0 ? s + "}".repeat(depth) : s;
}

function katexOk(src: string, display: boolean): boolean {
  if (!src.trim() || src.length > 2000) return false;
  try {
    katex.renderToString(src, {
      throwOnError: true,
      displayMode: display,
      strict: "ignore",
    });
    return true;
  } catch {
    return false;
  }
}

function pickRenderable(body: string, display: boolean): string | null {
  const softened = soften(body).replace(/\$/g, "");
  const repaired = repairLatex(body).replace(/\$/g, "");
  const candidates = [
    softened,
    repaired,
    repaired.replace(/\\text\b/g, "\\mathrm"),
    repaired.replace(/\s+/g, ""),
  ];
  const seen = new Set<string>();
  for (const c of candidates) {
    if (!c || seen.has(c)) continue;
    seen.add(c);
    if (katexOk(c, display)) return c;
  }
  return null;
}

/** KaTeX 修不好时，去掉反斜杠，留下还能读的字 */
export function demoteLatex(src: string): string {
  let s = src.replace(/\\\\/g, " ");
  for (let n = 0; n < 8; n++) {
    const next = s
      .replace(new RegExp(`\\\\(?:${TEXT_CMD})\\s*\\{([^{}]*)\\}`, "g"), "$1")
      .replace(
        /\\(?:frac|dfrac|tfrac|cfrac)\s*\{([^{}]*)\}\s*\{([^{}]*)\}/g,
        "$1/$2",
      )
      .replace(/\\sqrt\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g, "√$1")
      .replace(/\\left\b|\\right\b/g, "")
      .replace(/\\([a-zA-Z]+)\s*/g, (_m, name: string) => SYMBOLS[name] ?? "");
    if (next === s) break;
    s = next;
  }
  s = s.replace(/[{}]/g, "");
  s = s.replace(/\\(.)/g, "$1");
  s = s.replace(/[ \t]*\n[ \t]*/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/\^\{\s*2\s*\}|\^2/g, "²");
  s = s.replace(/\^\{\s*3\s*\}|\^3/g, "³");
  s = s.replace(/\s*,\s*/g, ", ");
  s = s.replace(/\s+/g, " ").trim();
  s = s.replace(/</g, "＜").replace(/>/g, "＞");
  return s;
}

function finalize(body: string, display: boolean): string {
  const trimmed = body.trim();
  if (!trimmed) return "";
  const chosen = pickRenderable(trimmed, display);
  if (chosen) {
    return display ? `\n$$\n${chosen}\n$$\n` : `$${chosen}$`;
  }
  return demoteLatex(trimmed);
}

function maskCode(text: string): { text: string; blocks: string[] } {
  const blocks: string[] = [];
  const put = (s: string) => {
    const token = `\uE002${blocks.length}=\uE003`;
    blocks.push(s);
    return token;
  };
  let t = text.replace(/```[\s\S]*?```/g, (m) => put(m));
  t = t.replace(/`[^`\n]*`/g, (m) => put(m));
  return { text: t, blocks };
}

function unmask(text: string, blocks: string[]): string {
  return text.replace(
    /\uE002(\d+)=\uE003/g,
    (_m, n: string) => blocks[Number(n)] ?? "",
  );
}

function wrapMark(s: string): string {
  const lead = /^\s*/.exec(s)?.[0] ?? "";
  const trail = /\s*$/.exec(s)?.[0] ?? "";
  if (!s.trim()) return s;
  let core = s.slice(lead.length, s.length - trail.length);
  let pre = "";
  let post = "";
  const open = (ch: string) => ch === "（" || ch === "(";
  const close = (ch: string) => ch === "）" || ch === ")";
  while (core && open(core[0])) {
    pre += core[0];
    core = core.slice(1);
  }
  while (core && close(core[core.length - 1])) {
    post = core[core.length - 1] + post;
    core = core.slice(0, -1);
  }
  // 括号贴着公式时留在高亮外面，避免黄底切进公式
  while (core && open(core[core.length - 1])) {
    post = core[core.length - 1] + post;
    core = core.slice(0, -1);
  }
  while (core && close(core[0])) {
    pre += core[0];
    core = core.slice(1);
  }
  if (!core.trim()) return s;
  return `${lead}${pre}**${core}**${post}${trail}`;
}

/** 把已经定界的公式换成占位，避免 ==高亮== 的匹配穿进 $...$ */
function maskMathSpans(text: string): { text: string; slots: string[] } {
  const slots: string[] = [];
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\\" && text[i + 1] === "$") {
      out += "\\$";
      i += 2;
      continue;
    }
    if (text[i] !== "$") {
      out += text[i];
      i += 1;
      continue;
    }
    const display = text[i + 1] === "$";
    const from = i + (display ? 2 : 1);
    const close = findClosing(text, from, display);
    if (close < 0) {
      out += text[i];
      i += 1;
      continue;
    }
    const end = close + (display ? 2 : 1);
    const token = `\uE000${slots.length}=\uE001`;
    slots.push(text.slice(i, end));
    out += token;
    i = end;
  }
  return { text: out, slots };
}

/** ==术语== 涂黄。公式占位里含 =，高亮不会穿进公式。 */
function applyHighlight(text: string): string {
  const maskedMath = maskMathSpans(text);
  const slots = maskedMath.slots;
  const masked = maskedMath.text;

  let out = "";
  let i = 0;
  while (i < masked.length) {
    const open = masked.indexOf("==", i);
    if (open < 0) {
      out += masked.slice(i);
      break;
    }
    out += masked.slice(i, open);
    const close = findHighlightClose(masked, open + 2);
    if (close < 0) {
      out += "==";
      i = open + 2;
      continue;
    }
    const inner = masked.slice(open + 2, close);
    if (inner.includes("\uE002")) {
      out += `==${inner}==`;
      i = close + 2;
      continue;
    }
    out += highlightPieces(inner);
    i = close + 2;
  }
  return out.replace(
    /\uE000(\d+)=\uE001/g,
    (_m, n: string) => slots[Number(n)] ?? "",
  );
}

function findHighlightClose(s: string, from: number): number {
  let n = 0;
  let i = from;
  while (i < s.length && n <= 80) {
    if (s.startsWith("==", i)) return i;
    if (s[i] === "\n") return -1;
    if (s[i] === "\uE000" || s[i] === "\uE002") {
      const endCh = s[i] === "\uE000" ? "\uE001" : "\uE003";
      const end = s.indexOf(endCh, i + 1);
      if (end < 0) return -1;
      i = end + 1;
      n += 1;
      continue;
    }
    if (s[i] === "=") return -1;
    i += 1;
    n += 1;
  }
  return -1;
}

function highlightPieces(inner: string): string {
  const re = /\uE000\d+=\uE001/g;
  let out = "";
  let last = 0;
  for (const m of inner.matchAll(re)) {
    const idx = m.index ?? 0;
    out += wrapMark(inner.slice(last, idx));
    out += m[0];
    last = idx + m[0].length;
  }
  out += wrapMark(inner.slice(last));
  return out;
}

function textOf(node: HastNode): string {
  if (node.type === "text") return node.value ?? "";
  return (node.children ?? []).map(textOf).join("");
}

function isKatexError(node: HastNode): boolean {
  const cls = node.properties?.className;
  const list = Array.isArray(cls)
    ? cls.map(String)
    : typeof cls === "string"
      ? cls.split(/\s+/)
      : [];
  return list.includes("katex-error");
}

/**
 * 题库里的编辑标记，只给整理题目的人看。
 * `[推断]`、`[推断1]`、`[待补]`、`[待核]`、`[规范值]` 以及包住它们的反引号，不进同学看到的正文。
 */
function stripEditorialMarks(text: string): string {
  return text
    .replace(/\s*-\s*\*注：[\s\S]*?\*/g, "")
    .replace(
      /[ \t]*`?\*{0,2}[ \t]*[\[［]\s*(?:推断\d*|待补|待核|规范值)\s*[\]］][ \t]*`?\*{0,2}/g,
      " ",
    )
    .replace(/\*\*(?:\s*)\*\*/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+([，。；：、！？])/g, "$1");
}

const GREEK_TO_TEX: Record<string, string> = {
  α: "\\alpha",
  β: "\\beta",
  γ: "\\gamma",
  δ: "\\delta",
  ε: "\\varepsilon",
  ϵ: "\\varepsilon",
  ζ: "\\zeta",
  η: "\\eta",
  θ: "\\theta",
  ι: "\\iota",
  κ: "\\kappa",
  λ: "\\lambda",
  μ: "\\mu",
  ν: "\\nu",
  ξ: "\\xi",
  π: "\\pi",
  ρ: "\\rho",
  σ: "\\sigma",
  τ: "\\tau",
  φ: "\\varphi",
  ϕ: "\\varphi",
  χ: "\\chi",
  ψ: "\\psi",
  ω: "\\omega",
  Γ: "\\Gamma",
  Δ: "\\Delta",
  Θ: "\\Theta",
  Λ: "\\Lambda",
  Ξ: "\\Xi",
  Π: "\\Pi",
  Σ: "\\Sigma",
  Φ: "\\Phi",
  Ψ: "\\Psi",
  Ω: "\\Omega",
};

const UNI_SUB: Record<string, string> = {
  "₀": "0",
  "₁": "1",
  "₂": "2",
  "₃": "3",
  "₄": "4",
  "₅": "5",
  "₆": "6",
  "₇": "7",
  "₈": "8",
  "₉": "9",
  ₐ: "a",
  ₑ: "e",
  ₕ: "h",
  ᵢ: "i",
  ⱼ: "j",
  ₖ: "k",
  ₗ: "l",
  ₘ: "m",
  ₙ: "n",
  ₒ: "o",
  ₚ: "p",
  ᵣ: "r",
  ₛ: "s",
  ₜ: "t",
  ᵤ: "u",
  ᵥ: "v",
  ₓ: "x",
};

const UNI_SUP: Record<string, string> = {
  "⁰": "0",
  "¹": "1",
  "²": "2",
  "³": "3",
  "⁴": "4",
  "⁵": "5",
  "⁶": "6",
  "⁷": "7",
  "⁸": "8",
  "⁹": "9",
  ⁿ: "n",
};

/** 粘在一起的工程符号，如 fcbh0、h0、As、Smax。长的放前面。 */
const GLUED: [string, string][] = [
  ["smax", "S_{max}"],
  ["bh0", "bh_{0}"],
  ["h0", "h_{0}"],
  ["fc", "f_{c}"],
  ["fy", "f_{y}"],
  ["ft", "f_{t}"],
  ["fu", "f_{u}"],
  ["fb", "f_{b}"],
  ["as", "A_{s}"],
  ["b", "b"],
  ["h", "h"],
  ["d", "d"],
];

const OP_TO_TEX: Record<string, string> = {
  "≤": "\\le ",
  "≥": "\\ge ",
  "≠": "\\ne ",
  "≈": "\\approx ",
  "∈": "\\in ",
  "×": "\\times ",
  "·": "\\cdot ",
  "÷": "\\div ",
  "＝": "=",
  "＜": "\\lt ",
  "＞": "\\gt ",
  "＋": "+",
  "－": "-",
  "−": "-",
  "–": "-",
  "<": "\\lt ",
  ">": "\\gt ",
  "=": "=",
  "+": "+",
  "-": "-",
  "/": "/",
};

type PlainAtom = { end: number; latex: string; strong: boolean };
type PlainExpr = { end: number; latex: string; strong: boolean };

function isAsciiLetter(ch: string): boolean {
  return /[A-Za-z]/.test(ch);
}

function isFullwidthLetter(ch: string): boolean {
  if (!ch) return false;
  const c = ch.charCodeAt(0);
  return (c >= 0xff21 && c <= 0xff3a) || (c >= 0xff41 && c <= 0xff5a);
}

function isLatinLetter(ch: string): boolean {
  return isAsciiLetter(ch) || isFullwidthLetter(ch);
}

function foldLetter(ch: string): string {
  if (!isFullwidthLetter(ch)) return ch;
  return String.fromCharCode(ch.charCodeAt(0) - 0xfee0);
}

function isPrimeChar(ch: string): boolean {
  return ch === "′" || ch === "'" || ch === "’" || ch === "＇";
}

function readPrimeSup(text: string, j: number): { end: number; latex: string } {
  let end = j;
  let latex = "";
  let primes = "";
  while (isPrimeChar(text[end] || "")) {
    primes += "'";
    end += 1;
    if (primes.length >= 2) break;
  }
  if (primes) latex += primes;
  let sup = "";
  while (text[end] && UNI_SUP[text[end]]) {
    sup += UNI_SUP[text[end]];
    end += 1;
  }
  if (sup) latex += `^{${sup}}`;
  return { end, latex };
}

function readExplicitSub(
  text: string,
  j: number,
): { end: number; sub: string } | null {
  if (text[j] !== "_") return null;
  let k = j + 1;
  let sub = "";
  if (text[k] === "{") {
    const close = text.indexOf("}", k + 1);
    if (close < 0 || close - k > 24) return null;
    sub = text.slice(k + 1, close);
    k = close + 1;
  } else if (GREEK_TO_TEX[text[k] || ""]) {
    sub = GREEK_TO_TEX[text[k]];
    k += 1;
  } else if (/[A-Za-z0-9]/.test(text[k] || "")) {
    while (k < text.length && /[A-Za-z0-9]/.test(text[k])) {
      if (isAsciiLetter(text[k]) && UNI_SUB[text[k + 1]]) break;
      sub += text[k];
      k += 1;
    }
  } else {
    return null;
  }
  if (!sub) return null;
  const more = /^,(min|max|cu|cr)\b/.exec(text.slice(k));
  if (more) {
    sub += `,${more[1]}`;
    k += more[0].length;
  }
  return { end: k, sub };
}

function parseGlued(word: string): string | null {
  const lower = word.toLowerCase();
  if (lower === "as" && word === "as") return null;
  let k = 0;
  const parts: string[] = [];
  let strong = false;
  while (k < lower.length) {
    let hit: [string, string] | null = null;
    for (const pair of GLUED) {
      if (!lower.startsWith(pair[0], k)) continue;
      if (pair[0].length === 1 && lower.length === 1) continue;
      hit = pair;
      break;
    }
    if (!hit) return null;
    let latex = hit[1];
    if (hit[0] === "as") latex = word[k] === "a" ? "a_{s}" : "A_{s}";
    if (hit[0] === "smax") latex = `${word[k] === "s" ? "s" : "S"}_{max}`;
    if (latex.includes("_")) strong = true;
    parts.push(latex);
    k += hit[0].length;
  }
  if (!strong) return null;
  return parts.join("");
}

function readGreekAtom(text: string, i: number): PlainAtom | null {
  const cmd = GREEK_TO_TEX[text[i] || ""];
  if (!cmd) return null;
  let j = i + 1;
  let sub = "";
  const explicit = readExplicitSub(text, j);
  if (explicit) {
    sub = explicit.sub;
    j = explicit.end;
  } else if (isAsciiLetter(text[j] || "")) {
    const m = /^[A-Za-z]{1,3}/.exec(text.slice(j));
    if (m) {
      sub = m[0];
      j += m[0].length;
    }
  } else {
    const spaced = /^[ \t]+(\d)(?![0-9.])/.exec(text.slice(j));
    if (spaced) {
      const after = text[j + spaced[0].length] || "";
      if (
        !after ||
        after in OP_TO_TEX ||
        isCjk(after) ||
        isCjkPunct(after) ||
        /\s/.test(after)
      ) {
        sub = spaced[1];
        j += spaced[0].length;
      }
    }
  }
  let uni = "";
  while (UNI_SUB[text[j] || ""]) {
    uni += UNI_SUB[text[j]];
    j += 1;
  }
  if (uni) sub = sub ? sub + uni : uni;
  const tail = readPrimeSup(text, j);
  let latex = cmd;
  if (sub) latex += `_{${sub}}`;
  latex += tail.latex;
  return { end: tail.end, latex, strong: true };
}

function readLatinAtom(text: string, i: number): PlainAtom | null {
  if (!isLatinLetter(text[i] || "")) return null;
  if (i > 0 && isLatinLetter(text[i - 1])) return null;
  const baseM = /^[A-Za-z\uFF21-\uFF3A\uFF41-\uFF5A]+/.exec(text.slice(i));
  if (!baseM) return null;
  const base = [...baseM[0]].map(foldLetter).join("");
  let j = i + baseM[0].length;

  const explicit = readExplicitSub(text, j);
  if (explicit) {
    const tail = readPrimeSup(text, explicit.end);
    return {
      end: tail.end,
      latex: `${base}_{${explicit.sub}}${tail.latex}`,
      strong: true,
    };
  }
  if (UNI_SUB[text[j] || ""]) {
    let uni = "";
    while (UNI_SUB[text[j] || ""]) {
      uni += UNI_SUB[text[j]];
      j += 1;
    }
    const tail = readPrimeSup(text, j);
    return {
      end: tail.end,
      latex: `${base}_{${uni}}${tail.latex}`,
      strong: true,
    };
  }
  if (
    base.length <= 2 &&
    (UNI_SUP[text[j] || ""] || isPrimeChar(text[j] || ""))
  ) {
    const tail = readPrimeSup(text, j);
    if (tail.end > j)
      return { end: tail.end, latex: `${base}${tail.latex}`, strong: true };
  }

  const chunkM = /^[A-Za-z0-9\uFF21-\uFF3A\uFF41-\uFF5A]+/.exec(text.slice(i));
  if (chunkM) {
    const word = [...chunkM[0]]
      .map((c) => (isLatinLetter(c) ? foldLetter(c) : c))
      .join("");
    const glued = parseGlued(word);
    if (glued) {
      const tail = readPrimeSup(text, i + chunkM[0].length);
      return { end: tail.end, latex: `${glued}${tail.latex}`, strong: true };
    }
    if (/\d/.test(word)) return null;
  }
  if (base.length === 1)
    return { end: i + baseM[0].length, latex: base, strong: false };
  return null;
}

function readNumberAtom(text: string, i: number): PlainAtom | null {
  if (i > 0 && /[A-Za-z0-9.]/.test(text[i - 1] || "")) return null;
  const m = /^(\d+(?:\.\d+)?)(%?)/.exec(text.slice(i));
  if (!m) return null;
  return {
    end: i + m[0].length,
    latex: m[2] ? `${m[1]}\\%` : m[1],
    strong: false,
  };
}

function readPlainAtom(text: string, i: number): PlainAtom | null {
  return (
    readGreekAtom(text, i) || readLatinAtom(text, i) || readNumberAtom(text, i)
  );
}

function readOpAt(
  text: string,
  i: number,
): { end: number; latex: string } | null {
  const ch = text[i];
  if (!ch || !(ch in OP_TO_TEX)) return null;
  if (ch === "=" && text[i + 1] === "=") return null;
  if ((ch === "<" || ch === ">") && text[i + 1] === ch) return null;
  return { end: i + 1, latex: OP_TO_TEX[ch] };
}

function skipPlainSpace(text: string, i: number): number {
  let j = i;
  while (text[j] === " " || text[j] === "\t") j += 1;
  return j;
}

function readGroup(text: string, i: number): PlainExpr | null {
  const open = text[i];
  if (open !== "(" && open !== "[") return null;
  const close = open === "(" ? ")" : "]";
  const inner = matchPlainExpr(text, i + 1, true, false);
  if (!inner || !inner.latex || text[inner.end] !== close) return null;
  return {
    end: inner.end + 1,
    latex: open + inner.latex + close,
    strong: inner.strong,
  };
}

function matchPlainExpr(
  text: string,
  i: number,
  allowComma: boolean,
  requireStrong = true,
): PlainExpr | null {
  let latex = "";
  let strong = false;
  let pos = i;
  let end = i;
  let pending = "";
  let expectAtom = true;

  const commit = (piece: string, next: number, isStrong: boolean) => {
    latex += pending + piece;
    pending = "";
    if (isStrong) strong = true;
    pos = next;
    end = next;
    expectAtom = false;
  };

  for (let guard = 0; guard < 80 && pos < text.length; guard += 1) {
    if (expectAtom) {
      const j = latex || pending ? skipPlainSpace(text, pos) : pos;
      const group = readGroup(text, j);
      if (group) {
        commit(group.latex, group.end, group.strong);
        continue;
      }
      const atom = readPlainAtom(text, j);
      if (!atom) break;
      commit(atom.latex, atom.end, atom.strong);
      continue;
    }

    const sp = skipPlainSpace(text, pos);
    const gap = sp > pos ? " " : "";
    if (allowComma && text[sp] === ",") {
      const next = skipPlainSpace(text, sp + 1);
      if (
        readPlainAtom(text, next) ||
        text[next] === "(" ||
        text[next] === "["
      ) {
        pending = `${gap},`;
        pos = sp + 1;
        expectAtom = true;
        continue;
      }
    }
    const op = readOpAt(text, sp);
    if (op) {
      pending = gap + op.latex;
      pos = op.end;
      expectAtom = true;
      continue;
    }
    const group = readGroup(text, sp);
    if (group) {
      commit(gap + group.latex, group.end, group.strong);
      continue;
    }
    const atom = readPlainAtom(text, sp);
    if (atom?.strong) {
      commit(gap + atom.latex, atom.end, true);
      continue;
    }
    break;
  }
  if (!latex) return null;
  if (requireStrong && !strong) return null;
  return { end, latex, strong };
}

function tryPlainExpr(text: string, i: number): PlainExpr | null {
  if (i > 0) {
    const prev = text[i - 1];
    if (isLatinLetter(prev) || /[0-9.]/.test(prev) || prev === "\\")
      return null;
  }
  const ch = text[i];
  if (!ch || ch === "$" || ch === "`" || ch === "*") return null;
  if (!(GREEK_TO_TEX[ch] || isLatinLetter(ch) || /[0-9(]/.test(ch)))
    return null;
  return matchPlainExpr(text, i, false);
}

function pullLeadingOps(out: string): { out: string; latex: string } {
  let i = out.length;
  let latex = "";
  while (i > 0) {
    let j = i;
    while (j > 0 && (out[j - 1] === " " || out[j - 1] === "\t")) j -= 1;
    if (j === 0 || out[j - 1] === "$") break;
    const start = j - 1;
    const op = readOpAt(out, start);
    if (!op || op.end !== j) break;
    if (out[start] === "=" && out[start - 1] === "=") break;
    latex = op.latex + latex;
    i = start;
  }
  return { out: out.slice(0, i), latex };
}

/**
 * 把题库里写成纯文本的公式补上 $...$。
 * ε_s、εs、ξ_b、a_s′、h₀、λ<1 这类都会进 KaTeX；已经写好的 $...$ 和行内代码不动。
 */
function promotePlainFormulas(text: string): string {
  let out = "";
  let i = 0;
  while (i < text.length) {
    if (text[i] === "\uE002") {
      const end = text.indexOf("\uE003", i);
      const to = end < 0 ? text.length : end + 1;
      out += text.slice(i, to);
      i = to;
      continue;
    }
    if (text[i] === "$") {
      const display = text[i + 1] === "$";
      const from = i + (display ? 2 : 1);
      const close = findClosing(text, from, display);
      if (close < 0) {
        out += text.slice(i);
        break;
      }
      const to = close + (display ? 2 : 1);
      out += text.slice(i, to);
      i = to;
      continue;
    }
    const hit = tryPlainExpr(text, i);
    if (hit) {
      const pulled = pullLeadingOps(out);
      out = pulled.out + `$${pulled.latex}${hit.latex}$`;
      i = hit.end;
      continue;
    }
    out += text[i];
    i += 1;
  }
  return out;
}

/** KaTeX 仍失败时，用可读文字换掉红色源码，避免整段空白或把反斜杠甩给学生 */
export function rehypeDemoteKatexErrors() {
  return (tree: HastNode) => {
    const visit = (node: HastNode) => {
      const kids = node.children;
      if (!kids) return;
      for (let i = 0; i < kids.length; i++) {
        const child = kids[i];
        if (child.type === "element" && isKatexError(child)) {
          kids[i] = { type: "text", value: demoteLatex(textOf(child)) };
        } else {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

export function prepareMathMarkdown(text: string): string {
  if (!text) return "";
  let t = text;
  const fence = t.search(/```(card|diagram|slide|verdict)/);
  if (fence >= 0) t = t.slice(0, fence);
  t = stripEditorialMarks(t);
  // 先保护代码，再一次性识别完整公式。提前逐符号加 $ 会拆断表达式并产生嵌套定界符。
  const masked = maskCode(t);
  const promoted = promotePlainFormulas(masked.text);
  let out = "";
  for (const tok of splitMathRegions(promoted)) {
    out +=
      tok.t === "math" ? finalize(tok.body, tok.display) : wrapBareLatex(tok.s);
  }
  return unmask(applyHighlight(out), masked.blocks);
}
