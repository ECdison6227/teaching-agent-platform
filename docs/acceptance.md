# M0 + M1 本地验收记录

日期：2026-10-20。分支：`feat/m0-m1-mvp`。运行环境：Node v22.23.3、Next.js 15.5.28，系统已有 LibreOffice / Poppler，浏览器使用本机 Google Chrome。

## 必需命令

均在仓库根目录使用 Node 22 执行，退出码均为 0：

```text
npm run db:init
数据库已初始化：/workspace/teaching-agent-platform/data/platform.sqlite

npm run typecheck
next typegen && tsc --noEmit（路由类型生成成功，无错误）

npm test
# tests 11
# pass 11
# fail 0

npm run build
Next.js 15.5.28
✓ Compiled successfully
✓ Generating static pages (5/5)
完成 16 个页面 / API 路由的构建与类型检查

npm run smoke:import
PASS mock import: pages=4, text=4, knowledgePoints=3, notes=4, questions=4, tokens=1080; wizard + SSE chat + study + review + notes + mobile
PASS fallback import: DOCX -> PDF -> PNG/text, textbook-only, rules notes/questions, deduplication, cross-course isolation
PASS office/retry: PPTX + PPT + DOC -> PDF, failed job recorded, reimport replaces partial data
SMOKE PASS · artifacts: data/smoke/1792467392576
```

## 实际覆盖

- Playwright 点击五步向导，提交原创四页课程 PDF、教材 PDF 和一页习题 PDF。
- 独立 worker 通过本地 OpenAI 兼容 HTTP mock，实际调用章节划分、视觉要点、讲义、习题抽取及 SSE 对话。入库 4 页、3 个知识点、4 份要点及 choice / truefalse / fill / short 四种题型。
- 检查 PDF 文本、PNG 文件及 API 响应、课程状态与 100% 进度；中文 slug 的 `/c/[slug]` 成功渲染。
- 实际操作自学翻页、练习提交、答案审核、审核后的自动判分、笔记保存与刷新恢复、移动端侧栏；浏览器运行时错误为 0。
- 缺失答案不能标记为已核对；不同课程的下载和页面知识点映射不能混用；笔记按课程隔离。
- 无模型 worker 导入纯教材 DOCX，并抽取规则习题；实际通过 LibreOffice 验证 PPTX / PPT / DOC / DOCX → PDF。
- 模拟模型 HTTP 429，确认 provider 退避重试三次后仅降级该页；在讲义入库时注入故障，确认已生成页面和要点可浏览，再经 UI 从失败处继续，保留完成内容且无重复页面。
- 单元测试补充覆盖协议任意分块、动态页数（含大于 148 页的课程）、SSE UTF-8 / CRLF、题目核对状态、上传类型、路径越界、去重、原子领取、心跳过期、模型 schema 与页面重归属后的题目关联。

原始验收数据库、页图、文本、结果 JSON 及 `study.png` / `review.png` 均在上述 data 目录，按 .gitignore 排除。`npm run smoke:import` 每次创建独立目录，可重复执行。源码及原创样例可提交，不包含旧课程内容或密钥。

## 依赖与范围

`npm audit --omit=dev`：0 项告警。全量安装审计：12 项开发工具链告警（7 中等、5 高），详见 README 的 MVP 边界。

TASK 范围内功能已实现。匿名模式、单机队列、本地存储和最小审核符合本阶段范围；认证、分片上传、扩展题生成、双模型答案仲裁及讲解版 PDF 属后续工作。复杂办公文档、扫描件和自动答案仍需人工审核。

未 push、未合并、未部署；验收服务仅临时监听本机地址，完成后关闭。
