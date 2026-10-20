import { z } from "zod";
import {
  MAX_HISTORY_CHARS,
  MAX_IMAGE_URL_LENGTH,
  MAX_MESSAGE_CHARS,
} from "./request-limits";
export function chatRequestSchema(pageCount: number) {
  const part = z.discriminatedUnion("type", [
    z.object({
      type: z.literal("text"),
      text: z.string().max(MAX_MESSAGE_CHARS),
    }),
    z.object({
      type: z.literal("image_url"),
      image_url: z.object({
        url: z
          .string()
          .max(MAX_IMAGE_URL_LENGTH)
          .regex(
            /^data:image\/(?:png|jpeg|webp|gif);base64,[A-Za-z0-9+/=\r\n]+$/,
          ),
      }),
    }),
  ]);
  return z
    .object({
      messages: z
        .array(
          z.object({
            role: z.enum(["user", "assistant"]),
            content: z.union([
              z.string().max(MAX_MESSAGE_CHARS),
              z.array(part).min(1).max(5),
            ]),
          }),
        )
        .min(1)
        .max(24),
      pageContext: z
        .object({
          page: z.number().int().min(1).max(pageCount),
          section: z.string().max(100).optional(),
          title: z.string().max(1000).optional(),
          bullets: z.array(z.string().max(5000)).max(8).optional(),
          classmate: z.boolean().optional(),
        })
        .nullish(),
      model: z.string().max(200).nullish(),
    })
    .superRefine((body, ctx) => {
      const length = body.messages.reduce(
        (sum, m) =>
          sum +
          (typeof m.content === "string"
            ? m.content.length
            : m.content.reduce(
                (n, p) => n + (p.type === "text" ? p.text.length : 0),
                0,
              )),
        0,
      );
      if (length > MAX_HISTORY_CHARS)
        ctx.addIssue({
          code: "custom",
          message: "对话文字过长，请开始新的对话",
        });
    });
}
