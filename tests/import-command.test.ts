import test, { after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { command } from "../src/lib/import-command";
import {
  importCommandTimeout,
  importPageConcurrency,
  mapImportPages,
} from "../src/lib/import-settings";

const dir = await mkdtemp(path.join(tmpdir(), "tap-command-test-"));
process.env.DATA_DIR = dir;
after(() => rm(dir, { recursive: true, force: true }));

test("转换超时按命令和处理页数配置，无效值安全回退", () => {
  for (const name of Object.keys(process.env))
    if (name.startsWith("IMPORT_")) delete process.env[name];
  assert.equal(importCommandTimeout("soffice"), 900_000);
  assert.equal(importCommandTimeout("pdfinfo"), 120_000);
  assert.equal(importCommandTimeout("pdftoppm", 10), 420_000);
  assert.equal(importCommandTimeout("pdftotext", 10), 220_000);
  process.env.IMPORT_SOFFICE_TIMEOUT_MS = "1800000";
  process.env.IMPORT_PDFINFO_TIMEOUT_MS = "80000";
  process.env.IMPORT_PDFTOPPM_TIMEOUT_MS = "300000";
  process.env.IMPORT_PDFTOPPM_PER_PAGE_TIMEOUT_MS = "40000";
  process.env.IMPORT_PDFTOTEXT_TIMEOUT_MS = "200000";
  process.env.IMPORT_PDFTOTEXT_PER_PAGE_TIMEOUT_MS = "5000";
  assert.equal(importCommandTimeout("soffice"), 1_800_000);
  assert.equal(importCommandTimeout("pdfinfo"), 80_000);
  assert.equal(importCommandTimeout("pdftoppm", 3), 420_000);
  assert.equal(importCommandTimeout("pdftotext", 3), 215_000);
  process.env.IMPORT_COMMAND_TIMEOUT_MS = "-1";
  assert.equal(importCommandTimeout("other"), 120_000);
  process.env.IMPORT_SOFFICE_TIMEOUT_MS = "Infinity";
  assert.equal(importCommandTimeout("soffice"), 900_000);
  process.env.IMPORT_PDFTOPPM_TIMEOUT_MS = "2147483647";
  assert.equal(importCommandTimeout("pdftoppm", 500), 2_147_483_647);
  assert.equal(importPageConcurrency(), 4);
  process.env.IMPORT_PAGE_CONCURRENCY = "100";
  assert.equal(importPageConcurrency(), 16);
  process.env.IMPORT_PAGE_CONCURRENCY = "0.5";
  assert.equal(importPageConcurrency(), 4);
});

async function running(pid: number) {
  try {
    process.kill(pid, 0);
    if (process.platform === "linux") {
      const stat = await readFile(`/proc/${pid}/stat`, "utf8");
      // 容器 init 可能延迟回收僵尸；它们已经退出，不再运行或占 CPU。
      if (stat.slice(stat.lastIndexOf(")") + 2).startsWith("Z")) return false;
    }
    return true;
  } catch (error) {
    if (
      ["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code || "")
    )
      return false;
    throw error;
  }
}

for (const mode of ["timeout", "failure"] as const) {
  test(
    `命令${mode === "timeout" ? "超时" : "非零退出"}清理 sleep 子孙进程，仅影响自身进程组`,
    {
      skip: process.platform === "win32",
      timeout: 10_000,
    },
    async (t) => {
      process.env.IMPORT_COMMAND_TIMEOUT_MS = "1500";
      const pidFile = path.join(dir, `${mode}.json`);
      // 子进程继承管道；父进程先失败时也不能等 close 才清理子进程。
      const script = `
      const {spawn} = require('node:child_process');
      const {writeFileSync} = require('node:fs');
      const child = spawn('sh', ['-c', 'sleep 60 & echo $!; wait'], {stdio:['ignore','pipe','inherit']});
      child.stdout.once('data', (data) => {
        writeFileSync(process.argv[1], JSON.stringify([process.pid, child.pid, Number(String(data).trim())]));
        if (process.argv[2] === 'failure') process.exit(7);
      });
      setInterval(() => {}, 1000);
    `;
      const unrelated = spawn("sleep", ["60"]);
      t.after(() => unrelated.kill("SIGKILL"));
      await assert.rejects(
        command(process.execPath, ["-e", script, pidFile, mode]),
        mode === "timeout" ? /超时 1500 ms/ : /退出码 7/,
      );
      const pids: number[] = JSON.parse(await readFile(pidFile, "utf8"));
      t.after(async () => {
        for (const pid of pids)
          if (await running(pid)) process.kill(pid, "SIGKILL");
      });
      for (let attempt = 0; attempt < 50; attempt++) {
        if (!(await Promise.all(pids.map(running))).some(Boolean)) break;
        await delay(20);
      }
      assert.deepEqual(await Promise.all(pids.map(running)), [
        false,
        false,
        false,
      ]);
      assert.equal(await running(unrelated.pid!), true);
    },
  );
}

test("成功命令保留输出；启动失败与输出超限正常拒绝", async () => {
  process.env.IMPORT_COMMAND_TIMEOUT_MS = "5000";
  const result = await command(process.execPath, [
    "-e",
    "process.stdout.write('done'); process.stderr.write('warning')",
  ]);
  assert.deepEqual(result, { stdout: "done", stderr: "warning" });
  await assert.rejects(
    command(path.join(dir, "missing-command"), []),
    /无法启动/,
  );
  await assert.rejects(
    command(process.execPath, [
      "-e",
      "process.stdout.write('x'.repeat(5 * 1024 * 1024)); setInterval(() => {}, 1000)",
    ]),
    /输出超过/,
  );
});

test("失租信号立即取消自建转换命令；已中止的任务不启动命令", async () => {
  const controller = new AbortController();
  const reason = new Error("租约已被回收，停止转换");
  const started = performance.now();
  const pending = command(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    1,
    controller.signal,
  );
  const timer = setTimeout(() => controller.abort(reason), 100);
  try {
    await assert.rejects(pending, (error) => error === reason);
    assert.ok(performance.now() - started < 2000);
    assert.throws(
      () => command("must-not-spawn", [], 1, controller.signal),
      (error) => error === reason,
    );
  } finally {
    clearTimeout(timer);
  }
});

test("页池按完成计数、保持结果顺序，并在致命错误后等在途任务退出", async () => {
  process.env.IMPORT_PAGE_CONCURRENCY = "2";
  const progress: number[] = [];
  const results = await mapImportPages(
    [0, 1, 2],
    async (i) => {
      await delay(i === 0 ? 50 : 5);
      return i;
    },
    (n) => progress.push(n),
  );
  assert.deepEqual(results, [0, 1, 2]);
  assert.deepEqual(progress, [1, 2, 3]);
  const started: number[] = [];
  let inFlightFinished = false;
  await assert.rejects(
    mapImportPages(
      [0, 1, 2],
      async (i) => {
        started.push(i);
        await delay(i === 0 ? 5 : 50);
        if (i === 0) throw new Error("conversion failed");
        inFlightFinished = true;
      },
      () => {},
    ),
    /conversion failed/,
  );
  assert.deepEqual(started, [0, 1]);
  assert.equal(inFlightFinished, true);
});
