import { z } from "zod";
import { PageNoteSchema } from "./import-schemas";
import { structured, modelMetrics, type ModelMetrics } from "./models/provider";

export function normalizePageTitle(title: string) {
  return title.trim().replace(/[\s:：;；,，。.!！?？、…]+$/u, "");
}

function isPlaceholder(title: string) {
  return /^(?:第\s*[\d一二三四五六七八九十百零〇]+\s*页|(?:page|slide)\s*\d+|\d+)$/i.test(
    title,
  );
}

export function pageTitle(text: string, language = "zh") {
  return (
    text
      .split(/\r?\n/)
      .map((line) => normalizePageTitle(line.slice(0, 120)))
      .find((line) => line && !isPlaceholder(line)) ||
    (language.startsWith("en") ? "Page content to review" : "页面内容待核对")
  );
}

export const notePrompt = (text: string, title: string, language = "zh") =>
  `整理这一页的学习要点，不补充原文以外的结论。课程语言：${language.trim() || "zh"}。title、points、keys 必须使用课程语言（zh 为中文），即使原页只有英文标题或问题也要用课程语言表达，专业术语可括注英文。text 保持页面原文语言，扫描页必须根据页图完整转录可辨认文字，不得用要点代替原文。标题应根据页面内容生成简短、具体的主题，不得使用“第 N 页”或“Page N”等页码占位标题；标题末尾不要冒号或其他标点。没有原始标题时也要根据内容拟题。返回 JSON {"title":"标题","points":["1–5 条要点，可用 $LaTeX$"],"keys":["关键词"],"text":"页面原文；扫描页必须转录"}。\n标题参考：${title}\n原文：\n${text.slice(0, 18000)}`;

export type PageNoteResult = {
  note: z.infer<typeof PageNoteSchema>;
  model: string;
  tokens: number;
  ruleBased: boolean;
  metrics: ModelMetrics;
};

export async function generatePageNote({
  text,
  language = "zh",
  image,
  transcribe = false,
  signal,
}: {
  text: string;
  language?: string;
  image?: string;
  transcribe?: boolean;
  signal?: AbortSignal;
}): Promise<PageNoteResult> {
  const title = pageTitle(text, language);
  const schema = PageNoteSchema.transform((note) => ({
    ...note,
    title: normalizePageTitle(note.title),
  })).superRefine((note, ctx) => {
    if (!note.title || isPlaceholder(note.title))
      ctx.addIssue({
        code: "custom",
        message: "请根据页面内容生成具体主题标题，不能只用页码或标点",
      });
    if (transcribe && !note.text?.trim())
      ctx.addIssue({
        code: "custom",
        message: "扫描页必须转录页面原文到 text",
      });
  });
  let model = "rules:no-model";
  let metrics = modelMetrics();
  try {
    const result = await structured(
      "notes",
      schema,
      notePrompt(text, title, language),
      image,
      {
        signal,
        retries: 2,
        onMetrics: (value) => {
          metrics = value;
        },
      },
    );
    if (result)
      return {
        note: result.data,
        model: result.model,
        tokens: result.tokens,
        ruleBased: false,
        metrics,
      };
  } catch {
    signal?.throwIfAborted();
    model = "rules:model-failed";
  }
  return {
    note: {
      title,
      points: text.trim()
        ? text
            .split(/\n|(?<=[。.!?])\s+/)
            .map((line) => line.trim())
            .filter(Boolean)
            .slice(0, 5)
            .map((line) => line.slice(0, 400))
        : [
            language.startsWith("en")
              ? "No text was extracted. Review the page image and retry with a vision model."
              : "此页未提取到文本，请查看页图；配置或恢复视觉模型后可重新导入。",
          ],
      keys: [title],
    },
    model,
    tokens: 0,
    ruleBased: true,
    metrics,
  };
}
