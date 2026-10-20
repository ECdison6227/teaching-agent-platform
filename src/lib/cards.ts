import { z } from "zod";

/** 数据补充卡 / 计算卡的字段定义 */
const FieldSchema = z.object({
  key: z.string(),
  label: z.string(),
  unit: z.string().optional(),
  placeholder: z.string().optional(),
});

/** ref：若卡片取自题库，填题目编号（如 SC-42），用于按答案表判定 */
const refField = z.string().optional();

/** 附图：卡片可挂一张流程图（HTML 片段）或一张 PPT 页面图 */
export const FigureSchema = z.union([
  z.object({
    kind: z.literal("diagram"),
    html: z.string(),
    caption: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slide"),
    page: z.number().int().min(1),
    caption: z.string().optional(),
  }),
  z.object({
    kind: z.literal("slides"),
    pages: z.array(z.number().int().min(1)).min(1),
    caption: z.string().optional(),
  }),
]);
export type Figure = z.infer<typeof FigureSchema>;

/** 卡片可选挂一张附图，学生可点开看大图 */
const figureField = FigureSchema.optional();

/** 选择题卡：从题库或知识点出的概念/判断类选择 */
export const ChoiceCardSchema = z.object({
  kind: z.literal("choice"),
  prompt: z.string(),
  options: z.array(z.object({ id: z.string(), text: z.string() })).min(2),
  hint: z.string().optional(),
  topic: z.string().optional(),
  ref: refField,
  figure: figureField,
});

/** 判断题卡 */
export const TrueFalseCardSchema = z.object({
  kind: z.literal("truefalse"),
  prompt: z.string(),
  hint: z.string().optional(),
  topic: z.string().optional(),
  ref: refField,
  figure: figureField,
});

/** 数据补充卡：学生缺条件时弹出，逐项列出缺失信息（必填） */
export const DataCardSchema = z.object({
  kind: z.literal("data"),
  prompt: z.string(),
  fields: z.array(FieldSchema).min(1),
  hint: z.string().optional(),
  topic: z.string().optional(),
  ref: refField,
  figure: figureField,
});

/** 计算卡：分步计算，每步填一个值 */
export const CalcCardSchema = z.object({
  kind: z.literal("calc"),
  prompt: z.string(),
  fields: z.array(FieldSchema).min(1),
  hint: z.string().optional(),
  topic: z.string().optional(),
  ref: refField,
  figure: figureField,
});

export const CardSchema = z.discriminatedUnion("kind", [
  ChoiceCardSchema,
  TrueFalseCardSchema,
  DataCardSchema,
  CalcCardSchema,
]);

export type Card = z.infer<typeof CardSchema>;
export type CardField = z.infer<typeof FieldSchema>;

/** 作答判定：模型对学生上一张卡片答案的判定结果 */
export const VerdictSchema = z.object({
  correct: z.boolean(),
  reason: z.string().optional(),
  topic: z.string().optional(),
});
export type Verdict = z.infer<typeof VerdictSchema>;

/** 学生提交的答案 */
export type CardAnswer =
  | { kind: "choice"; choiceId: string }
  | { kind: "truefalse"; value: boolean }
  | { kind: "data"; values: Record<string, string> }
  | { kind: "calc"; values: Record<string, string> };

/** 把学生的卡片作答渲染成发给模型的文本 */
export function formatAnswer(card: Card, answer: CardAnswer): string {
  if (card.kind === "choice" && answer.kind === "choice") {
    const opt = card.options.find((o) => o.id === answer.choiceId);
    return `我的选择是：${answer.choiceId}${opt ? `（${opt.text}）` : ""}`;
  }
  if (card.kind === "truefalse" && answer.kind === "truefalse") {
    return `我的判断是：${answer.value ? "正确（√）" : "错误（×）"}`;
  }
  if (
    (card.kind === "data" || card.kind === "calc") &&
    (answer.kind === "data" || answer.kind === "calc")
  ) {
    const parts = card.fields.map((f) => {
      const v = answer.values[f.key] ?? "";
      return `${f.label} = ${v}${f.unit ? ` ${f.unit}` : ""}`;
    });
    return `我填写的数据：${parts.join("；")}`;
  }
  return "我的作答见上。";
}
