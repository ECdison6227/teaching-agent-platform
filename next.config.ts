import type { NextConfig } from "next";
const config: NextConfig = {
  basePath: (process.env.NEXT_PUBLIC_BASE_PATH || "").replace(/\/+$/, ""),
  serverExternalPackages: ["better-sqlite3"],
  experimental: { cpus: 2 },
};
export default config;
