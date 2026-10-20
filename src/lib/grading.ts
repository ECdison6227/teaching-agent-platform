import type { Question as StoredQuestion } from "../db/schema";
type Question = Pick<StoredQuestion, "answer" | "type" | "verified"> & {
  acceptedAnswers?: string[][];
  tolerance?: number;
};

function norm(value: string) {
  return value
    .normalize("NFKC")
    .replace(/\s+/g, "")
    .replace(/[()。，、；：？！"'“”‘’]/g, "")
    .toLowerCase();
}

export function normLetter(value: string): string {
  const text = norm(String(value ?? ""));
  if (/^(t|true|正确|对|√|是)$/.test(text)) return "T";
  if (/^(f|false|错误|错|×|否)$/.test(text)) return "F";
  return /^[a-z]$/.test(text) ? text.toUpperCase() : text;
}

function alternatives(answer: string): string[] {
  const values = [answer];
  const parenthetical = answer.match(/^(.*?)[（(]或(.+)[）)]$/);
  if (parenthetical)
    values.push(parenthetical[1], ...parenthetical[2].split("或"));
  else if (answer.includes("或")) values.push(...answer.split("或"));
  return values.map(norm).filter(Boolean);
}

function numeric(value: string): { value: number; unit: string } | null {
  const match = norm(value).match(
    /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?)(%|[a-z\u4e00-\u9fff][a-z\u4e00-\u9fff0-9/^·²³]*)?$/,
  );
  if (!match) return null;
  const number = Number(match[1]);
  if (!Number.isFinite(number)) return null;
  return {
    value: match[2] === "%" ? number / 100 : number,
    unit: match[2] === "%" ? "" : (match[2] ?? ""),
  };
}

/** 多空保持顺序；仅接受明确等价写法，不能用子串或第一个数字判题。 */
export function grade(question: Question, raw: string): boolean | null {
  const answer = question.answer?.trim();
  const input = raw.trim();
  if (
    !answer ||
    !input ||
    question.verified === false ||
    question.type === "short"
  )
    return null;
  if (question.type !== "fill" && question.type !== "calc")
    return normLetter(answer) === normLetter(input);
  const expected = answer.split(/[;；]/).map((part) => part.trim());
  const submitted = input.split(/[;；]/).map((part) => part.trim());
  if (expected.length !== submitted.length || submitted.some((part) => !part))
    return false;
  let uncertain = false;
  for (let index = 0; index < expected.length; index++) {
    const accepted = [
      ...alternatives(expected[index]),
      ...(question.acceptedAnswers?.[index] ?? []).map(norm),
    ];
    const text = norm(submitted[index]);
    if (accepted.includes(text)) continue;
    const actualNumber = numeric(submitted[index]);
    const numbers = accepted
      .map(numeric)
      .filter(
        (value): value is NonNullable<ReturnType<typeof numeric>> =>
          value !== null,
      );
    if (
      actualNumber &&
      numbers.some(
        (value) =>
          (value.unit === actualNumber.unit ||
            (value.unit !== "" && actualNumber.unit === "")) &&
          Math.abs(value.value - actualNumber.value) <=
            (question.tolerance ?? 1e-6),
      )
    )
      continue;
    if (expected[index].length > 20 && !numbers.length) uncertain = true;
    else return false;
  }
  return uncertain ? null : true;
}
