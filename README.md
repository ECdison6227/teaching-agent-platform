# 学伴 · Teaching Agent Platform

把任意课程的课件、教材和习题整理成一个学习空间：引导对话、自学天地、知识点讲义、练习题和个人笔记。教师和学生使用同一个五步建课入口，MVP 无需账号。

Next.js 15 / React 19 / TypeScript / Tailwind / shadcn/ui；SQLite + Drizzle ORM；独立 Node worker 使用 LibreOffice 与 Poppler 处理资料。课程文件保存在本地，不打包进前端。

## 本地安装

```bash
git clone <本仓库的 Git 地址>
cd teaching-agent-platform
```

需要 Node **>=22.12**。使用 nvm 时：

```bash
source ~/.nvm/nvm.sh
nvm install 22
nvm use 22
```

若环境设置了不兼容 nvm 的 `NPM_CONFIG_PREFIX`，先 `unset NPM_CONFIG_PREFIX`，再 `nvm use --delete-prefix 22`。

Ubuntu / Debian 系统依赖：

```bash
sudo apt-get update
sudo apt-get install -y libreoffice poppler-utils
```

macOS（Homebrew）：

```bash
brew install --cask libreoffice
brew install poppler
# 如果终端找不到 soffice：
export PATH="/Applications/LibreOffice.app/Contents/MacOS:$PATH"
```

确认 `soffice --version`、`pdfinfo -v`、`pdftoppm -v`、`pdftotext -v` 可执行，然后安装与初始化：

```bash
npm install
cp .env.example .env.local
npm run db:init
npm run dev
```

另开一个终端，同样切换 Node 22，在仓库根目录启动 worker：

```bash
npm run worker
```

打开 <http://localhost:3000>。Web 和 worker 都读取 `.env.local`，必须使用相同的 `DATA_DIR`。修改环境变量后重启两个进程。`npm run worker -- --once` 领取并执行一个任务后退出，适合调试。

生产构建可在本地验证：`npm run build && npm start`，同时保留独立 worker。默认 Web 仅监听本机地址。

## 用法

1. 首页进入“新建课程”：创建名称 → 课程 PPT → 教材 → 习题 → 其他资料。名称可跳过使用默认值；资料步骤都可跳过，提交时至少有一份课件或教材。
2. 各步骤支持多个 PDF / PPT / PPTX / DOC / DOCX / ODP。单文件最多 200 MB，单课程最多 12 份文件、总计 500 页。同一课程、同一资料类别按 SHA-256 去重。
3. 提交后查看进度百分比和处理步骤。可以离开，稍后从首页继续。上传后尚未提交的草稿也可从首页恢复向导。队列不动时检查 worker 是否启动、数据目录是否一致。
4. 导入完成后进入 `/c/[slug]`。引导对话引用实际课程数据；自学天地提供课件页、AI 要点、知识点导航、教材讲义和练习。存在课件时以课件作为课程连续页码；只有教材时以教材作为课程页。
5. 进入“内容审核台”修改知识点标题/讲义、页面归属/要点、题目答案/解析。自动抽取的题目一律标“待核对”，缺失答案不伪造；补全并确认后，选择、判断和填空题才自动判分。简答题保留参考答案，供自行核对。
6. 学习笔记按 `notes:<courseId>` 保存在浏览器 localStorage，手动保存并可导出 Markdown。课程资料提供原 PDF 或办公文档转换后的 PDF 下载。

导入失败会记录错误，可点击“重新导入”。重跑替换该课程的派生内容，保留上传原件。worker 每 10 秒写心跳，意外退出后，运行中的任务会在下次 worker 扫描时于 5 分钟过期后标记失败，之后可重试。运行中请勿同时启动多个不同版本的 Web / worker。

大文件导入可在 `.env.local` 配置以下参数，重启 worker 后生效：

