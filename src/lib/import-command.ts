import { spawn } from "node:child_process";
import path from "node:path";
import { importCommandTimeout } from "./import-settings";

/** 每条转换命令独占进程组，失败只清理该组，不影响 worker 或其他导入。 */
export function command(bin: string, args: string[], pageCount = 1) {
  const timeout = importCommandTimeout(path.basename(bin), pageCount);
  return new Promise<{ stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(bin, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let size = 0;
    let failure: Error | undefined;
    const fail = (reason: string) => {
      failure ??= new Error(
        `${path.basename(bin)} 转换失败（${reason}）；请检查文件是否损坏、加密，以及系统依赖是否安装`,
      );
      if (child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ESRCH")
            child.kill("SIGKILL");
        }
      }
    };
    const timer = setTimeout(() => fail(`超时 ${timeout} ms`), timeout);
    const collect = (target: Buffer[]) => (chunk: Buffer) => {
      size += chunk.length;
      if (size > 4 * 1024 * 1024) fail("命令输出超过 4 MiB");
      else if (!failure) target.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));
    child.once("error", () => fail("无法启动命令"));
    // 不能等 close 才杀：父进程退出后，子进程可能仍持有 stdout/stderr。
    child.once("exit", (code, signal) => {
      if (code !== 0) fail(signal ? `信号 ${signal}` : `退出码 ${code}`);
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (!failure && code !== 0) fail(`退出码 ${code}`);
      if (failure) reject(failure);
      else
        resolve({
          stdout: Buffer.concat(stdout).toString("utf8"),
          stderr: Buffer.concat(stderr).toString("utf8"),
        });
    });
  });
}
