import { courseContent, HttpError } from "@/lib/courses";
import { api, readJson } from "@/lib/http";
import { buildPrompt } from "@/lib/prompt";
import { resolveProviderConfig } from "@/lib/models/provider";
import { pacedChat } from "@/lib/chat-pacing";
import { chatRequestSchema } from "@/lib/request-validation";
import { createChatParser, type StreamEvent } from "@/lib/chat-protocol";
import { requestScope, requestError } from "@/lib/request-lifecycle";
import { MAX_REQUEST_BYTES } from "@/lib/request-limits";
export const runtime = "nodejs";
export async function POST(
  request: Request,
  context: { params: Promise<{ courseId: string }> },
) {
  try {
    const { courseId } = await context.params;
    const data = courseContent(courseId);
    if (data.course.status !== "ready")
      throw new HttpError(409, "请等待课程导入完成");
    const input = chatRequestSchema(data.pages.length).parse(
      await readJson(request, MAX_REQUEST_BYTES),
    );
    const config = resolveProviderConfig();
    const scope = requestScope(request.signal);
    let ended = false;
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const encoder = new TextEncoder();
        const emit = (event: StreamEvent) => {
          if (!ended && !scope.signal.aborted)
            controller.enqueue(
              encoder.encode(`data: ${JSON.stringify(event)}\n\n`),
            );
        };
        const parser = createChatParser(emit, data.pages.length);
        try {
          if (config) {
            for await (const delta of pacedChat(
              [
                {
                  role: "system",
                  content: buildPrompt(data, input.pageContext?.page),
                },
                ...input.messages,
              ],
              scope.signal,
              input.model,
              data.pages.length,
            ))
              parser.push(delta);
          } else {
            const page =
              data.pages.find((p) => p.index === input.pageContext?.page) ||
              data.pages[0];
            parser.push(
              `当前使用规则学习模式。我们先看「${page.title}」。\n\n${page.note?.points.map((p) => `- ${p}`).join("\n") || page.rawText.slice(0, 1000)}\n\n你能用自己的话解释其中一个概念吗？\n\`\`\`slide\n${page.index}\n\`\`\``,
            );
          }
          parser.end();
          scope.signal.throwIfAborted();
          emit({ type: "done" });
        } catch (error) {
          emit({ type: "error", message: requestError(error, scope.signal) });
        } finally {
          scope.dispose();
          if (!ended) {
            ended = true;
            controller.close();
          }
        }
      },
      cancel() {
        ended = true;
        scope.abort();
        scope.dispose();
      },
    });
    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (error) {
    return api(() => {
      throw error;
    });
  }
}
