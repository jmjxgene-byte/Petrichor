import { describe, expect, it } from "vitest"
import { loadServerConfigFromEnv } from "./server"

describe("loadServerConfigFromEnv", () => {
    const requiredSecrets = {
        PETRICHOR_ENCRYPT_KEY: "k".repeat(32),
        PETRICHOR_ENCRYPT_SALT: "0123456789abcdef",
    }

    it("服务端运行要求数据库、Session 和稳定加密密钥", () => {
        const config = loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            SESSION_SECRET: "x".repeat(32),
            ...requiredSecrets,
        })

        expect(config.databaseUrl).toBe("postgres://user:pass@example.supabase.co:5432/postgres")
        expect(config.databaseMaxConnections).toBe(1)
        expect(config.s3).toBeNull()
        expect(config.session.expiresInSeconds).toBe(60 * 60 * 24 * 2)
        expect(config.registration.mode).toBe("disabled")
        expect(config.deepResearch).toEqual({
            enabled: false,
            autoStart: false,
            workerEnabled: false,
            hybridEnabled: false,
            wikiEnabled: false,
            graphV2Enabled: false,
        })
        expect(config.apiEncryption.salt).toBe("0123456789abcdef")
    })

    it("读取 Session 与 S3 配置", () => {
        const config = loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            ...requiredSecrets,
            PETRICHOR_SESSION_EXPIRE_SECONDS: "604800",
            SESSION_SECRET: "x".repeat(32),
            S3_ACCESS_KEY_ID: "ak",
            S3_BUCKET: "bucket",
            S3_DOWNLOAD_EXPIRE_SECONDS: "600",
            S3_ENDPOINT: "s3.example.com",
            S3_REGION: "cn-east-1",
            S3_SECRET_ACCESS_KEY: "sk",
            S3_UPLOAD_EXPIRE_SECONDS: "300",
            S3_USE_SSL: "false",
        })

        expect(config.session.expiresInSeconds).toBe(604800)
        expect(config.s3).toEqual({
            accessKeyId: "ak",
            bucket: "bucket",
            downloadExpireSeconds: 600,
            endpoint: "http://s3.example.com",
            region: "cn-east-1",
            secretAccessKey: "sk",
            uploadExpireSeconds: 300,
        })
    })

    it("拒绝非法会话有效期", () => {
        expect(() =>
            loadServerConfigFromEnv({
                DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
                ...requiredSecrets,
                PETRICHOR_SESSION_EXPIRE_SECONDS: "0",
                SESSION_SECRET: "x".repeat(32),
            }),
        ).toThrow("PETRICHOR_SESSION_EXPIRE_SECONDS")
    })

    it("读取并校验数据库连接池上限", () => {
        const config = loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            PETRICHOR_DB_MAX_CONNECTIONS: "5",
            SESSION_SECRET: "x".repeat(32),
            ...requiredSecrets,
        })
        expect(config.databaseMaxConnections).toBe(5)

        expect(() => loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            PETRICHOR_DB_MAX_CONNECTIONS: "0",
            SESSION_SECRET: "x".repeat(32),
            ...requiredSecrets,
        })).toThrow("PETRICHOR_DB_MAX_CONNECTIONS")
    })

    it("拒绝缺失或非法的凭证加密配置", () => {
        expect(() => loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            SESSION_SECRET: "x".repeat(32),
        })).toThrow("PETRICHOR_ENCRYPT_KEY")

        expect(() => loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            SESSION_SECRET: "x".repeat(32),
            PETRICHOR_ENCRYPT_KEY: "k".repeat(32),
            PETRICHOR_ENCRYPT_SALT: "not-hex",
        })).toThrow("PETRICHOR_ENCRYPT_SALT")
    })

    it("注册模式默认关闭且只接受显式开放", () => {
        expect(loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            SESSION_SECRET: "x".repeat(32),
            ...requiredSecrets,
            PETRICHOR_REGISTRATION_MODE: " open ",
        }).registration.mode).toBe("open")

        expect(() => loadServerConfigFromEnv({
            DATABASE_URL: "postgres://user:pass@example.supabase.co:5432/postgres",
            SESSION_SECRET: "x".repeat(32),
            ...requiredSecrets,
            PETRICHOR_REGISTRATION_MODE: "bootstrap",
        })).toThrow("PETRICHOR_REGISTRATION_MODE")
    })

    it("Vercel Preview 强制使用隔离 SQLite 且不继承生产外部凭据", () => {
        const config = loadServerConfigFromEnv({
            VERCEL: "1",
            VERCEL_ENV: "preview",
            DATABASE_URL: "postgres://production.example/postgres",
            SESSION_SECRET: "production-session-secret".repeat(2),
            ...requiredSecrets,
            PETRICHOR_REGISTRATION_MODE: "open",
            PETRICHOR_GENEOPS_CONNECTOR_ENABLED: "true",
            CRON_SECRET: "production-cron-secret",
            S3_ENDPOINT: "https://s3.example.com",
            S3_BUCKET: "production-bucket",
            S3_ACCESS_KEY_ID: "production-access-key",
            S3_SECRET_ACCESS_KEY: "production-secret-key",
        })

        expect(config.databaseUrl).toBe("file:/tmp/petrichor-preview.sqlite")
        expect(config.localStorageDir).toBe("/tmp/petrichor-preview-storage")
        expect(config.registration.mode).toBe("disabled")
        expect(config.geneOpsConnector).toEqual({ enabled: false, cronSecret: null })
        expect(config.deepResearch).toEqual({
            enabled: false,
            autoStart: false,
            workerEnabled: false,
            hybridEnabled: false,
            wikiEnabled: false,
            graphV2Enabled: false,
        })
        expect(config.s3).toBeNull()
        expect(config.sessionSecret).not.toContain("production")
        expect(config.apiEncryption.key).not.toBe(requiredSecrets.PETRICHOR_ENCRYPT_KEY)
    })
})