| 环境变量                               | 默认值   | 用途                                                   |
| -------------------------------------- | -------- | ------------------------------------------------------ |
| `IMPORT_SOFFICE_TIMEOUT_MS`            | `900000` | LibreOffice 转换超时，15 分钟                          |
| `IMPORT_PDFINFO_TIMEOUT_MS`            | `120000` | PDF 信息读取超时                                       |
| `IMPORT_PDFTOPPM_TIMEOUT_MS`           | `120000` | 页图转换基础超时                                       |
| `IMPORT_PDFTOPPM_PER_PAGE_TIMEOUT_MS`  | `30000`  | 页图转换每页追加预算                                   |
| `IMPORT_PDFTOTEXT_TIMEOUT_MS`          | `120000` | PDF 文本提取基础超时                                   |
| `IMPORT_PDFTOTEXT_PER_PAGE_TIMEOUT_MS` | `10000`  | 文本提取每页追加预算                                   |
| `IMPORT_COMMAND_TIMEOUT_MS`            | `120000` | 其他外部命令超时                                       |
| `IMPORT_PAGE_CONCURRENCY`              | `4`      | 页图/文本提取、扫描页 OCR 和逐页要点的并发上限（1–16） |

超时单位均为毫秒，须为正整数；无效配置使用默认值，并发大于 16 时取 16。Poppler 超时为基础值加上本次处理页数乘以每页预算；当前每条命令处理一页。转换命令各自使用独立进程组，超时、非零退出或输出超限时清理整组子进程。OCR 与要点按完成页数推进进度，结果仍按原页码保存；单页模型失败重试 2 次后保留页图、降级为规则要点并标记待核对，不阻塞其他页。扫描页没有成功转录时不以要点伪造原文，可在模型恢复后重新导入。

## 模型配置

默认 `.env.example` 使用 `MODEL_PROVIDER=none`，无需密钥即可完成资料转换、规则章节划分、原文要点、讲义和题号规则抽取；对话提供当前页学习引导。规则结果会注明待核对，不冒充模型输出。

需要模型时，将 `MODEL_PROVIDER` 改成 `school`、`stepfun`、`agnes`、`deepseek` 或 `openai-compatible`，填写该通道的 `BASE_URL` / `CHAT_MODEL` / `API_KEY`（学校通道也支持 `SCHOOL_CHAT_BASE_URL` / `SCHOOL_CHAT_API_KEY`）。例如通用兼容服务：

```dotenv
MODEL_PROVIDER=openai-compatible
OPENAI_BASE_URL=http://127.0.0.1:3731/v1
OPENAI_CHAT_MODEL=your-text-model
OPENAI_API_KEY=
# 支持图像输入的模型，留空则逐页要点仅使用文本
OPENAI_VISION_MODEL=your-vision-model
```

此地址可以连接 `npm run mock:model` 启动的本地假模型。真实服务换为自己的 API 地址、模型名和密钥，地址包含 API 前缀但不包含 `/chat/completions`。

不同任务可分配到不同通道：`CHAT_MODEL_PROVIDER`、`STRUCTURE_MODEL_PROVIDER`、`NOTES_MODEL_PROVIDER`、`TEXTBOOK_MODEL_PROVIDER`、`QUESTIONS_MODEL_PROVIDER`。对应的 `*_MODEL` 可覆盖文本模型名，`VISION_MODEL_PROVIDER` 单独选择视觉通道。通道还支持 `*_VISION_BASE_URL` / `*_VISION_API_KEY` / `*_VISION_MODEL`；没有可用视觉模型时使用文本。扫描页有视觉模型时进行转录，没有时保留页图并提示待补充。

结构化响应使用 Zod 校验；章节、讲义、习题失败重试一次，仍失败则记录失败任务。逐页 OCR / 要点失败重试 2 次后以 `rules:model-failed` 和“待核对”明确标记规则降级；无模型时为 `rules:no-model`。模型要点的标题、要点、关键词使用 `courses.language`（默认 `zh`），专业术语可括注英文，转录原文保留原语言。标题去除尾随标点，并要求模型根据内容拟题，页码占位标题会触发重试。逐页公式进行 KaTeX 格式检查。Job 记录成功响应报告的 token 用量；不推算失败调用或不报告 usage 的用量。聊天通过 OpenAI 兼容 SSE 协议，支持停止、重试及交互题卡。

## 数据与代码

