import path from "node:path"
import "./apps/web/src/server/db/sqlite-runtime"
import { createBunApp } from "./apps/web/src/server/bun/app"

// Vercel 的文件追踪无法识别 db/client.ts 内 createRequire 的惰性子路径。
// Bun 入口先加载运行时锚点，让 Preview 的认证模块初始化前就拿到 SQLite 驱动。

const port = Number(process.env.PORT ?? 3000)
const hostname = process.env.HOST ?? "0.0.0.0"

const server = Bun.serve({
    port,
    hostname,
    idleTimeout: 255,
    fetch: createBunApp({
        staticDirectory: path.join(import.meta.dir, "apps/web/dist"),
        developmentAssetsUrl: process.env.PETRICHOR_VITE_DEV_SERVER_URL,
    }),
})

console.log(`Petrichor Bun server: ${server.url}`)
