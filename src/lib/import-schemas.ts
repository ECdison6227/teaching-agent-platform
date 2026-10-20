import { z } from "zod";
export const StructureSchema = z.object({
  chapters: z
    .array(
      z.object({
        title: z.string().min(1).max(200),
        summary: z.string().max(2000).optional(),
        knowledgePoints: z
          .array(
            z.object({
              title: z.string().min(1).max(200),
              keywords: z.array(z.string().max(100)).max(20).default([]),
              pages: z.array(z.number().int().positive()).max(500),
            }),
          )
          .min(1)
          .max(100),
      }),
    )
    .min(1)
    .max(50),
});
export const PageNoteSchema = z.object({
  title: z.string().min(1).max(200),
  points: z.array(z.string().min(1).max(3000)).min(1).max(8),
  keys: z.array(z.string().max(100)).max(12),
  text: z.string().max(30000).optional(),
});
export const TextbookSchema = z.object({
  content_md: z.string().min(1).max(30000),
});
export const QuestionsSchema = z.object({
  questions: z
    .array(
      z.object({
        type: z.enum(["choice", "truefalse", "fill", "calc", "short"]),
        prompt: z.string().min(1).max(10000),
        options: z
          .array(
            z.object({ id: z.string().max(10), text: z.string().max(3000) }),
          )
          .min(2)
          .max(12)
          .optional(),
        answer: z.string().max(5000).nullable().optional(),
        analysis: z.string().max(10000).optional(),
        sourceQuestionId: z.string().max(40).optional(),
        kpId: z.string().max(100).nullable().default(null),
        kpConfidence: z.number().min(0).max(1).default(0),
        kpCode: z.string().max(20).optional(),
        pages: z.array(z.number().int().positive()).max(30).default([]),
        sourcePage: z.number().int().positive().optional(),
        confidence: z.enum(["high", "mid", "low"]).default("low"),
      }),
    )
    .max(200),
});

export const QuestionAnswerSchema = z.object({
  answer: z.string().trim().min(1).max(5000).nullable(),
  analysis: z.string().min(1).max(10000),
});
