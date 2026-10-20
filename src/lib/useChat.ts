"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  formatAnswer,
  type Card,
  type CardAnswer,
  type Figure,
} from "@/lib/cards";
import type { ChatModelOption } from "@/lib/models/options";
import { readSseData } from "@/lib/sse";
import {
  requestScope,
  requestError,
  MODEL_TIMEOUT_MS,
} from "@/lib/request-lifecycle";
import {
  MAX_IMAGE_BYTES,
  MAX_REQUEST_BYTES,
  MAX_MESSAGE_CHARS,
  MAX_HISTORY_CHARS,
} from "@/lib/request-limits";
import { appPath } from "@/lib/app-path";

export type Msg = {
  id: string;
  role: "user" | "assistant";
  content: string;
  card?: Card;
  answered?: boolean;
  verdict?: { correct: boolean; reason?: string };
  figures?: Figure[];
  /** 学生上传的原图（data URL），会随这条消息一起交给多模态模型 */
  images?: string[];
  status?: "streaming" | "complete" | "failed" | "stopped";
};

export type PageCtx = {
  page: number;
  section?: string;
  title?: string;
  bullets?: string[];
  classmate?: boolean;
};

const uid = () => Math.random().toString(36).slice(2, 10);

/** 引导对话的核心状态机：首页与侧边栏共用 */
export function useChat(courseId: string, context?: PageCtx | null) {
  const [msgs, setMsgs] = useState<Msg[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 待随下一条消息一起发出的原图 */
  const [pendingImages, setPendingImages] = useState<string[]>([]);
  /** 课件选区或回答里「追问」带进输入框的原文，发出后清空 */
  const [quote, setQuote] = useState<string | null>(null);
  /** 当前这套对话接下来要用的模型。首页和侧栏各有一套 useChat，所以各自记住。 */
  const [models, setModels] = useState<ChatModelOption[]>([]);
  const [modelId, setModelId] = useState<string | null>(null);

  const msgsRef = useRef<Msg[]>([]);
  const ctxRef = useRef<PageCtx | null>(context ?? null);
  const modelRef = useRef<string | null>(null);
  const requestRef = useRef<AbortController | null>(null);
  const lastRequestRef = useRef<{
    history: ReturnType<typeof toHistory>;
    context: PageCtx | null;
    assistantId: string;
  } | null>(null);

  const stop = useCallback(
    () =>
      requestRef.current?.abort(new DOMException("请求已停止", "AbortError")),
    [],
  );
  useEffect(
    () => () => {
      requestRef.current?.abort();
    },
    [],
  );

  useEffect(() => {
    let cancelled = false;
    fetch(appPath("/api/models"))
      .then((r) => {
        if (!r.ok) throw new Error("models");
        return r.json() as Promise<{
          models?: ChatModelOption[];
          defaultId?: string;
        }>;
      })
      .then((data) => {
        if (cancelled) return;
        const list = Array.isArray(data.models) ? data.models : [];
        setModels(list);
        const current = modelRef.current;
        const keep =
          current && list.some((m) => m.id === current) ? current : null;
        const next = keep || data.defaultId || list[0]?.id || null;
        modelRef.current = next;
        setModelId(next);
      })
      .catch(() => {
        if (!cancelled) setModels([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const setModel = useCallback((id: string) => {
    modelRef.current = id;
    setModelId(id);
  }, []);

  useEffect(() => {
    ctxRef.current = context ?? null;
  }, [context]);

  const commit = useCallback((updater: (prev: Msg[]) => Msg[]) => {
    const next = updater(msgsRef.current);
    msgsRef.current = next;
    setMsgs(next);
    return next;
  }, []);

  /** 助手消息要带上自己发出的卡片，否则模型看不到上一轮问了什么 */
  const toHistory = (list: Msg[]) =>
    list
      .filter(
        (m) =>
          m.status !== "failed" &&
          (m.role === "user" || m.content.trim() || m.card || m.images?.length),
      )
      .slice(-24)
      .map((m) => {
        const text =
          m.role === "assistant" && m.card
            ? `${m.content}\n\n[我上一轮给出的卡片] ${JSON.stringify(m.card)}`
            : m.content;
        if (m.role === "user" && m.images?.length) {
          return {
            role: m.role,
            content: [
              {
                type: "text" as const,
                text: text.trim() || "请看我上传的图片",
              },
              ...m.images.map((url) => ({
                type: "image_url" as const,
                image_url: { url },
              })),
            ],
          };
        }
        return { role: m.role, content: text };
      });

  const handleEvent = useCallback(
    (ev: Record<string, unknown>, id: string) => {
      if (ev.type === "text") {
        const delta = String(ev.delta ?? "");
        commit((p) =>
          p.map((m) =>
            m.id === id ? { ...m, content: m.content + delta } : m,
          ),
        );
      } else if (ev.type === "verdict") {
        const correct = ev.correct === true;
        commit((p) =>
          p.map((m) =>
            m.id === id
              ? {
                  ...m,
                  verdict: {
                    correct,
                    reason:
                      typeof ev.reason === "string" ? ev.reason : undefined,
                  },
                }
              : m,
          ),
        );
      } else if (ev.type === "card") {
        commit((p) =>
          p.map((m) => (m.id === id ? { ...m, card: ev.card as Card } : m)),
        );
      } else if (ev.type === "figure") {
        const fig = ev.figure as Figure;
        if (fig)
          commit((p) =>
            p.map((m) =>
              m.id === id ? { ...m, figures: [...(m.figures ?? []), fig] } : m,
            ),
          );
      } else if (ev.type === "error") {
        setError(String(ev.message ?? "出错了"));
      }
    },
    [commit],
  );

  const callApi = useCallback(
    async (
      history: ReturnType<typeof toHistory>,
      pageContext?: PageCtx | null,
    ): Promise<boolean> => {
      if (requestRef.current) return false;
      const controller = new AbortController();
      requestRef.current = controller;
      const scope = requestScope(controller.signal, MODEL_TIMEOUT_MS + 10_000);
      setBusy(true);
      setError(null);
      const id = uid();
      const ctx = pageContext === undefined ? ctxRef.current : pageContext;
      lastRequestRef.current = { history, context: ctx, assistantId: id };
      commit((p) => [
        ...p,
        { id, role: "assistant" as const, content: "", status: "streaming" },
      ]);
      try {
        const packed = {
          messages: history,
          pageContext: ctx,
          model: modelRef.current,
        };
        const textLength = () =>
          packed.messages.reduce(
            (total, message) =>
              total +
              (typeof message.content === "string"
                ? message.content.length
                : message.content.reduce(
                    (size, part) =>
                      size + (part.type === "text" ? part.text.length : 0),
                    0,
                  )),
            0,
          );
        // 只丢弃最早的历史；当前消息始终保留，避免图片历史使后续每轮都超限。
        while (
          packed.messages.length > 1 &&
          (textLength() > MAX_HISTORY_CHARS ||
            new TextEncoder().encode(JSON.stringify(packed)).length >
              MAX_REQUEST_BYTES)
        ) {
          packed.messages = packed.messages.slice(1);
        }
        const body = JSON.stringify(packed);
        if (new TextEncoder().encode(body).length > MAX_REQUEST_BYTES)
          throw new Error("图片总量过大，请减少图片后重试");
        const res = await fetch(appPath(`/api/courses/${courseId}/chat`), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body,
          signal: scope.signal,
        });
        if (!res.ok) {
          const detail = await res.json().catch(() => null);
          throw new Error(detail?.error || `请求失败（${res.status}）`);
        }
        if (!res.body) throw new Error("没有收到响应内容，请重试");
        let completed = false;
        for await (const data of readSseData(res.body, scope.signal)) {
          const event = JSON.parse(data) as Record<string, unknown>;
          if (event.type === "error")
            throw new Error(String(event.message || "模型调用失败"));
          if (event.type === "done") {
            completed = true;
            break;
          }
          handleEvent(event, id);
        }
        scope.signal.throwIfAborted();
        if (!completed) throw new Error("连接中断，回复尚未完成，请重试这一轮");
        commit((p) =>
          p.map((m) => (m.id === id ? { ...m, status: "complete" } : m)),
        );
        return true;
      } catch (e) {
        const stopped = controller.signal.aborted;
        setError(stopped ? null : requestError(e, scope.signal));
        commit((p) =>
          p.map((m) =>
            m.id === id
              ? {
                  ...m,
                  status: stopped ? "stopped" : "failed",
                  card: undefined,
                }
              : m,
          ),
        );
        return false;
      } finally {
        scope.dispose();
        if (requestRef.current === controller) {
          requestRef.current = null;
          setBusy(false);
        }
      }
    },
    [commit, handleEvent, courseId],
  );

  const send = useCallback(
    async (
      raw: string,
      extraImages?: string[],
      pageContext?: PageCtx | null,
    ) => {
      const text = raw.trim();
      if (text.length > MAX_MESSAGE_CHARS) {
        setError("单条消息不能超过 20000 字，请分段发送");
        return false;
      }
      const images = extraImages?.length ? extraImages : pendingImages;
      if ((!text && !images.length) || requestRef.current) return false;
      setPendingImages([]);
      setQuote(null);
      const next = commit((p) => [
        ...p,
        {
          id: uid(),
          role: "user" as const,
          content: text || "（我上传了一张图片）",
          ...(images.length ? { images } : {}),
        },
      ]);
      return callApi(toHistory(next), pageContext);
    },
    [pendingImages, commit, callApi],
  );

  const queueImages = useCallback((urls: string[]) => {
    const next = urls.filter(Boolean);
    if (!next.length) return;
    setPendingImages((prev) =>
      [...prev, ...next.filter((u) => !prev.includes(u))].slice(-4),
    );
  }, []);

  const clearAttachments = useCallback(() => {
    setPendingImages([]);
  }, []);

  const removePendingImage = useCallback((index: number) => {
    setPendingImages((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const answerCard = useCallback(
    async (card: Card, answer: CardAnswer, msgId: string) => {
      const message = msgsRef.current.find((m) => m.id === msgId);
      if (requestRef.current || !message?.card || message.answered) return;
      const text = formatAnswer(card, answer);
      const next = commit((p) => [
        ...p.map((m) => (m.id === msgId ? { ...m, answered: true } : m)),
        { id: uid(), role: "user" as const, content: text },
      ]);
      await callApi(toHistory(next));
    },
    [commit, callApi],
  );

  const onImage = useCallback(async (file: File) => {
    if (
      !["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        file.type,
      )
    ) {
      setError("请上传 PNG、JPEG、WebP 或 GIF 图片");
      return;
    }
    if (file.size > MAX_IMAGE_BYTES) {
      setError("单张图片不能超过 3 MB，请压缩后上传");
      return;
    }
    setError(null);
    try {
      const dataUrl = await new Promise<string>((resolve, reject) => {
        const r = new FileReader();
        r.onload = () => resolve(String(r.result));
        r.onerror = () => reject(new Error("读取图片失败"));
        r.readAsDataURL(file);
      });
      setPendingImages((prev) => [...prev, dataUrl].slice(-4));
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  const pushUserMessage = useCallback(
    (text: string) => {
      commit((p) => [
        ...p,
        { id: uid(), role: "user" as const, content: text },
      ]);
    },
    [commit],
  );

  const retry = useCallback(async () => {
    const previous = lastRequestRef.current;
    if (!previous || requestRef.current) return;
    commit((messages) =>
      messages.filter((message) => message.id !== previous.assistantId),
    );
    await callApi(previous.history, previous.context);
  }, [commit, callApi]);

  return {
    msgs,
    busy,
    stop,
    retry,
    error,
    pendingImages,
    quote,
    setQuote,
    models,
    modelId,
    setModel,
    queueImages,
    setError,
    clearAttachments,
    removePendingImage,
    send,
    answerCard,
    onImage,
    pushUserMessage,
    callApi,
    toHistory,
  };
}
