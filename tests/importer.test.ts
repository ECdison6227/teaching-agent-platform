import test, { after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import { mkdtemp, readFile, rm, access } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { deflateSync } from "node:zlib";
import { setTimeout as delay } from "node:timers/promises";
import { eq } from "drizzle-orm";
import { database } from "../src/db";
import { courses } from "../src/db/schema";
import {
  createCourse,
  saveSource,
  enqueueImport,
  courseContent,
} from "../src/lib/courses";
import { claimJob, importJob } from "../src/lib/importer";
import { storagePath } from "../src/lib/storage";
import {
  pageTitle,
  normalizePageTitle,
  notePrompt,
} from "../src/lib/import-page-notes";
import { makePdf } from "../scripts/generate-samples.mjs";

const dir = await mkdtemp(path.join(tmpdir(), "tap-import-test-"));
process.env.DATA_DIR = dir;
process.env.MODEL_RETRY_BASE_MS = "1";

/** 原创纯图像 PDF，每页有不同颜色，无字体或文本层。 */
function scannedPdf(count: number) {
  const objects: Buffer[] = [
    Buffer.from("<< /Type /Catalog /Pages 2 0 R >>"),
    Buffer.alloc(0),
  ];
  const kids: string[] = [];
  const stream = (dictionary: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dictionary} /Length ${data.length} >>\nstream\n`),
      data,
      Buffer.from("\nendstream"),
    ]);
  for (let i = 0; i < count; i++) {
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(
      Buffer.from(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] /Resources << /XObject << /Scan ${page + 2} 0 R >> >> /Contents ${page + 1} 0 R >>`,
      ),
    );
    objects.push(stream("", Buffer.from("q 100 0 0 100 0 0 cm /Scan Do Q")));
    objects.push(
      stream(
        "/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode",
        deflateSync(Buffer.from([30 + i * 25, 80, 160])),
      ),
    );
  }
  objects[1] = Buffer.from(
    `<< /Type /Pages /Count ${count} /Kids [${kids.join(" ")}] >>`,
  );
  const chunks = [Buffer.from("%PDF-1.4\n")];
  const offsets = [0];
  let size = chunks[0].length;
  for (const [i, object] of objects.entries()) {
    offsets.push(size);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`),
      object,
      Buffer.from("\nendobj\n"),
    ]);
    chunks.push(chunk);
    size += chunk.length;
  }
  chunks.push(
    Buffer.from(
      `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
        .join(
          "",
        )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${size}\n%%EOF\n`,
    ),
  );
  return Buffer.concat(chunks);
}

let scenario: {
  kind: "text" | "scan";
  courseId: string;
  sourceId: string;
  language: string;
  count: number;
  active: number;
  maxActive: number;
  attempts: Map<number, number>;
  finished: number[];
  prompts: string[];
  images: number;
};
const server = http.createServer(async (req, res) => {
  try {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    const task = body.messages[0].content.match(/TASK:(\w+)/)?.[1];
    let content: unknown;
    if (task === "notes") {
      const input = body.messages[1].content;
      const prompt = typeof input === "string" ? input : input[0].text;
      scenario.prompts.push(prompt);
      let page = Number(prompt.match(/Marker (\d+)/)?.[1]);
      if (Array.isArray(input)) {
        scenario.images++;
        const image = input.find(
          (p: { type: string }) => p.type === "image_url",
        ).image_url.url;
        for (let i = 1; i <= scenario.count; i++) {
          const bytes = await readFile(
            storagePath(
              `courses/${scenario.courseId}/derived/${scenario.sourceId}/page-${i}.png`,
            ),
          ).catch(() => null);
          if (
            bytes &&
            image === `data:image/png;base64,${bytes.toString("base64")}`
          ) {
            page = i;
            break;
          }
        }
      }
      assert.ok(
        page >= 1 && page <= scenario.count,
        "请求必须包含实际页面文本或页图",
      );
      const attempt = (scenario.attempts.get(page) || 0) + 1;
      scenario.attempts.set(page, attempt);
      scenario.maxActive = Math.max(scenario.maxActive, ++scenario.active);
      try {
        await delay(page === 1 ? 400 : 40);
        if (page === 3 || (page === 4 && attempt < 3)) {
          res.writeHead(503).end('{"error":"temporary page failure"}');
          return;
        }
        scenario.finished.push(page);
        content = {
          title:
            page === 1 && attempt === 1
              ? "第 1 页"
              : page === 5 && attempt === 1 && scenario.kind === "text"
                ? ""
                : scenario.language === "en"
                  ? `Topic ${page}:`
                  : `主题 ${page}：`,
          points: [
            scenario.language === "en"
              ? `Learning point ${page}`
              : `学习要点 ${page}`,
          ],
          keys: [scenario.language === "en" ? "Concept" : "概念"],
          text:
            page === 5 && attempt === 1 && scenario.kind === "scan"
              ? undefined
              : `Original scan ${page}`,
        };
      } finally {
        scenario.active--;
      }
    } else if (task === "structure") {
      content = {
        chapters: [
          {
            title: "通用主题",
            knowledgePoints: [
              {
                title: "通用概念",
                keywords: [],
                pages: Array.from({ length: scenario.count }, (_, i) => i + 1),
              },
            ],
          },
        ],
      };
    } else if (task === "textbook") {
      content = { content_md: "Original reference content." };
    } else throw new Error(`Unexpected task ${task}`);
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        choices: [{ message: { content: JSON.stringify(content) } }],
        usage: { total_tokens: 11 },
      }),
    );
  } catch (error) {
    res.writeHead(500).end(JSON.stringify({ error: String(error) }));
  }
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
process.env.MODEL_PROVIDER = "openai-compatible";
for (const suffix of ["BASE_URL", "CHAT_BASE_URL", "VISION_BASE_URL"])
  process.env[`OPENAI_${suffix}`] = base;
for (const suffix of ["API_KEY", "CHAT_API_KEY", "VISION_API_KEY"])
  process.env[`OPENAI_${suffix}`] = "";
process.env.OPENAI_CHAT_MODEL = "test-text";
process.env.OPENAI_VISION_MODEL = "test-vision";
process.env.VISION_MODEL_PROVIDER = "openai-compatible";
for (const task of ["CHAT", "STRUCTURE", "NOTES", "TEXTBOOK", "QUESTIONS"]) {
  process.env[`${task}_MODEL_PROVIDER`] = "openai-compatible";
  process.env[`${task}_MODEL`] = "";
}
after(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  database().sqlite.close();
  await rm(dir, { recursive: true, force: true });
});

// 精确记录每次进度更新，避免用定时轮询测试完成顺序。
database().sqlite.exec(`
  CREATE TEMP TABLE progress_events (job_id TEXT, progress INTEGER, step TEXT);
  CREATE TEMP TRIGGER trace_progress AFTER UPDATE OF progress, step ON jobs
  BEGIN INSERT INTO progress_events VALUES (NEW.id, NEW.progress, NEW.step); END;
`);

test("标题规范化和提示词使用课程语言，缺标题按内容拟题", () => {
  assert.equal(normalizePageTitle("  内容要求：？！  "), "内容要求");
  assert.equal(
    pageTitle("第 5 页\nA concrete concept: \nDetails"),
    "A concrete concept",
  );
  assert.equal(pageTitle(""), "页面内容待核对");
  assert.match(
    notePrompt("Questions / Why are there different types?", "Questions"),
    /课程语言：zh/,
  );
  assert.match(notePrompt("English source", "Topic", "fr"), /课程语言：fr/);
  assert.match(notePrompt("", ""), /没有原始标题时也要根据内容拟题/);
});

for (const kind of ["text", "scan"] as const) {
  test(
    `${kind === "scan" ? "纯扫描教材 OCR" : "英文课件要点"}并发、重试降级、原序和完成进度`,
    { timeout: 30_000 },
    async () => {
      const count = 6;
      process.env.MODEL_PROVIDER = "openai-compatible";
      process.env.OPENAI_VISION_MODEL = kind === "scan" ? "test-vision" : "";
      if (kind === "text") process.env.IMPORT_PAGE_CONCURRENCY = "2";
      else delete process.env.IMPORT_PAGE_CONCURRENCY;
      const course = createCourse({ title: "Original import test" });
      const language = kind === "scan" ? "en" : "zh";
      database()
        .db.update(courses)
        .set({ language })
        .where(eq(courses.id, course.id))
        .run();
      const source = saveSource(
        course.id,
        kind === "scan" ? "textbook" : "slides",
        "original.pdf",
        kind === "scan"
          ? scannedPdf(count)
          : makePdf(
              Array.from({ length: count }, (_, i) => [
                `Marker ${i + 1}`,
                "Questions / Why are there different types?",
              ]),
            ),
      );
      scenario = {
        kind,
        count,
        courseId: course.id,
        sourceId: source.id,
        language,
        active: 0,
        maxActive: 0,
        attempts: new Map(),
        finished: [],
        prompts: [],
        images: 0,
      };
      const job = enqueueImport(course.id);
      assert.equal(claimJob()?.id, job.id);
      await importJob(job.id);
      const content = courseContent(course.id);
      assert.equal(content.jobs[0].status, "done", content.jobs[0].error || "");
      assert.equal(content.jobs[0].progress, 100);
      assert.equal(content.jobs[0].costTokens, 77); // 5 页成功 + 结构 + 讲义，各 11。
      assert.equal(scenario.maxActive, kind === "scan" ? 4 : 2);
      assert.equal(scenario.attempts.get(1), 2, "页码占位标题触发重试");
      assert.equal(
        scenario.attempts.get(3),
        4,
        "永久网络失败重试三次且不重跑 OCR",
      );
      assert.equal(scenario.attempts.get(4), 3, "两次失败后第三次恢复");
      assert.equal(scenario.attempts.get(5), 2, "无标题或漏转录会重试");
      assert.ok(
        scenario.finished.indexOf(2) < scenario.finished.lastIndexOf(1),
      );
      assert.ok(
        scenario.prompts.every((prompt) =>
          prompt.includes(`课程语言：${language}`),
        ),
      );
      assert.deepEqual(
        content.pages.map((page) => page.index),
        [1, 2, 3, 4, 5, 6],
      );
      assert.deepEqual(
        content.pages.map((page) => page.sourcePage),
        [1, 2, 3, 4, 5, 6],
      );
      for (const page of content.pages) {
        await access(storagePath(page.imageKey));
        assert.ok(
          page.width && page.height && page.kpId && page.note?.points.length,
        );
        assert.ok(!/[：:。.!?？！]$/.test(page.title));
        assert.equal(page.note?.title, page.title);
        if (page.index === 3) {
          assert.equal(page.note?.model, "rules:model-failed");
          assert.equal(page.note?.qaStatus, "needs_review");
          if (kind === "scan") assert.equal(page.rawText, "");
          else assert.match(page.rawText, /Marker 3/);
        } else {
          assert.equal(
            page.title,
            language === "en" ? `Topic ${page.index}` : `主题 ${page.index}`,
          );
          assert.equal(page.note?.qaStatus, "passed");
          if (kind === "scan")
            assert.equal(page.rawText, `Original scan ${page.index}`);
          else assert.match(page.rawText, new RegExp(`Marker ${page.index}`));
        }
      }
      const events = database()
        .sqlite.prepare(
          "SELECT progress, step FROM progress_events WHERE job_id = ? ORDER BY rowid",
        )
        .all(job.id) as { progress: number; step: string }[];
      assert.ok(
        events.every(
          (event, i) => i === 0 || event.progress >= events[i - 1].progress,
        ),
      );
      assert.deepEqual(
        events
          .filter((event) => event.step.startsWith("整理逐页要点"))
          .map((event) => event.step),
        Array.from(
          { length: count + 1 },
          (_, i) => `整理逐页要点 ${i}/${count}`,
        ),
      );
      assert.deepEqual(
        events
          .filter((event) => event.step.startsWith("提取页图与文本"))
          .map((event) => Number(event.step.match(/· (\d+)\//)?.[1])),
        [1, 2, 3, 4, 5, 6],
      );
      if (kind === "scan") {
        assert.equal(
          scenario.images,
          [...scenario.attempts.values()].reduce((sum, n) => sum + n, 0),
        );
        const combined = await readFile(
          storagePath(content.sources[0].textKey!),
          "utf8",
        );
        assert.deepEqual(combined.split("\n\f\n"), [
          "Original scan 1",
          "Original scan 2",
          "",
          "Original scan 4",
          "Original scan 5",
          "Original scan 6",
        ]);
      }
    },
  );
}

test("扫描教材无视觉模型仍保留每页图片和待核对要点", async () => {
  process.env.MODEL_PROVIDER = "none";
  const course = createCourse({ title: "Original image-only test" });
  saveSource(course.id, "textbook", "scanned.pdf", scannedPdf(2));
  const job = enqueueImport(course.id);
  assert.equal(claimJob()?.id, job.id);
  await importJob(job.id);
  const content = courseContent(course.id);
  assert.equal(content.jobs[0].status, "done");
  assert.equal(content.pages.length, 2);
  for (const page of content.pages) {
    assert.equal(page.rawText, "");
    assert.equal(page.note?.model, "rules:no-model");
    assert.equal(page.note?.qaStatus, "needs_review");
    await access(storagePath(page.imageKey));
  }
});
