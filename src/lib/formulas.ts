import { z } from "zod";

export const FormulaRecoverySchema = z.object({
  status: z.enum(["recovered", "missing"]),
  evidence: z.array(
    z.object({
      source: z.enum(["omml", "vision"]),
      confidence: z.number().min(0).max(1),
      latex: z.array(z.string()),
    }),
  ),
  reasons: z.array(z.string()),
});
export type FormulaRecovery = z.infer<typeof FormulaRecoverySchema>;
export const missingFormula = "[公式缺失]";
export function latexFormulas(text: string) {
  return [...text.matchAll(/\$\$([\s\S]+?)\$\$|(?<!\\)\$([^$\n]+?)\$/g)].map(
    (m) => m[1] || m[2],
  );
}
/** Ignore response blanks and ordinary fill-in blanks; layout indentation is not a gap. */
export function formulaGapReasons(
  text: string,
  options?: { text: string }[] | null,
) {
  const prose = text.replace(/\$\$[\s\S]*?\$\$|\$[^$\n]*?\$/g, "FORMULA");
  const reasons: string[] = [];
  const math =
    /[=<>≤≥≠+×÷∑√]|公式|表达式|方程|函数|矩阵|系数|向量|满足|若|如果|已知|when|if\b|equation|formula|expression|compute|calculate/i;
  if (prose.includes(missingFormula)) reasons.push("嵌入式公式无法解析");
  if (options?.some((o) => !o.text.trim())) reasons.push("选项为空");
  if (math.test(prose)) {
    if (
      /[_＿]{2,}/.test(prose) &&
      !/[_＿]{2,}\s*[。.!！?？]*\s*$/.test(prose) &&
      !/(?:填空|fill[ -]in)/i.test(prose)
    )
      reasons.push("数学上下文中有下划线占位");
    if (/\S[^\S\r\n]{2,}\S/.test(prose)) reasons.push("数学上下文中有连续空白");
    // A trailing （ ） or ( ) is normally the answer slot for choice/true-false.
    const withoutAnswerSlot = prose.replace(
      /[（(]\s*[)）]\s*[。.!！?？:：,，;；]*\s*$/,
      "",
    );
    if (/[（(]\s*[)）]/.test(withoutAnswerSlot))
      reasons.push("数学上下文中有空括号");
    if (/(?:若|如果|满足|已知|if|when)\s*[,，;；]/i.test(prose))
      reasons.push("数学条件为空");
  }
  for (const option of options || []) {
    if (option.text.trim() && formulaGapReasons(option.text).length)
      reasons.push("选项疑似公式缺失");
  }
  return [...new Set(reasons)];
}
