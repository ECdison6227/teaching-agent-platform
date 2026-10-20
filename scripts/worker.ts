import "./env";
import { setTimeout } from "node:timers/promises";
import { runOneJob } from "../src/lib/importer";
let stopping = false;
process.on("SIGINT", () => {
  stopping = true;
});
process.on("SIGTERM", () => {
  stopping = true;
});
console.log(
  "Import worker ready (SQLite; concurrency=1). 使用 --once 处理一个任务后退出。",
);
async function main() {
  do {
    const worked = await runOneJob();
    if (process.argv.includes("--once")) break;
    if (!worked && !stopping) await setTimeout(1000);
  } while (!stopping);
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
