# FIX6：习题响应容错与限流续跑

课程顶部按导入项类型聚合计数，默认只显示摘要；展开明细后可前往审核台，答案项可直接定位到题目。限流待处理与答案待补分别计数，已有答案的旧提示不再显示。

## 根因与真实模型复现

- 旧实现解析 JSON 后立即严格校验，`options` 可省略，但一旦出现必须至少有两项。非选择题常见的 `options: []` 因此整批失败；字段别名、题型别名和标量表示差异也没有归一化机会。失败只记录“JSON 不符合 schema”，没有原始输出或错误路径，无法追溯逐个历史批次的具体字段。
- 使用 SQLite 只读连接和只读原文缓存，选取一个历史失败批次重新请求 Agnes 3.0 Flash。第一次返回空 `questions`，被完整性检查拒绝；第二次返回全部 10 题，但每题都有空选项数组，原始校验产生 `questions.0.options` 至 `questions.9.options` 的 `too_small`。归一化省略空选项后，10 题全部通过。该复现确认了一个实际失败形态，不能据此认定其余历史失败批次原因完全相同。
- 原 provider 将 429 与网络错误共用三次重试，不读取 `Retry-After`，并发独立推导轮次没有通道共享的限速。耗尽后错误被吞成空答案，持久化为“答案未能可靠推导”，混淆了上游失败和求解结果。

真实复现的原始响应摘要、错误路径和运行结果仅保存在本次 DATA_DIR；未修改 E2E 目录、密钥、私有原文和现有运行进程。

## 行为变更

- 习题抽取与答案推导先统一字段别名、选项数组/字典、数值字符串、答案数组/布尔值、题型枚举和已知包裹层，再校验。必要题干、未知题型、题目数量与来源 ID 等约束仍保留。失败批按 10→5→1 等方式顺序拆小，只有最后失败题走规则；模型成功结果和原题边界保留。空批降级仍有待核对检查点。
- 诊断文件位于 `DATA_DIR/courses/<courseId>/model-diagnostics.ndjson`，文件权限为 0600。记录最多 2000 字符的脱敏原始输出、原始长度、Zod 错误路径、通道和批次；归一化成功的形态也保留原始问题。控制台不打印响应原文，诊断写入失败不使模型结果失败。
- 通道共享进程内的请求调度，包括聊天流和各结构化任务。429 遵守秒数/HTTP 日期的 `Retry-After` 下限，使用独立且可配置的较长退避和重试预算；将并发减半，连续成功且经过恢复窗口后逐次加一。RPM 平滑发送时间，重试同样受调度约束；取消排队请求不占用许可。
- 答案任一必需轮次耗尽 429 预算后，该题持久化为 `pending`，不发起仲裁；本轮尚未启动的题同样保留待处理，避免每题重复消耗整套限流预算。在途任务结束后导入任务可正常完成并显示待处理摘要。续跑按钮创建仅处理答案的队列任务，CLI 的 `--from answers` 也可使用，已有答案不重新计算。抽取遇 429 耗尽则保留失败批供任务续跑，不拆批放大请求。
- `pending` 仅扩展现有 SQLite TEXT 字段的 TypeScript 枚举，物理表没有枚举 CHECK 约束，不需要破坏性迁移。

默认参数及通道覆盖示例见 `.env.example` 和 README。调度在同一进程内跨任务/模型共享；多个独立进程需分别分配 RPM 预算。

## 验证

使用 Node 22.23.3，构建和烟测使用独立目录 `data/fix6-checks/next`，不覆盖现有服务构建。最终检查均以退出码 0 完成：

```text
npm run typecheck  → Route types generated successfully；tsc 无错误
npm test          → tests 78 / pass 78 / fail 0
npm run build     → Compiled successfully；生产路由与静态页面生成完成
npm run smoke:import → SMOKE PASS
```

烟测输出包含原有 mock 导入、无模型降级、PPTX/PPT/DOC 转换和续跑、OMML/视觉公式恢复，以及新增检查：

```text
PASS FIX6 UI: 7 batches + 6 missing answers aggregate, details collapsed by default,
review anchor navigation, pending 429 answer resumes through queued answers-only job
```

新增回归覆盖实际空选项形态、字段/包裹层/类型归一化、10→5→1 拆批及部分成功、诊断脱敏和截断、Retry-After、429 独立预算、通道配置覆盖、RPM、自适应并发恢复、聊天流与结构化任务共享许可、取消排队、持久化 pending、持续限流暂停后续请求以及课程隔离。
