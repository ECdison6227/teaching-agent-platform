"use client";

import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import rehypeKatex from "rehype-katex";
import "katex/dist/katex.min.css";
import {
  prepareMathMarkdown,
  rehypeDemoteKatexErrors,
} from "@/lib/math-markdown";

/** 老师用 ==术语== 标出的重点，在句子里涂黄，不另起一行。公式走 KaTeX。 */
export function Markdown({
  text,
  className = "",
}: {
  text: string;
  className?: string;
}) {
  return (
    <div className={`md-body ${className}`}>
      <ReactMarkdown
        /**
         * singleTilde:false 关掉 GFM 的「单个波浪号」删除线。
         * 页码索引按「第 64~75 页」这种格式给模型，模型会照抄进正文；
         * 开着单波浪号时，「第17~46页…第47~63页」中间的正文会被整段划掉、
         * 两端波浪号也被吃掉。现在只有 ~~ 才会渲染删除线。
         */
        remarkPlugins={[remarkMath, [remarkGfm, { singleTilde: false }]]}
        rehypePlugins={[
          [rehypeKatex, { throwOnError: false, strict: false, output: "html" }],
          rehypeDemoteKatexErrors,
        ]}
        components={{
          a: ({ ...props }) => (
            <a {...props} target="_blank" rel="noreferrer" />
          ),
          strong: ({ children }) => <mark className="hl-key">{children}</mark>,
        }}
      >
        {prepareMathMarkdown(text)}
      </ReactMarkdown>
    </div>
  );
}
