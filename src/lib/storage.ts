import { mkdirSync } from "node:fs";
import path from "node:path";

export function dataDir() {
  return path.resolve(process.env.DATA_DIR || "./data");
}
export function storagePath(key: string) {
  const root = dataDir();
  const target = path.resolve(root, key);
  if (!key || key.includes("\\") || !target.startsWith(root + path.sep))
    throw new Error("非法文件路径");
  return target;
}
export function courseDir(courseId: string) {
  if (!/^[a-zA-Z0-9_-]+$/.test(courseId)) throw new Error("非法课程 ID");
  const dir = storagePath(`courses/${courseId}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 导出到模型与页面的文本做最小联系信息过滤；原文件保留供用户下载。 */
export function redactPII(text: string) {
  return text
    .replace(/(?:\+?86[- ]?)?1[3-9]\d{9}/g, "[联系方式已隐藏]")
    .replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, "[邮箱已隐藏]")
    .replace(
      /(?:主讲教师|任课教师|授课教师|联系电话|手机|电话)\s*[:：]\s*[^\n\r]+/g,
      "[个人信息已隐藏]",
    );
}
