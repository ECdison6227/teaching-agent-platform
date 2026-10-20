"use client";
import { useState } from "react";
import type { Figure } from "@/lib/cards";
import { appPath } from "@/lib/app-path";
import { Button } from "./ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogTrigger,
} from "./ui/dialog";
export function CourseFigure({
  figure,
  courseId,
  pageCount,
}: {
  figure: Figure;
  courseId: string;
  pageCount: number;
}) {
  const [open, setOpen] = useState(false);
  const pageNumbers = (
    figure.kind === "slides"
      ? figure.pages
      : figure.kind === "slide"
        ? [figure.page]
        : []
  ).filter((n) => n >= 1 && n <= pageCount);
  if (figure.kind !== "diagram" && !pageNumbers.length) return null;
  const title =
    figure.kind === "diagram"
      ? "学习示意图"
      : `课程页 ${pageNumbers.join("、")}`;
  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm" className="my-2">
          查看{title}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[90dvh] max-w-5xl overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {figure.caption || "结合课程内容理解，自动生成的示意图请核对。"}
          </DialogDescription>
        </DialogHeader>
        {figure.kind === "diagram" ? (
          <iframe
            title="学习示意图"
            sandbox=""
            referrerPolicy="no-referrer"
            className="h-[60vh] w-full"
            srcDoc={`<!doctype html><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:"><style>body{font-family:sans-serif;padding:16px}svg{max-width:100%}</style>${figure.html}`}
          />
        ) : (
          pageNumbers.map((p) => (
            <img
              key={p}
              src={appPath(`/api/courses/${courseId}/pages/${p}`)}
              alt={`课程第 ${p} 页`}
              className="w-full"
            />
          ))
        )}
      </DialogContent>
    </Dialog>
  );
}
