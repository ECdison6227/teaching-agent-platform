"use client";
import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import {
  BookOpen,
  ChevronLeft,
  ChevronRight,
  Download,
  FileText,
  Library,
  MessageCircle,
  NotebookPen,
  Send,
  Square,
} from "lucide-react";
import { CourseImportStatus } from "./CourseImportStatus";
import type { CourseContent } from "@/lib/courses";
import { useChat } from "@/lib/useChat";
import { appPath } from "@/lib/app-path";
import { loadNotes, saveNotes } from "@/lib/notes-store";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";
import { Textarea } from "./ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "./ui/select";
import {
  Sidebar,
  SidebarProvider,
  SidebarInset,
  SidebarHeader,
  SidebarContent,
  SidebarGroup,
  SidebarGroupLabel,
  SidebarMenu,
  SidebarMenuItem,
  SidebarMenuButton,
  SidebarFooter,
  SidebarTrigger,
} from "./ui/sidebar";
import { Markdown } from "./Markdown";
import { AnswerCard } from "./AnswerCard";
import { CourseFigure } from "./CourseFigure";
import { PracticePanel } from "./PracticePanel";
const views = [
  { id: "chat", label: "引导对话", icon: MessageCircle },
  { id: "study", label: "自学天地", icon: BookOpen },
  { id: "notes", label: "学习笔记", icon: NotebookPen },
  { id: "materials", label: "课程资料", icon: Library },
];
export function CourseWorkspace({ data }: { data: CourseContent }) {
  const [view, setView] = useState(
      data.course.status === "ready" ? "chat" : "study",
    ),
    [selectedKp, setSelectedKp] = useState("all"),
    [pageNumber, setPageNumber] = useState(1),
    [draft, setDraft] = useState("");
  const [notes, setNotes] = useState(""),
    [noteStatus, setNoteStatus] = useState("");
  const page = data.pages.find((p) => p.index === pageNumber) || data.pages[0];
  const kp = data.knowledgePoints.find(
    (k) => k.id === (selectedKp === "all" ? page?.kpId : selectedKp),
  );
  const shownPages = data.pages.filter(
    (p) => selectedKp === "all" || p.kpId === selectedKp,
  );
  const shownQuestions = data.questions.filter(
    (q) => selectedKp === "all" || q.kpId === selectedKp,
  );
  const chat = useChat(
    data.course.id,
    page ? { page: page.index, title: page.title } : null,
  );
  const bottom = useRef<HTMLDivElement>(null);
  useEffect(() => {
    try {
      setNotes(loadNotes(data.course.id));
    } catch {
      setNoteStatus("浏览器存储不可用，请导出笔记保存。");
    }
  }, [data.course.id]);
  useEffect(() => {
    bottom.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [chat.msgs]);
  async function send() {
    if (await chat.send(draft)) setDraft("");
  }
  function saveNote() {
    try {
      saveNotes(data.course.id, notes);
      setNoteStatus("笔记已保存到此浏览器");
    } catch {
      setNoteStatus("保存失败，请导出笔记。");
    }
  }
  function exportNotes() {
    const url = URL.createObjectURL(
      new Blob([`# ${data.course.title} · 学习笔记\n\n${notes}`], {
        type: "text/markdown;charset=utf-8",
      }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "学习笔记.md";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const currentPosition = shownPages.findIndex((p) => p.index === page?.index);
  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader className="gap-5 p-5">
          <Link
            href="/"
            className="flex items-center gap-2 font-semibold text-primary"
          >
            <BookOpen className="size-5" /> 学伴
          </Link>
          <div>
            <p className="text-xs text-muted-foreground">
              {data.course.subject || "我的课程"}
            </p>
            <h1 className="mt-2 text-lg font-semibold leading-7">
              {data.course.title}
            </h1>
            <p className="mt-2 text-xs text-muted-foreground">
              {data.pages.length} 页 · {data.knowledgePoints.length} 个知识点
            </p>
          </div>
        </SidebarHeader>
        <SidebarContent>
          <SidebarGroup>
            <SidebarGroupLabel>学习空间</SidebarGroupLabel>
            <SidebarMenu>
              {views.map((v) => (
                <SidebarMenuItem key={v.id}>
                  <SidebarMenuButton
                    onClick={() => setView(v.id)}
                    isActive={view === v.id}
                  >
                    <v.icon />
                    <span>{v.label}</span>
                  </SidebarMenuButton>
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroup>
        </SidebarContent>
        <SidebarFooter className="space-y-2 p-5">
          <Button asChild variant="outline" size="sm">
            <Link href={`/teach/${data.course.id}/review`}>内容审核台</Link>
          </Button>
          <Button asChild variant="ghost" size="sm">
            <Link href="/">返回我的课程</Link>
          </Button>
          <p className="text-xs leading-5 text-muted-foreground">
            循序渐进，理解比速度更重要。
          </p>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="min-w-0 bg-background">
        <header className="flex min-h-16 items-center gap-3 border-b px-4 sm:px-8">
          <SidebarTrigger />
          <span className="text-sm font-medium">
            {views.find((v) => v.id === view)?.label}
          </span>
          <span className="ml-auto hidden text-xs text-muted-foreground sm:block">
            {data.course.title}
          </span>
        </header>
        <CourseImportStatus data={data} />
        <div className="mx-auto w-full max-w-6xl flex-1 p-4 sm:p-8">
          {view === "chat" && (
            <div className="mx-auto max-w-3xl">
              <div className="mb-8">
                <p className="text-sm text-primary">和知识聊一聊</p>
                <h2 className="mt-3 text-2xl font-semibold">
                  从一个问题，走向真正理解。
                </h2>
                <p className="mt-3 text-sm leading-7 text-muted-foreground">
                  告诉学伴你的学习目标，也可以从正在看的第 {pageNumber} 页开始。
                </p>
              </div>
              <div className="space-y-4" aria-live="polite">
                {!chat.msgs.length && (
                  <Card className="border-dashed shadow-none">
                    <CardContent className="flex flex-wrap gap-2 p-5">
                      {[
                        "带我从基础开始学习",
                        "请解释当前页面的关键概念",
                        "用一道小题检验我的理解",
                      ].map((text) => (
                        <Button
                          key={text}
                          variant="outline"
                          size="sm"
                          onClick={() => void chat.send(text)}
                          disabled={chat.busy}
                        >
                          {text}
                        </Button>
                      ))}
                    </CardContent>
                  </Card>
                )}
                {chat.msgs.map((m) => (
                  <Card
                    key={m.id}
                    className={`${m.role === "user" ? "ml-6 bg-secondary/50" : "mr-2"} shadow-none`}
                  >
                    <CardContent className="p-5">
                      <p className="mb-3 text-xs font-medium text-primary">
                        {m.role === "user" ? "你" : "学伴"}
                        {m.status === "streaming"
                          ? " · 思考中"
                          : m.status === "stopped"
                            ? " · 已停止"
                            : m.status === "failed"
                              ? " · 回复未完成"
                              : ""}
                      </p>
                      <Markdown text={m.content} />
                      {m.verdict && (
                        <p className="my-3 text-sm">
                          {m.verdict.correct ? "✓ 回答正确" : "再想一想"} ·{" "}
                          {m.verdict.reason}
                        </p>
                      )}
                      {m.card && (
                        <AnswerCard
                          card={m.card}
                          disabled={chat.busy || m.answered}
                          onSubmit={(a) =>
                            void chat.answerCard(m.card!, a, m.id)
                          }
                          courseId={data.course.id}
                          pageCount={data.pages.length}
                        />
                      )}
                      {m.figures?.map((f, i) => (
                        <CourseFigure
                          key={i}
                          figure={f}
                          courseId={data.course.id}
                          pageCount={data.pages.length}
                        />
                      ))}
                    </CardContent>
                  </Card>
                ))}
                <div ref={bottom} />
              </div>
              {chat.error && (
                <p role="alert" className="my-4 text-sm text-destructive">
                  {chat.error}{" "}
                  <Button
                    variant="link"
                    size="sm"
                    onClick={() => void chat.retry()}
                  >
                    重试
                  </Button>
                </p>
              )}
              <Card className="sticky bottom-3 mt-8 shadow-sm">
                <CardContent className="space-y-3 p-4">
                  <Textarea
                    aria-label="向学伴提问"
                    value={draft}
                    onChange={(e) => setDraft(e.target.value)}
                    placeholder="写下你的问题……（Ctrl/⌘ + Enter 发送）"
                    maxLength={20000}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
                        e.preventDefault();
                        void send();
                      }
                    }}
                  />
                  <div className="flex items-center justify-between gap-3">
                    {chat.models.length ? (
                      <Select
                        value={chat.modelId || undefined}
                        onValueChange={chat.setModel}
                      >
                        <SelectTrigger
                          className="max-w-48"
                          aria-label="对话模型"
                        >
                          <SelectValue placeholder="选择模型" />
                        </SelectTrigger>
                        <SelectContent>
                          {chat.models.map((m) => (
                            <SelectItem key={m.id} value={m.id}>
                              {m.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <span className="text-xs text-muted-foreground">
                        规则学习模式 · 可在配置模型后升级
                      </span>
                    )}
                    {chat.busy ? (
                      <Button onClick={chat.stop} variant="outline">
                        <Square /> 停止
                      </Button>
                    ) : (
                      <Button
                        onClick={() => void send()}
                        disabled={!draft.trim()}
                      >
                        <Send /> 发送
                      </Button>
                    )}
                  </div>
                </CardContent>
              </Card>
            </div>
          )}
          {view === "study" && (
            <div className="space-y-6">
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h2 className="text-2xl font-semibold">自学天地</h2>
                  <p className="mt-2 text-sm text-muted-foreground">
                    沿着知识脉络，把每一页学扎实。
                  </p>
                </div>
                <Select
                  value={selectedKp}
                  onValueChange={(id) => {
                    setSelectedKp(id);
                    const first = data.pages.find(
                      (p) => id === "all" || p.kpId === id,
                    );
                    if (first) setPageNumber(first.index);
                  }}
                >
                  <SelectTrigger
                    className="w-full sm:w-72"
                    aria-label="知识点导航"
                  >
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">全部知识点</SelectItem>
                    {data.knowledgePoints.map((k) => (
                      <SelectItem key={k.id} value={k.id}>
                        {k.code} · {k.title}
                        {k.hasSlides ? "" : "（讲义）"}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="grid items-start gap-6 xl:grid-cols-[1.5fr_1fr]">
                <Card className="min-w-0 shadow-none">
                  <CardContent className="p-3">
                    {shownPages.length && page ? (
                      <>
                        <img
                          className="max-h-[65vh] w-full bg-white object-contain"
                          src={appPath(
                            `/api/courses/${data.course.id}/pages/${page.index}`,
                          )}
                          alt={`课程第 ${page.index} 页：${page.title}`}
                        />
                        <div className="mt-3 flex items-center justify-between gap-2">
                          <Button
                            aria-label="上一页"
                            size="icon"
                            variant="outline"
                            disabled={currentPosition <= 0}
                            onClick={() =>
                              setPageNumber(
                                shownPages[currentPosition - 1].index,
                              )
                            }
                          >
                            <ChevronLeft />
                          </Button>
                          <Select
                            value={String(pageNumber)}
                            onValueChange={(n) => setPageNumber(Number(n))}
                          >
                            <SelectTrigger
                              aria-label="课程页码"
                              className="max-w-64"
                            >
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {shownPages.map((p) => (
                                <SelectItem key={p.id} value={String(p.index)}>
                                  第 {p.index} 页 · {p.title.slice(0, 25)}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                          <Button
                            aria-label="下一页"
                            size="icon"
                            variant="outline"
                            disabled={currentPosition >= shownPages.length - 1}
                            onClick={() =>
                              setPageNumber(
                                shownPages[currentPosition + 1].index,
                              )
                            }
                          >
                            <ChevronRight />
                          </Button>
                        </div>
                      </>
                    ) : (
                      <p className="p-6 text-muted-foreground">
                        {data.pages.length
                          ? "此知识点没有课件页，请阅读下方讲义。"
                          : "尚无已生成页面，导入完成的页面将在这里显示。"}
                      </p>
                    )}
                  </CardContent>
                </Card>
                <Card className="shadow-none">
                  <CardHeader>
                    <CardDescription>
                      AI 学习要点 ·{" "}
                      {page?.note?.qaStatus === "passed"
                        ? "格式已检查"
                        : "待核对"}
                    </CardDescription>
                    <CardTitle className="leading-7">
                      {shownPages.length
                        ? page?.note?.title || page?.title
                        : kp?.title}
                    </CardTitle>
                  </CardHeader>
                  <CardContent className="space-y-4">
                    {shownPages.length ? (
                      page?.note ? (
                        page.note.points.map((p, i) => (
                          <Markdown key={i} text={`${i + 1}. ${p}`} />
                        ))
                      ) : (
                        <p>要点正在整理，可先浏览页图。</p>
                      )
                    ) : (
                      <p>请结合知识点讲义学习。</p>
                    )}
                    <p className="text-xs text-primary">
                      {shownPages.length
                        ? page?.note?.keys.join(" · ")
                        : kp?.keywords.join(" · ")}
                    </p>
                    <Button
                      variant="outline"
                      onClick={() => {
                        setView("chat");
                        setDraft(`请解释「${kp?.title || page?.title}」`);
                      }}
                    >
                      请学伴讲解
                    </Button>
                  </CardContent>
                </Card>
              </div>
              {kp && (
                <Card className="shadow-none">
                  <CardHeader>
                    <CardDescription>
                      {kp.code} · 知识点讲义
                      {data.importItems.some(
                        (item) =>
                          item.key === `textbook:${kp.id}` &&
                          item.status === "needs_review",
                      )
                        ? " · 待核对"
                        : ""}
                    </CardDescription>
                    <CardTitle>{kp.title}</CardTitle>
                  </CardHeader>
                  <CardContent>
                    <Markdown text={kp.contentMd} />
                  </CardContent>
                </Card>
              )}
              <section className="space-y-4">
                <h3 className="text-lg font-semibold">
                  随堂练习{" "}
                  <span className="text-sm font-normal text-muted-foreground">
                    {shownQuestions.length} 道
                  </span>
                </h3>
                {shownQuestions.length ? (
                  shownQuestions.map((q) => (
                    <PracticePanel key={q.id} question={q} />
                  ))
                ) : (
                  <p className="text-sm text-muted-foreground">
                    暂无匹配习题，可在引导对话中提出问题。
                  </p>
                )}
              </section>
            </div>
          )}
          {view === "notes" && (
            <div className="mx-auto max-w-3xl space-y-5">
              <h2 className="text-2xl font-semibold">学习笔记</h2>
              <p className="text-sm leading-7 text-muted-foreground">
                笔记按课程分开保存在此浏览器。离开前记得保存，也可以导出
                Markdown。
              </p>
              <Textarea
                aria-label="课程笔记"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                rows={18}
                placeholder="今天理解了什么？还有什么想继续追问？"
              />
              <div className="flex gap-3">
                <Button onClick={saveNote}>保存笔记</Button>
                <Button variant="outline" onClick={exportNotes}>
                  <Download /> 导出笔记
                </Button>
              </div>
              <p role="status" className="text-sm text-primary">
                {noteStatus}
              </p>
            </div>
          )}
          {view === "materials" && (
            <div className="space-y-5">
              <h2 className="text-2xl font-semibold">课程资料</h2>
              <p className="text-sm text-muted-foreground">
                下载上传的 PDF 或办公文档转换后的 PDF 版本。
              </p>
              {data.sources.map((s) => (
                <Card key={s.id} className="shadow-none">
                  <CardContent className="flex flex-wrap items-center gap-4 p-5">
                    <FileText className="size-6 text-primary" />
                    <div className="min-w-0 flex-1">
                      <p className="break-all font-medium">{s.filename}</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        {s.pages} 页 · PDF
                      </p>
                    </div>
                    <Button asChild variant="outline" size="sm">
                      <a
                        href={appPath(
                          `/api/courses/${data.course.id}/materials/${s.id}`,
                        )}
                        download
                      >
                        <Download /> 下载
                      </a>
                    </Button>
                  </CardContent>
                </Card>
              ))}
            </div>
          )}
        </div>
      </SidebarInset>
    </SidebarProvider>
  );
}
