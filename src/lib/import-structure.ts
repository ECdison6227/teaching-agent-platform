import { z } from "zod";
import { StructureSchema } from "./import-schemas";

export function knowledgePointRange(pageCount: number) {
  return {
    min: Math.min(8, Math.max(1, Math.ceil(pageCount / 20))),
    max: Math.min(20, Math.max(3, Math.ceil(pageCount / 3))),
  };
}
function isConceptTitle(title: string) {
  return (
    !!title.trim() &&
    !/^(?:习题|练习|小结|问题|总结|复习题|questions?\b|exercises?\b|summary\b)/i.test(
      title.trim(),
    )
  );
}
export function fallbackKnowledgePointTitle(titles: string[], index: number) {
  return titles.find(isConceptTitle) || `课程概念 ${index + 1}（待核对）`;
}
export function structureSchema(pageCount: number) {
  return StructureSchema.superRefine((tree, ctx) => {
    const points = tree.chapters.flatMap((chapter) => chapter.knowledgePoints);
    const { min, max } = knowledgePointRange(pageCount);
    let next = 1;
    const invalid =
      points.length < min ||
      points.length > max ||
      points.some((kp) => {
        if (!isConceptTitle(kp.title)) return true;
        return kp.pages.some((page) => page !== next++);
      });
    if (invalid || next !== pageCount + 1)
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `知识点须为 ${min}–${max} 项，按章节顺序覆盖不重叠的连续页段，不能以习题/小结/问题为知识点`,
      });
  });
}
export function structurePrompt(pageCount: number) {
  const { min, max } = knowledgePointRange(pageCount);
  return `按页面内容划分章节和知识点，知识点总数限制在 ${min}–${max} 项。禁止把“习题、练习、小结、问题、总结”等非知识点栏目单独列为知识点，应归入对应概念。按课件章节和页面顺序排列；每个有课件的知识点覆盖连续页段，全部课内页码 1–${pageCount} 必须且只能出现一次，不得交错、跳页或重复。教材拓展可使用空 pages。返回 {"chapters":[{"title":"章节","summary":"概述","knowledgePoints":[{"title":"具体概念","keywords":["词"],"pages":[1,2]}]}]}。`;
}
