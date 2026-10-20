/** Rules only change question/option markers, never normalize formula text. */
export type QuestionType = "choice" | "truefalse" | "fill" | "calc" | "short";
export type QuestionOption = { id: string; text: string };
export type QuestionBoundary = {
  id: string;
  page: number;
  text: string;
  typeHint?: QuestionType;
  numbered: boolean;
};
const numberPrefix =
  /^(?:(?:QUESTION\s+|Q\s*)[0-9０-９]+\s*[.．、:：)）]?|[（(]\s*[0-9０-９]+\s*[)）]\s*[.．、]?|[0-9０-９]+\s*[.．、)）](?![0-9０-９]))\s*/i;
export function stripQuestionNumber(text: string) {
  return text.trim().replace(numberPrefix, "").trim();
}
export function questionHeading(text: string): QuestionType | undefined {
  const title = text
    .trim()
    .replace(/^(?:[（(]?[一二三四五六七八九十\d]+[)）、.．]\s*)/, "");
  if (title.length > 90) return;
  if (
    /^(?:单项?选择题?|多项?选择题?|选择题|multiple[- ]choice)(?:\s|[（(:：]|$)/i.test(
      title,
    )
  )
    return "choice";
  if (/^(?:判断题|是非题|true\s*[/／-]\s*false)(?:\s|[（(:：]|$)/i.test(title))
    return "truefalse";
  if (
    /^(?:填空题|fill[- ]in(?:[- ]the[- ]blanks)?)(?:\s|[（(:：]|$)/i.test(title)
  )
    return "fill";
  if (/^(?:计算题|计算分析题|calculation(?:s)?)(?:\s|[（(:：]|$)/i.test(title))
    return "calc";
  if (/^(?:简答题|问答题|解答题|short[- ]answer)(?:\s|[（(:：]|$)/i.test(title))
    return "short";
}
export function splitQuestionOptions(text: string): {
  prompt: string;
  options?: QuestionOption[];
} {
  // Mask delimited math before scanning; offsets still refer to the original text.
  const scanned = text.replace(
    /\$\$[\s\S]*?\$\$|\$[^$\n]*?\$|\\\([\s\S]*?\\\)|\\\[[\s\S]*?\\\]/g,
    (math) => math.replace(/[^\n]/g, " "),
  );
  const pattern =
    /(?<![A-Za-z\\])(?:[（(]\s*([A-HＡ-Ｈ])\s*[)）]|([A-HＡ-Ｈ])\s*[.．、)）:：])/gm;
  const marks = [...scanned.matchAll(pattern)];
  const ordered = marks.filter(
    (m, i) => (m[1] || m[2]).normalize("NFKC").charCodeAt(0) === 65 + i,
  );
  if (ordered.length < 2 || ordered.length !== marks.length)
    return { prompt: text.trim() };
  return {
    prompt: text.slice(0, marks[0].index).trim(),
    options: marks.map((m, i) => ({
      id: (m[1] || m[2]).normalize("NFKC"),
      text: text
        .slice(m.index! + m[0].length, marks[i + 1]?.index ?? text.length)
        .trim(),
    })),
  };
}
export function normalizeQuestion(
  input: {
    prompt: string;
    type?: QuestionType;
    options?: QuestionOption[] | null;
  },
  hint?: QuestionType,
) {
  const split = splitQuestionOptions(stripQuestionNumber(input.prompt));
  const options =
    split.options ||
    (input.options && input.options.length >= 2
      ? input.options.map((o) => ({
          ...o,
          id: o.id
            .normalize("NFKC")
            .replace(/[.．、()（）\s]/g, "")
            .toUpperCase(),
        }))
      : undefined);
  const type: QuestionType = options
    ? "choice"
    : hint ||
      (/_{2,}|＿{2,}|（\s*）|\(\s*\)/.test(split.prompt) &&
      input.type !== "truefalse"
        ? "fill"
        : /(?:判断正误|判断下列|true\s*\/\s*false)/i.test(split.prompt)
          ? "truefalse"
          : /^(?:计算|求出|求解|calculate|compute)\b|^(?:计算|求出|求解)/i.test(
                split.prompt,
              )
            ? "calc"
            : input.type || "short");
  return { ...input, prompt: split.prompt, type, options };
}
export function questionBoundaries(
  pages: readonly { text: string }[],
): QuestionBoundary[] {
  const result: QuestionBoundary[] = [];
  let hint: QuestionType | undefined;
  let current: QuestionBoundary | undefined;
  let loose: QuestionBoundary | undefined;
  const flush = () => {
    if (current) result.push(current);
    current = undefined;
  };
  for (const [pageIndex, page] of pages.entries()) {
    for (const line of page.text.split(/\r?\n/)) {
      const heading = questionHeading(line);
      if (heading) {
        flush();
        hint = heading;
        continue;
      }
      if (numberPrefix.test(line.trim())) {
        flush();
        current = {
          id: "",
          page: pageIndex + 1,
          text: line.trim(),
          typeHint: hint,
          numbered: true,
        };
      } else if (current) current.text += `\n${line}`;
      else if (line.trim()) {
        loose ||= {
          id: "",
          page: pageIndex + 1,
          text: "",
          typeHint: hint,
          numbered: false,
        };
        loose.text += `\n${line}`;
      }
    }
  }
  flush();
  if (!result.length && loose) result.push(loose);
  return result.map((q, i) => ({
    ...q,
    id: String(i + 1),
    text: q.text.trim(),
  }));
}
export function ruleQuestion(q: QuestionBoundary) {
  const answer =
    q.text.match(/(?:答案|Answer)\s*[:：]\s*([^\n]+)/i)?.[1]?.trim() || null;
  const prompt = q.text.replace(/(?:答案|Answer)\s*[:：][\s\S]*/i, "").trim();
  return {
    ...normalizeQuestion({ prompt }, q.typeHint),
    answer,
    analysis: "",
    pages: [] as number[],
    sourcePage: q.page,
    confidence: "low" as const,
    kpId: null,
    kpConfidence: 0,
    sourceQuestionId: q.id,
  };
}