```text
src/db/schema.ts          八张表的 Drizzle schema
drizzle/                 已提交的 SQLite 迁移
src/lib/importer.ts      导入管线、任务领取及心跳
src/lib/models/          按任务选择模型的兼容通道
src/lib/chat-protocol.ts 动态页数的流式题卡/课件协议
src/components/          业务视图和复用的 shadcn/ui
scripts/worker.ts        独立队列进程
samples/                 原创基础概率示例 PDF
data/platform.sqlite     运行时数据库（不提交）
data/courses/<id>/        上传原件与派生页图、文本、PDF（不提交）
```

`DATA_DIR` 默认 `./data`，支持绝对路径。数据库为其中的 `platform.sqlite`，文件路径存为相对于数据目录的 key；下载与页图均经过课程 API，不能传入任意文件路径。SQLite 使用外键、WAL 和原子队列领取。`npm run db:init` 可重复执行；修改 schema 后用 `npm run db:generate` 生成迁移并重启进程。备份请在停止 Web / worker 后复制整个 DATA_DIR（包含数据库及文件）。

支持 `NEXT_PUBLIC_BASE_PATH=/your-prefix`，需在构建前配置，浏览器 API 请求和 Next 路由均沿用此前缀。

## 验收与原创样例

```bash
npm run typecheck
npm test
npm run build
npm run smoke:import
```

Smoke 使用本地 HTTP mock 模型，自动启动隔离的 Next 服务和 worker，将独立临时目录（系统临时目录下 `tap-smoke-*`，结束时输出位置）设为自己的 `DATA_DIR`，保存原创样例、数据库、结果和浏览器截图，不使用真实模型凭据或现有数据目录。已有生产构建时用 `next start`，否则使用开发服务。

Smoke 会实际点击五步建课向导，用原创四页概率 PDF、同一教材 PDF 和一页习题 PDF 完整导入，检查页图、文本、知识点、要点、讲义、四种题型入库、课程渲染、SSE 对话、翻页、移动侧栏、审核以及笔记保存与隔离；再验证无模型教材 DOCX 导入，PPTX / PPT / DOC 转换、单页模型失败降级和任务失败重试。

浏览器验收使用 Playwright。已有 Google Chrome 时自动使用 `/opt/google/chrome/chrome`，也可指定 `CHROME_BIN`；其他环境先运行：

```bash
npx playwright install chromium
# Linux 缺浏览器依赖时：npx playwright install --with-deps chromium
```

`npm run samples` 可重新生成原创 PDF，原文没有外部教材、个人信息、图片或嵌入字体。

## MVP 边界

- 匿名本机模式，无账号、访问控制或真正的私人分享隔离；`visibility=private` 只是后续权限体系的元数据。多课程数据和浏览器笔记已按 ID 区分。不要将当前 MVP 作为有权限保护的公共服务使用。
- 文件转换依赖 LibreOffice 的版式兼容性；复杂排版、扫描件及嵌入公式仍需人工核对，优先上传自行确认过的 PDF。长课程按摘要划分知识点，讲义依关键词选段；尚无向量检索。
- 联系信息只做电话、邮箱、带标签教师信息的规则过滤，不能代替人工隐私审查；下载保留原资料。
- 包含最小审核与全任务重试；细粒度步骤重试、分片上传、自动扩展题、双模型答案仲裁、生成讲解版 PDF、认证及部署不在此版本范围。
- `npm audit --omit=dev` 为 0 告警；全量审计仍有 12 项开发依赖告警（7 中等、5 高），来自 Tailwind 3、Drizzle Kit 的传递工具链。已更新 KaTeX / PostCSS；框架保持任务要求的 Next.js 15。

## 许可与版权

代码按 [MIT License](LICENSE) 提供，包含从授权旧项目复用的通用 UI、对话状态机及公式渲染逻辑。**上传资料、课程内容及其对外提供的版权和使用许可由使用方自行负责。** 仓库只附原创示例，不包含私有课程课件、教师联系信息或密钥。

技术参考：[Next.js 15 Route Handlers](https://nextjs.org/docs/15/app/api-reference/file-conventions/route)、[Drizzle SQLite](https://orm.drizzle.team/docs/get-started/sqlite-new)、[shadcn/ui](https://ui.shadcn.com)。
