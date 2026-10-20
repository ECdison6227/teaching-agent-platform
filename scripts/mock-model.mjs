// 本地 OpenAI 兼容 HTTP mock；结构化导入 + 真实 SSE 字节流，不需要密钥。
import http from "node:http";
import { pathToFileURL } from "node:url";
export async function startMockModel(port = 0) {
  const calls = [];
  const server = http.createServer(async (req, res) => {
    try {
      if (req.url !== "/v1/chat/completions" || req.method !== "POST") {
        res.writeHead(404).end();
        return;
      }
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      if (body.model === "mock-error") {
        res.writeHead(429).end('{"error":"mock failure"}');
        return;
      }
      const task =
        body.messages?.[0]?.content?.match(/TASK:(\w+)/)?.[1] || "chat";
      calls.push({
        task,
        model: body.model,
        vision: body.messages.some(
          (m) =>
            Array.isArray(m.content) &&
            m.content.some((p) => p.type === "image_url"),
        ),
      });
      let content;
      if (task === "structure")
        content = {
          chapters: [
            {
              title: "概率与日常决策",
              summary: "从样本空间到独立事件",
              knowledgePoints: [
                {
                  title: "样本空间与概率",
                  keywords: ["probability", "Sample Spaces"],
                  pages: [1, 2],
                },
                {
                  title: "计算概率与独立事件",
                  keywords: ["Independent Events", "Computing Probability"],
                  pages: [3, 4],
                },
                {
                  title: "教材拓展：建模假设",
                  keywords: ["assumption"],
                  pages: [],
                },
              ],
            },
          ],
        };
      else if (task === "notes") {
        const input = body.messages.at(-1).content;
        const text = typeof input === "string" ? input : input[0].text;
        const title = text.match(/标题参考：([^\n]+)/)?.[1] || "概率学习";
        content = {
          title,
          points: [
            "先列出所有可能结果，再确定关注的事件。",
            "等可能情况下，用事件结果数除以总结果数。",
          ],
          keys: ["样本空间", "概率"],
          text: "Probability ranges from 0 to 1. A fair coin has two equally likely outcomes.",
        };
      } else if (task === "textbook")
        content = {
          content_md:
            "## 从样本空间理解概率\n\n先列出可能结果，等可能情况下 $P(A)=|A|/|S|$。例如公平硬币出现正面的概率为 $1/2$。独立试验互不改变概率。",
        };
      else if (task === "questions")
        content = {
          questions: [
            {
              type: "choice",
              prompt: "公平硬币出现正面的概率是多少？",
              options: [
                { id: "A", text: "0.5" },
                { id: "B", text: "1" },
              ],
              answer: "A",
              analysis: "两种等可能结果中一种是正面。",
              kpCode: "K1",
              pages: [2],
              sourcePage: 1,
              confidence: "high",
            },
            {
              type: "truefalse",
              prompt: "概率可以大于 1。",
              answer: "F",
              kpCode: "K1",
              pages: [1],
              sourcePage: 1,
              confidence: "high",
            },
            {
              type: "fill",
              prompt: "公平骰子点数为偶数的概率是____。",
              answer: "0.5",
              kpCode: "K2",
              pages: [3],
              sourcePage: 1,
              confidence: "high",
            },
            {
              type: "short",
              prompt: "用生活中的例子解释独立事件。",
              answer: null,
              kpCode: "K2",
              pages: [4],
              sourcePage: 1,
              confidence: "low",
            },
          ],
        };
      else
        content =
          '我们先列出公平硬币的样本空间：正面和反面。正面占两个等可能结果中的一个。\n\n```slides\n2\n```\n\n```card\n{"kind":"choice","prompt":"公平硬币出现正面的概率是多少？","options":[{"id":"A","text":"0.5"},{"id":"B","text":"1"}],"topic":"K1"}\n```';
      if (body.stream) {
        res.writeHead(200, { "Content-Type": "text/event-stream" });
        const text =
          typeof content === "string" ? content : JSON.stringify(content);
        for (let i = 0; i < text.length; i += 7)
          res.write(
            `data: ${JSON.stringify({ choices: [{ delta: { content: text.slice(i, i + 7) } }] })}\r\n\r\n`,
          );
        res.end("data: [DONE]\n\n");
      } else {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(
          JSON.stringify({
            choices: [{ message: { content: JSON.stringify(content) } }],
            usage: { total_tokens: 120 },
          }),
        );
      }
    } catch {
      res.writeHead(400).end('{"error":"bad mock request"}');
    }
  });
  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/v1`,
    calls,
    close: () =>
      new Promise((resolve, reject) => {
        server.closeAllConnections();
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const mock = await startMockModel(Number(process.argv[2] || 3731));
  console.log(`mock model: ${mock.url}`);
}
