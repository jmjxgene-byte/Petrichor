import { createLocalUserWithBetterAuth, hasExistingSuperAdmin } from "../src/server/auth/better-auth-bridge"

function requireEnv(name: string) {
    const value = process.env[name]?.trim()
    if (!value) {
        throw new Error(`${name} 未设置`)
    }
    return value
}

try {
    const email = requireEnv("PETRICHOR_ADMIN_EMAIL").toLowerCase()
    const password = requireEnv("PETRICHOR_ADMIN_PASSWORD")
    const name = process.env.PETRICHOR_ADMIN_NAME?.trim() || email.split("@")[0] || "Admin"

    if (!email.includes("@")) {
        throw new Error("PETRICHOR_ADMIN_EMAIL 不是合法邮箱")
    }
    if (password.length < 12) {
        throw new Error("PETRICHOR_ADMIN_PASSWORD 至少需要 12 个字符")
    }
    if (await hasExistingSuperAdmin()) {
        throw new Error("系统中已存在超级管理员，已拒绝重复引导")
    }

    const user = await createLocalUserWithBetterAuth({
        email,
        password,
        name,
        systemRole: "SUPER_ADMIN",
    })
    console.log(`已创建超级管理员：${user.email}`)
} catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(`创建超级管理员失败：${message}\n`)
    process.exitCode = 1
}
