/** 通用节奏预算；不包含课程内容。 */
export const MAX_GUIDANCE_CHARS = 280;
export const MAX_GUIDANCE_SENTENCES = 2;
export const MAX_SOLVE_CARDS = 3;
export const MAX_TOPIC_CARDS = 2;

/** 只统计正文，不把代码、公式中的标点当成提问或句末。 */
export function guidanceText(text: string) {
  return text
    .replace(/```[^\n]*\n[\s\S]*?(?:```|$)/g, "")
    .replace(/^\s*\[判定\][^\n]*(?:\n|$)/, "")
    .replace(/`[^`]*`|\$\$[\s\S]*?\$\$|\$[^$\n]*\$/g, "");
}

export function guidanceStats(text: string) {
  const prose = guidanceText(text).trim();
  return {
    chars: prose.length,
    questions: (prose.match(/[?？]/g) || []).length,
    sentences: (prose.match(/[。！？!?]+|\.(?=\s|$)/g) || []).length,
  };
}

/** 流式兜底只留下首个问题与有限正文；跨 delta 保留行内代码/公式状态。 */
export function createGuidanceLimiter() {
  let chars = 0;
  let stopped = false;
  let code = false;
  let math = false;
  let escaped = false;
  let previousDollar = false;
  return (delta: string) => {
    let result = "";
    for (const c of delta) {
      if (stopped) break;
      if (chars >= MAX_GUIDANCE_CHARS) {
        stopped = true;
        break;
      }
      result += c;
      chars++;
      if (!escaped) {
        if (c === "`" && !math) code = !code;
        if (c === "$" && !code && !previousDollar) math = !math;
        if (!code && !math && /[?？]/.test(c)) stopped = true;
      }
      previousDollar = c === "$" && !escaped;
      escaped = c === "\\" && !escaped;
    }
    return result;
  };
}
