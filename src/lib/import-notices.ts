import type { CourseContent } from "./courses";

export function importNotices(
  data: Pick<CourseContent, "importItems" | "questions">,
) {
  const groups = new Map<
    string,
    {
      label: string;
      items: { key: string; message: string; questionId?: string }[];
    }
  >();
  for (const item of data.importItems) {
    if (item.status === "done") continue;
    const kind = item.key.split(":")[0];
    const q =
      kind === "answers"
        ? data.questions.find((q) => item.key === `answers:${q.id}`)
        : undefined;
    // Durable historical markers need not keep warning after a teacher supplies an answer.
    if (q?.answer?.trim()) continue;
    const type =
      kind === "answers" && item.status === "pending" ? "rate_limit" : kind;
    const label =
      (
        {
          rate_limit: "题答案因限流待处理",
          answers: "题答案待补",
          questions: "批习题使用规则抽取",
          textbook: "份讲义待核对",
          structure: "项课程结构待核对",
          formulas: "项公式待核对",
        } as Record<string, string>
      )[type] || "项内容待核对";
    const group = groups.get(type) ?? { label, items: [] };
    group.items.push({
      key: item.key,
      message: `${q?.code ? `${q.code}：` : ""}${item.message || "内容待核对"}`,
      questionId: q?.id,
    });
    groups.set(type, group);
  }
  const priority: Record<string, number> = {
    questions: 0,
    answers: 1,
    rate_limit: 2,
    formulas: 3,
    textbook: 4,
    structure: 5,
  };
  return [...groups.entries()]
    .sort(([left], [right]) => (priority[left] ?? 99) - (priority[right] ?? 99))
    .map(([type, group]) => ({
      ...group,
      type,
      summary: `${group.items.length} ${group.label}`,
    }));
}
