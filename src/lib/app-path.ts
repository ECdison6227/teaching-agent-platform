export const BASE_PATH = (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(
  /\/+$/,
  "",
);

/** 浏览器请求与 public 资源都使用同一前缀；已带前缀的地址不重复追加。 */
export function withBasePath(path: string, basePath: string): string {
  if (!path.startsWith("/") || path.startsWith("//"))
    throw new Error("应用资源必须使用站内路径");
  const prefix = basePath.replace(/\/+$/, "");
  if (
    !prefix ||
    path === prefix ||
    path.startsWith(prefix + "/") ||
    path.startsWith(prefix + "?") ||
    path.startsWith(prefix + "#")
  )
    return path;
  return prefix + path;
}

export function appPath(path: string): string {
  return withBasePath(path, BASE_PATH);
}
