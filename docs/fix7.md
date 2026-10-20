# FIX7：任务租约、失租中止与挂起恢复

`jobs` 增加可空的 `lease_owner` / `lease_expires_at`，迁移保留已有数据与任务状态。owner 包含主机名、PID 和每进程随机 token；进程不能通过读取数据库中的 token 冒认其他进程的任务。普通领取与定向续跑均原子写入归属。

progress、heartbeat 和终态更新统一要求课程、任务、`status=running` 与 owner 匹配。所有导入结果与检查点写入在 SQLite immediate 事务内校验归属，避免校验后被其他进程回收再写入。终态与课程状态同事务提交，最后心跳与 `finishedAt` 相同；终态之后不能再推进进度。

更新影响 0 行时立即中止任务的 AbortController，取消结构划分、OCR/要点、讲义、公式视觉恢复、习题抽取和答案推导中的全部模型请求，以及当前任务自己创建的转换命令。取消穿过并发池、排队、退避和降级分支，不会被当作普通模型错误继续处理。CLI 打印带时间戳的失租原因并以退出码 1 退出；退出路径不覆盖回收器或新 owner 写入的状态。

回收器先检查过期 owner 的主机和 PID：同主机 `process.kill(pid, 0)` 证明仍存活时延长宽限；EPERM 等不能证明进程死亡的探测错误也按存活处理。宽限可以反复延长，不停止进程。确认不了本机存活的过期任务才回收。旧无 owner 任务兼容原来的心跳超时规则。

墙钟与 `performance.now()` 的差值用于检测前后跳变，单调时钟的大间隔用于检测两者同时前进的长时间停顿。恢复后的首个心跳、progress 或结果写入检查立即续租。其他进程先扫描也会因本机 PID 存活而保留任务。

CLI 输出、导入事件和模型重试日志均有 ISO 时间戳。`import_step_start` / `import_step_end` 覆盖转换、公式、结构、逐页要点、讲义、习题抽取、答案推导和完整性检查，记录课程、任务、步骤、结束状态与单调时钟耗时。

配置见 `.env.example` 与 README：`IMPORT_LEASE_MS=300000`、`IMPORT_HEARTBEAT_MS=10000`、`IMPORT_LEASE_GRACE_MS=300000`、`IMPORT_CLOCK_JUMP_MS=30000`。值为毫秒正整数，心跳间隔不超过租约有效期的三分之一。

回归覆盖：

- 两个真实 Node 进程同时争用，只产生一个 owner；其他进程不能执行该任务。本机 owner 存活时不回收，自然退出后可以回收。
- 模拟挂起约 1.5 小时、墙钟前跳/后跳和两种时钟同时前进；验证宽限、立即续租与课程隔离。
- 分别在 progress、heartbeat、结果提交时发现 queued/done/failed 或 owner 改变，立即中止且保留原记录。
- 真实续跑 CLI 在两轮 HTTP 模型请求中被回收，分别由定时心跳和结果写入校验发现失租；验证退出码、请求取消、没有额外请求、没有答案/检查点/终态回写。
- 取消正在执行的自建转换命令，已中止的任务不启动命令；旧数据库迁移、终态时间一致性和全部步骤日志。

Node 22.23.3 验证输出：

```text
npm run typecheck       ✓ Route types generated successfully；tsc 退出码 0
npm test               tests 99 / pass 99 / fail 0 / skipped 0
npm run build          ✓ Compiled successfully；退出码 0
npm run smoke:import   SMOKE PASS
```

构建与 smoke 共用独立 `NEXT_DIST_DIR=data/fix7-verification/next`，检查日志只在忽略的 `DATA_DIR=data/fix7-verification`，smoke 自行创建独立临时 DATA_DIR 并保存浏览器与转换产物。未读取或修改真实课程数据，未修改独立 E2E 工作区，未停止或重启既有进程。新逻辑适用于随后启动的新版本进程；没有对既有进程热替换代码。
