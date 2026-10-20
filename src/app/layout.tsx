import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "学伴 · 通用教学 Agent",
  description: "把课程资料变成可对话、可自学的学习空间",
};
export default function RootLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
