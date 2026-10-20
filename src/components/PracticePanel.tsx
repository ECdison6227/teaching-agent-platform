"use client";
import { useState } from "react";
import type { Question } from "@/db/schema";
import { grade } from "@/lib/grading";
import { Button } from "./ui/button";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "./ui/card";
import { Textarea } from "./ui/textarea";
import { Markdown } from "./Markdown";
export function PracticePanel({ question }: { question: Question }) {
  const [answer, setAnswer] = useState(""),
    [submitted, setSubmitted] = useState(false);
  const result = grade(question, answer);
  return (
    <Card className="shadow-none">
      <CardHeader>
        <CardDescription>
          {question.code} · {question.verified ? "答案已核对" : "待核对"}
        </CardDescription>
        <CardTitle className="text-base leading-7">
          <Markdown text={question.prompt} />
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {question.type === "choice" &&
          question.options?.map((o) => (
            <Button
              key={o.id}
              variant={answer === o.id ? "default" : "outline"}
              aria-pressed={answer === o.id}
              className="h-auto w-full justify-start whitespace-normal text-left"
              onClick={() => {
                setAnswer(o.id);
                setSubmitted(false);
              }}
            >
              {o.id}. {o.text}
            </Button>
          ))}
        {question.type === "truefalse" && (
          <div className="flex gap-2">
            {[
              { id: "T", text: "正确" },
              { id: "F", text: "错误" },
            ].map((o) => (
              <Button
                key={o.id}
                variant={answer === o.id ? "default" : "outline"}
                onClick={() => {
                  setAnswer(o.id);
                  setSubmitted(false);
                }}
              >
                {o.text}
              </Button>
            ))}
          </div>
        )}
        {["fill", "short", "calc"].includes(question.type) && (
          <Textarea
            aria-label={`${question.code} 作答`}
            value={answer}
            onChange={(e) => {
              setAnswer(e.target.value);
              setSubmitted(false);
            }}
            placeholder="写下你的答案；多空请用分号分隔"
          />
        )}
        <Button
          size="sm"
          disabled={!answer.trim()}
          onClick={() => setSubmitted(true)}
        >
          核对作答
        </Button>
        {submitted && (
          <div
            role="status"
            className="space-y-2 rounded-lg bg-muted p-4 text-sm"
          >
            <p className="font-medium">
              {result === null
                ? question.verified
                  ? "请结合参考答案自行核对"
                  : "此题答案待核对，暂不自动判分"
                : result
                  ? "回答正确"
                  : "再想一想"}
            </p>
            <Markdown
              text={`参考答案：${question.answer || "原文未提供，请在审核台补充。"}`}
            />
            {question.analysis && <Markdown text={question.analysis} />}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
