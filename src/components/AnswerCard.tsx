"use client";
import { useState } from "react";
import type { Card as ChatCard, CardAnswer } from "@/lib/cards";
import { Button } from "./ui/button";
import { Card, CardHeader, CardTitle, CardContent } from "./ui/card";
import { Input } from "./ui/input";
import { Markdown } from "./Markdown";
import { CourseFigure } from "./CourseFigure";
export function AnswerCard({
  card,
  disabled,
  onSubmit,
  courseId,
  pageCount,
}: {
  card: ChatCard;
  disabled?: boolean;
  onSubmit: (answer: CardAnswer) => void;
  courseId: string;
  pageCount: number;
}) {
  const [choice, setChoice] = useState(""),
    [tf, setTf] = useState<boolean | null>(null),
    [values, setValues] = useState<Record<string, string>>({}),
    [hint, setHint] = useState(false);
  const ready =
    card.kind === "choice"
      ? !!choice
      : card.kind === "truefalse"
        ? tf !== null
        : card.fields.every((f) => values[f.key]?.trim());
  return (
    <Card className="my-4 bg-secondary/30 shadow-none">
      <CardHeader>
        <CardTitle className="text-sm">
          想一想 · {card.topic || "随堂练习"}
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        <Markdown text={card.prompt} />
        {card.kind === "choice" && (
          <div className="grid gap-2">
            {card.options.map((o) => (
              <Button
                key={o.id}
                aria-pressed={choice === o.id}
                variant={choice === o.id ? "default" : "outline"}
                disabled={disabled}
                className="h-auto justify-start whitespace-normal text-left"
                onClick={() => setChoice(o.id)}
              >
                {o.id}. {o.text}
              </Button>
            ))}
          </div>
        )}
        {card.kind === "truefalse" && (
          <div className="flex gap-2">
            {[true, false].map((v) => (
              <Button
                key={String(v)}
                variant={tf === v ? "default" : "outline"}
                aria-pressed={tf === v}
                disabled={disabled}
                onClick={() => setTf(v)}
              >
                {v ? "正确" : "错误"}
              </Button>
            ))}
          </div>
        )}
        {(card.kind === "data" || card.kind === "calc") &&
          card.fields.map((f) => (
            <label key={f.key} className="block space-y-1 text-sm">
              <span>
                {f.label} {f.unit}
              </span>
              <Input
                value={values[f.key] || ""}
                disabled={disabled}
                placeholder={f.placeholder}
                onChange={(e) =>
                  setValues((p) => ({ ...p, [f.key]: e.target.value }))
                }
              />
            </label>
          ))}
        {card.figure && (
          <CourseFigure
            figure={card.figure}
            courseId={courseId}
            pageCount={pageCount}
          />
        )}
        <div className="flex gap-2">
          <Button
            size="sm"
            disabled={disabled || !ready}
            onClick={() =>
              onSubmit(
                card.kind === "choice"
                  ? { kind: "choice", choiceId: choice }
                  : card.kind === "truefalse"
                    ? { kind: "truefalse", value: tf! }
                    : { kind: card.kind, values },
              )
            }
          >
            {disabled ? "已作答" : "提交作答"}
          </Button>
          {card.hint && (
            <Button variant="ghost" size="sm" onClick={() => setHint(!hint)}>
              查看提示
            </Button>
          )}
        </div>
        {hint && <Markdown text={card.hint || ""} />}
      </CardContent>
    </Card>
  );
}
