import assert from "node:assert/strict";
import Database from "better-sqlite3";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdir, mkdtemp, readFile, writeFile, access } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import net from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, expect } from "@playwright/test";
import { startMockModel } from "./mock-model.mjs";
import { generateSamples } from "./generate-samples.mjs";
import { generateFormulaSamples } from "./generate-formula-sample.mjs";
import type { CourseContent } from "../src/lib/courses";
import type { Job } from "../src/db/schema";

const exec = promisify(execFile);
async function freePort() {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}
async function main() {
  const runDir = await mkdtemp(path.join(tmpdir(), "tap-smoke-"));
  process.env.DATA_DIR = runDir;
  const sampleDir = generateSamples(path.join(runDir, "samples"));
  const mock = await startMockModel();
  const port = await freePort(),
    basePath = process.env.NEXT_PUBLIC_BASE_PATH || "",
    base = `http://127.0.0.1:${port}${basePath}`;
  const env = {
    ...process.env,
    DATA_DIR: runDir,
    MODEL_PROVIDER: "openai-compatible",
    OPENAI_BASE_URL: mock.url,
    OPENAI_CHAT_BASE_URL: mock.url,
    OPENAI_VISION_BASE_URL: mock.url,
    OPENAI_API_KEY: "",
    OPENAI_CHAT_API_KEY: "",
    OPENAI_VISION_API_KEY: "",
    OPENAI_CHAT_MODEL: "mock-chat",
    OPENAI_VISION_MODEL: "mock-vision",
    VISION_MODEL_PROVIDER: "openai-compatible",
    NEXT_TELEMETRY_DISABLED: "1",
    MODEL_RETRY_BASE_MS: "1",
    MODEL_RATE_LIMIT_BASE_MS: "1",
    MODEL_RATE_LIMIT_RETRIES: "3",
  };
  for (const task of ["CHAT", "STRUCTURE", "NOTES", "TEXTBOOK", "QUESTIONS"])
    Object.assign(env, {
      [`${task}_MODEL_PROVIDER`]: "openai-compatible",
      [`${task}_MODEL`]: "",
    });
  let log = "";
  const web = spawn(
    process.execPath,
    [
      "scripts/smoke-server.mjs",
      String(port),
      existsSync(path.join(process.env.NEXT_DIST_DIR || ".next", "BUILD_ID"))
        ? "start"
        : "dev",
    ],
    { env, stdio: ["ignore", "pipe", "pipe", "ipc"] },
  );
  web.stdout!.on("data", (data) => {
    log = (log + data).slice(-30000);
  });
  web.stderr!.on("data", (data) => {
    log = (log + data).slice(-30000);
  });
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  async function json<T = any>(url: string, init?: RequestInit): Promise<T> {
    const res = await fetch(base + url, init);
    const data = await res.json();
    assert.ok(res.ok, `${url}: ${res.status} ${JSON.stringify(data)}`);
    return data;
  }
  const post = (body: unknown): RequestInit => ({
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  async function upload(id: string, kind: string, filename: string) {
    const form = new FormData();
    form.set("kind", kind);
    form.set(
      "file",
      new File([await readFile(filename)], path.basename(filename)),
    );
    return json(`/api/courses/${id}/sources`, { method: "POST", body: form });
  }
  async function runWorker(extraEnv = {}) {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", "scripts/worker.ts", "--once"],
      { env: { ...env, ...extraEnv }, stdio: ["ignore", "pipe", "pipe"] },
    );
    let output = "";
    child.stdout.on("data", (b) => {
      output += b;
    });
    child.stderr.on("data", (b) => {
      output += b;
    });
    let timeout: ReturnType<typeof setTimeout>;
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        timeout = setTimeout(
          () => reject(new Error("Smoke worker 超时，保留进程供排查")),
          240_000,
        );
        child.on("exit", resolve);
        child.on("error", reject);
      });
      assert.equal(code, 0, output);
    } finally {
      clearTimeout(timeout!);
    }
  }
  async function checkJob(id: string) {
    const job = await json<Job>(`/api/jobs/${id}`);
    assert.equal(job.status, "done", job.error || job.step);
    assert.equal(job.progress, 100);
    return job;
  }
  try {
    for (let i = 0; ; i++) {
      try {
        if ((await fetch(base + "/api/courses")).ok) break;
      } catch {
        /* 启动等待 */
      }
      if (i > 120 || web.exitCode !== null)
        throw new Error(`Next 启动失败\n${log}`);
      await delay(500);
    }
    console.log(`Next ready: ${base}`);
    const chromePath =
      process.env.CHROME_BIN ||
      (existsSync("/opt/google/chrome/chrome")
        ? "/opt/google/chrome/chrome"
        : undefined);
    browser = await chromium.launch({
      headless: true,
      executablePath: chromePath,
      args: ["--no-sandbox"],
    });
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 },
    });
    const page = await context.newPage();
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    await page.goto(base + "/new");
    await page
      .getByPlaceholder("例如：概率与日常决策")
      .fill("概率与日常决策 · Smoke");
    const createdResponse = page.waitForResponse(
      (r) =>
        r.url() === base + "/api/courses" && r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    const course = await (await createdResponse).json();
    await page
      .getByLabel("添加课程 PPT文件")
      .setInputFiles(path.join(sampleDir, "probability.pdf"));
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page
      .getByLabel("添加教材文件")
      .setInputFiles(path.join(sampleDir, "probability.pdf"));
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page
      .getByLabel("添加习题文件")
      .setInputFiles(path.join(sampleDir, "questions.pdf"));
    await page.getByRole("button", { name: "下一步", exact: true }).click();
    await page
      .getByRole("button", { name: "跳过并开始导入", exact: true })
      .click();
    await expect(page.getByText("正在整理你的课程")).toBeVisible();
    let content = await json<CourseContent>(`/api/courses/${course.id}`);
    const jobId = content.jobs[0].id;
    assert.equal(content.sources.length, 3);
    await runWorker();
    const job = await checkJob(jobId);
    content = await json<CourseContent>(`/api/courses/${course.id}`);
    assert.equal(content.course.status, "ready");
    assert.equal(content.pages.length, 4);
    assert.equal(content.knowledgePoints.length, 3);
    assert.equal(content.questions.length, 4);
    assert.deepEqual(
      [...new Set(content.questions.map((q) => q.type))].sort(),
      ["choice", "fill", "short", "truefalse"],
    );
    assert.ok(
      content.questions.every(
        (q) =>
          (q.kpId ? q.pageIds.length : !q.pageIds.length) &&
          !q.verified &&
          q.reviewStatus === "needs_review",
      ),
    );
    assert.ok(content.questions.some((q) => !q.answer));
    assert.ok(content.questions.some((q) => !q.kpId));
    assert.ok(content.knowledgePoints.every((k) => k.contentMd.length));
    assert.ok(content.knowledgePoints.some((k) => !k.hasSlides));
    for (const p of content.pages) {
      assert.ok(
        p.rawText.length &&
          p.kpId &&
          p.note?.points.length &&
          p.width &&
          p.height,
      );
      await access(path.join(runDir, p.imageKey));
      const image = await fetch(
        base + `/api/courses/${course.id}/pages/${p.index}`,
      );
      assert.equal(image.status, 200);
      assert.equal(image.headers.get("content-type"), "image/png");
    }
    for (const source of content.sources) {
      assert.ok(source.textKey && source.pdfKey);
      await access(path.join(runDir, source.textKey!));
    }
    const download = await fetch(
      base + `/api/courses/${course.id}/materials/${content.sources[0].id}`,
    );
    assert.equal(download.status, 200);
    assert.equal((await download.text()).slice(0, 5), "%PDF-");
    assert.equal(
      (await fetch(base + `/api/courses/${course.id}/pages/5`)).status,
      404,
    );
    await expect(
      page.getByRole("link", { name: "进入学习空间", exact: true }),
    ).toBeVisible({ timeout: 10000 });
    await page.getByRole("link", { name: "进入学习空间", exact: true }).click();
    await expect(
      page.getByRole("heading", { name: "从一个问题，走向真正理解。" }),
    ).toBeVisible();
    await page
      .getByRole("button", { name: "带我从基础开始学习", exact: true })
      .click();
    await expect(
      page.getByText("公平硬币出现正面的概率是多少？", { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "查看课程页 2", exact: true }),
    ).toBeVisible();
    await page.getByRole("button", { name: "自学天地", exact: true }).click();
    const image = page.getByAltText(/^课程第 1 页/);
    await expect(image).toBeVisible();
    await expect
      .poll(() => image.evaluate((el: HTMLImageElement) => el.naturalWidth))
      .toBeGreaterThan(0);
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByAltText(/^课程第 2 页/)).toBeVisible();
    await page.screenshot({
      path: path.join(runDir, "study.png"),
      fullPage: false,
    });
    await page.getByRole("button", { name: "A. 0.5", exact: true }).click();
    await page
      .getByRole("button", { name: "核对作答", exact: true })
      .first()
      .click();
    await expect(page.getByText("此题答案待核对，暂不自动判分")).toBeVisible();
    await page.getByRole("button", { name: "学习笔记", exact: true }).click();
    await page.getByLabel("课程笔记").fill("仅属于概率课程的笔记");
    await page.getByRole("button", { name: "保存笔记", exact: true }).click();
    await page.reload();
    await page.getByRole("button", { name: "学习笔记", exact: true }).click();
    await expect(page.getByLabel("课程笔记")).toHaveValue(
      "仅属于概率课程的笔记",
    );
    await page.setViewportSize({ width: 390, height: 844 });
    await page.getByRole("button", { name: "Toggle Sidebar" }).click();
    await expect(
      page.getByRole("button", { name: "自学天地", exact: true }),
    ).toBeVisible();
    await page.keyboard.press("Escape");
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(base + `/teach/${course.id}/review`);
    await page
      .getByRole("button", { name: "确认答案已核对", exact: true })
      .first()
      .click();
    await expect(page.getByRole("status")).toHaveText("已保存");
    const revised = await json<CourseContent>(`/api/courses/${course.id}`);
    assert.equal(revised.questions.filter((q) => q.verified).length, 1);
    await page.screenshot({
      path: path.join(runDir, "review.png"),
      fullPage: false,
    });
    await page.goto(base + `/c/${course.slug}`);
    await page.getByRole("button", { name: "自学天地", exact: true }).click();
    await page.getByRole("button", { name: "A. 0.5", exact: true }).click();
    await page
      .getByRole("button", { name: "核对作答", exact: true })
      .first()
      .click();
    await expect(page.getByText("回答正确", { exact: true })).toBeVisible();
    await expect(page.getByText(/未关联/).first()).toBeVisible();
    const missingAnswer = revised.questions.find((q) => !q.answer)!;
    const invalidVerification = await fetch(
      base + `/api/courses/${course.id}/review`,
      {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          kind: "question",
          id: missingAnswer.id,
          answer: null,
          analysis: "",
          verified: true,
        }),
      },
    );
    assert.equal(invalidVerification.status, 400);
    console.log(
      `PASS mock import: pages=4, text=4, knowledgePoints=3, notes=4, questions=4, tokens=${job.costTokens}; wizard + SSE chat + study + review + notes + mobile`,
    );

    // 第二门课程：无模型 + 教材 DOCX（实际通过 LibreOffice 生成并转换）+ 规则题库。
    const office = path.join(runDir, "office");
    await mkdir(office);
    await writeFile(
      path.join(office, "original.txt"),
      "Everyday decisions\nA probability is between 0 and 1.\nA sample space lists possible outcomes.\n",
    );
    await exec(
      "soffice",
      [
        `-env:UserInstallation=file://${office}/profile`,
        "--headless",
        "--convert-to",
        "docx",
        "--outdir",
        office,
        path.join(office, "original.txt"),
      ],
      { timeout: 60000 },
    );
    const second = await json<{ id: string; slug: string }>(
      "/api/courses",
      post({ title: "教材课程 · 无模型" }),
    );
    const textbook = await upload(
      second.id,
      "textbook",
      path.join(office, "original.docx"),
    );
    assert.equal(
      (await upload(second.id, "textbook", path.join(office, "original.docx")))
        .id,
      textbook.id,
    );
    await upload(
      second.id,
      "question_bank",
      path.join(sampleDir, "questions.pdf"),
    );
    const queued = await json<Job>(`/api/courses/${second.id}/jobs`, {
      method: "POST",
    });
    await runWorker({ MODEL_PROVIDER: "none" });
    await checkJob(queued.id);
    const fallback = await json<CourseContent>(`/api/courses/${second.id}`);
    assert.equal(fallback.pages.length, 1);
    assert.equal(fallback.questions.length, 4);
    assert.ok(fallback.pages.every((p) => p.note?.model === "rules:no-model"));
    assert.ok(fallback.knowledgePoints.every((k) => !k.hasSlides));
    assert.equal(
      (
        await fetch(
          base + `/api/courses/${second.id}/materials/${content.sources[0].id}`,
        )
      ).status,
      404,
    );
    const badReview = await fetch(base + `/api/courses/${course.id}/review`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        kind: "page",
        id: content.pages[0].id,
        kpId: fallback.knowledgePoints[0].id,
        title: "bad mapping",
        points: ["bad"],
        keys: [],
      }),
    });
    assert.equal(badReview.status, 400);
    await page.goto(base + `/c/${second.slug}`);
    await page.getByRole("button", { name: "学习笔记", exact: true }).click();
    await expect(page.getByLabel("课程笔记")).toHaveValue("");
    assert.deepEqual(pageErrors, []);
    const tasks = new Set(mock.calls.map((c) => c.task));
    for (const task of ["structure", "notes", "textbook", "questions", "chat"])
      assert.ok(tasks.has(task));
    assert.ok(mock.calls.some((c) => c.vision));
    console.log(
      "PASS fallback import: DOCX -> PDF -> PNG/text, textbook-only, rules notes/questions, deduplication, cross-course isolation",
    );
    // PPTX/PPT/DOC 走真实转换；页面失败降级、存储故障续跑与未就绪课程浏览。
    const fodp = `<?xml version="1.0" encoding="UTF-8"?><office:document xmlns:office="urn:oasis:names:tc:opendocument:xmlns:office:1.0" xmlns:draw="urn:oasis:names:tc:opendocument:xmlns:drawing:1.0" xmlns:text="urn:oasis:names:tc:opendocument:xmlns:text:1.0" xmlns:svg="urn:oasis:names:tc:opendocument:xmlns:svg-compatible:1.0" office:version="1.2" office:mimetype="application/vnd.oasis.opendocument.presentation"><office:body><office:presentation><draw:page draw:name="One"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="10cm"><draw:text-box><text:p>Original probability lesson</text:p><text:p>List outcomes before computing a probability.</text:p></draw:text-box></draw:frame></draw:page><draw:page draw:name="Two"><draw:frame svg:x="2cm" svg:y="2cm" svg:width="20cm" svg:height="10cm"><draw:text-box><text:p>Independent events</text:p><text:p>One fair toss does not change the next.</text:p></draw:text-box></draw:frame></draw:page></office:presentation></office:body></office:document>`;
    await writeFile(path.join(office, "slides.fodp"), fodp);
    for (const ext of ["pptx", "ppt"])
      await exec(
        "soffice",
        [
          `-env:UserInstallation=file://${office}/profile`,
          "--headless",
          "--convert-to",
          ext,
          "--outdir",
          office,
          path.join(office, "slides.fodp"),
        ],
        { timeout: 60000 },
      );
    await exec(
      "soffice",
      [
        `-env:UserInstallation=file://${office}/profile`,
        "--headless",
        "--convert-to",
        "doc:MS Word 97",
        "--outdir",
        office,
        path.join(office, "original.txt"),
      ],
      { timeout: 60000 },
    );
    const third = await json<{ id: string; slug: string }>(
      "/api/courses",
      post({ title: "办公格式与失败重试" }),
    );
    await upload(third.id, "slides", path.join(office, "slides.pptx"));
    await upload(third.id, "material", path.join(office, "slides.ppt"));
    await upload(third.id, "material", path.join(office, "original.doc"));
    const failedJob = await json<Job>(`/api/courses/${third.id}/jobs`, {
      method: "POST",
    });
    await page.goto(base + `/c/${third.slug}`);
    await expect(
      page.getByRole("progressbar", { name: "课程导入进度" }),
    ).toBeVisible();
    await expect(
      page.getByText("尚无已生成页面，导入完成的页面将在这里显示。"),
    ).toBeVisible();
    // Fail a storage operation after notes have committed, without stopping any worker.
    const smokeDb = new Database(path.join(runDir, "platform.sqlite"));
    smokeDb.exec(`CREATE TRIGGER smoke_fail_lecture BEFORE UPDATE OF content_md ON knowledge_points
      WHEN NEW.course_id = '${third.id}'
      BEGIN SELECT RAISE(ABORT, 'smoke storage failure after notes'); END;`);
    await runWorker({ OPENAI_VISION_MODEL: "mock-error" });
    const failed = await json<Job>(`/api/jobs/${failedJob.id}`);
    assert.equal(failed.status, "failed");
    assert.match(failed.error || "", /smoke storage failure/);
    const degraded = await json<CourseContent>(`/api/courses/${third.id}`);
    assert.equal(degraded.pages.length, 2);
    assert.ok(
      degraded.pages.every((p) => p.note?.model === "rules:model-failed"),
    );
    assert.ok(degraded.pages.every((p) => p.note?.qaStatus === "needs_review"));
    await page.reload();
    await expect(
      page.getByRole("alert").filter({ hasText: "smoke storage failure" }),
    ).toContainText("smoke storage failure");
    await expect(page.getByAltText(/^课程第 1 页/)).toBeVisible();
    await expect(page.getByText("AI 学习要点", { exact: false })).toContainText(
      "待核对",
    );
    await page.getByRole("button", { name: "下一页", exact: true }).click();
    await expect(page.getByAltText(/^课程第 2 页/)).toBeVisible();
    smokeDb.exec("DROP TRIGGER smoke_fail_lecture");
    smokeDb.close();
    const callsBeforeResume = mock.calls.length;
    await page
      .getByRole("button", { name: "从失败处继续", exact: true })
      .click();
    await expect(
      page.getByRole("progressbar", { name: "课程导入进度" }),
    ).toBeVisible();
    await expect(page.getByAltText(/^课程第 2 页/)).toBeVisible();
    const resuming = await json<CourseContent>(`/api/courses/${third.id}`);
    await runWorker({ MODEL_PROVIDER: "none" });
    await checkJob(resuming.jobs[0].id);
    const officeCourse = await json<CourseContent>(`/api/courses/${third.id}`);
    assert.deepEqual(officeCourse.pages, degraded.pages);
    assert.equal(mock.calls.length, callsBeforeResume);
    assert.ok(
      officeCourse.sources.every((s) => s.pdfKey && s.textKey && s.pages),
    );
    assert.ok(officeCourse.pages.every((p) => p.rawText.length > 10));
    assert.deepEqual(pageErrors, []);
    console.log(
      "PASS office/resume: PPTX + PPT + DOC -> PDF, failed page degrades, importing/failed course pages render existing images and notes, UI resumes without replacing completed data",
    );
    const formulaDir = path.join(runDir, "formulas");
    await generateFormulaSamples(formulaDir);
    const formulaCourse = await json<{ id: string; slug: string }>(
      "/api/courses",
      post({ title: "原创公式恢复验证" }),
    );
    await upload(
      formulaCourse.id,
      "textbook",
      path.join(formulaDir, "omml-textbook.docx"),
    );
    await upload(
      formulaCourse.id,
      "question_bank",
      path.join(formulaDir, "omml-questions.docx"),
    );
    await upload(
      formulaCourse.id,
      "question_bank",
      path.join(formulaDir, "missing-formulas.docx"),
    );
    const formulaJob = await json<Job>(
      `/api/courses/${formulaCourse.id}/jobs`,
      { method: "POST" },
    );
    await runWorker({ MODEL_PROVIDER: "none" });
    await checkJob(formulaJob.id);
    const formulasBefore = await json<CourseContent>(
      `/api/courses/${formulaCourse.id}`,
    );
    assert.equal(formulasBefore.questions.length, 2);
    assert.ok(
      formulasBefore.questions.some((q) =>
        q.formulaRecovery?.evidence.some((e) => e.source === "omml"),
      ),
    );
    const missing = formulasBefore.questions.find(
      (q) => q.formulaRecovery?.status === "missing",
    )!;
    assert.ok(missing);
    await page.goto(base + `/teach/${formulaCourse.id}/review`);
    await expect(page.getByText(/公式缺失，需核对原文/)).toBeVisible();
    await exec(
      process.execPath,
      [
        "--import",
        "tsx",
        "scripts/resume-import.ts",
        formulaCourse.id,
        "--from",
        "formulas",
      ],
      { env },
    );
    const formulasAfter = await json<CourseContent>(
      `/api/courses/${formulaCourse.id}`,
    );
    const fixed = formulasAfter.questions.find((q) => q.id === missing.id)!;
    assert.equal(fixed.formulaRecovery?.status, "recovered");
    assert.equal(fixed.formulaRecovery.evidence[0].source, "vision");
    assert.equal(fixed.options?.[0].text, "$x$");
    assert.equal(fixed.verified, false);
    assert.deepEqual(formulasAfter.pages, formulasBefore.pages);
    await page.reload();
    await expect(page.getByText(/vision · 置信度 94%/)).toBeVisible();
    assert.deepEqual(pageErrors, []);
    console.log(
      "PASS formulas: original OMML DOCX -> PDF/page images -> LaTeX in textbook, question and options; review flags missing formulas; mock vision + CLI formula-only recovery preserves pages",
    );
    // 原创测试标记只写入本次 DATA_DIR，验证聚合、默认折叠、审核定位和待处理续跑。
    const noticeDb = new Database(path.join(runDir, "platform.sqlite"));
    noticeDb.transaction(() => {
      noticeDb
        .prepare("DELETE FROM import_items WHERE course_id = ?")
        .run(course.id);
      const insert = noticeDb.prepare(
        "INSERT INTO import_items (course_id, key, status, message) VALUES (?, ?, ?, ?)",
      );
      for (let i = 0; i < 7; i++)
        insert.run(
          course.id,
          `questions:notice:${i}`,
          "needs_review",
          "该批习题使用规则抽取，待核对",
        );
      for (let i = 0; i < 6; i++)
        insert.run(
          course.id,
          `answers:notice-${i}`,
          "needs_review",
          "答案未能可靠推导",
        );
      insert.run(
        course.id,
        `answers:${missingAnswer.id}`,
        "pending",
        "上游限流，答案待处理，可续跑",
      );
    })();
    noticeDb.close();
    await page.goto(base + `/c/${course.slug}`);
    await expect(
      page.getByText(
        "7 批习题使用规则抽取 · 6 题答案待补 · 1 题答案因限流待处理",
        { exact: true },
      ),
    ).toBeVisible();
    await expect(
      page.getByRole("button", { name: "展开明细" }),
    ).toHaveAttribute("aria-expanded", "false");
    await expect(page.locator("#import-notice-details")).toHaveCount(0);
    await page.getByRole("button", { name: "展开明细" }).click();
    await expect(
      page.getByRole("button", { name: "收起明细" }),
    ).toHaveAttribute("aria-expanded", "true");
    const reviewLink = page.locator(
      `#import-notice-details a[href$="#question-${missingAnswer.id}"]`,
    );
    await expect(reviewLink).toHaveText("前往审核");
    await reviewLink.click();
    await expect(
      page.locator(`#question-${missingAnswer.id}`),
    ).toBeInViewport();
    await page.goto(base + `/c/${course.slug}`);
    const pendingResume = page.waitForResponse(
      (r) =>
        r.url() === base + `/api/courses/${course.id}/jobs` &&
        r.request().method() === "POST",
    );
    await page.getByRole("button", { name: "续跑待处理答案" }).click();
    const answerJob = await (await pendingResume).json();
    assert.equal(answerJob.type, "import:answers");
    await runWorker();
    await checkJob(answerJob.id);
    const afterAnswerResume = await json<CourseContent>(
      `/api/courses/${course.id}`,
    );
    assert.equal(
      afterAnswerResume.importItems.find(
        (item) => item.key === `answers:${missingAnswer.id}`,
      )?.status,
      "needs_review",
    );
    assert.equal(afterAnswerResume.questions.length, content.questions.length);
    assert.deepEqual(pageErrors, []);
    console.log(
      "PASS FIX6 UI: 7 batches + 6 missing answers aggregate, details collapsed by default, review anchor navigation, pending 429 answer resumes through queued answers-only job",
    );
    await writeFile(
      path.join(runDir, "result.json"),
      JSON.stringify(
        {
          passed: true,
          course: course.slug,
          courseId: course.id,
          fallbackCourse: second.slug,
          mockCalls: mock.calls,
          browserErrors: pageErrors,
        },
        null,
        2,
      ),
    );
    console.log(
      `SMOKE PASS · artifacts: ${path.relative(process.cwd(), runDir)}`,
    );
  } catch (error) {
    await writeFile(path.join(runDir, "next.log"), log);
    console.error(`Smoke artifacts: ${runDir}\n${log.slice(-5000)}`);
    throw error;
  } finally {
    await browser?.close();
    await new Promise<void>((resolve) => {
      if (web.exitCode !== null) resolve();
      else {
        web.once("exit", () => resolve());
        web.send("close");
      }
    });
    await mock.close();
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
