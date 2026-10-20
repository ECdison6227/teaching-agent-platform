// Smoke 自己的隔离服务：通过 IPC 关闭 HTTP/Next，再自行退出，不向进程发送信号。
import http from "node:http";
import next from "next";

const port = Number(process.argv[2]);
const app = next({
  dev: process.argv[3] === "dev",
  hostname: "127.0.0.1",
  port,
});
const ready = app.prepare().then(async () => {
  const server = http.createServer(app.getRequestHandler());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });
  return server;
});
process.on("message", async (message) => {
  if (message !== "close") return;
  try {
    const server = await ready;
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await app.close();
    process.exit(0);
  } catch {
    process.exit(1);
  }
});
await ready;
