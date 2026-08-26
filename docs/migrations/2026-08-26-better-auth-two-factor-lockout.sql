-- Better Auth 1.6.22 为 TOTP / 备份码验证增加账户级失败计数与临时锁定。
-- 幂等：旧表补齐字段；已有行会把失败计数初始化为 0。

ALTER TABLE better_auth_two_factor
    ADD COLUMN IF NOT EXISTS failed_verification_count integer NOT NULL DEFAULT 0,
    ADD COLUMN IF NOT EXISTS locked_until timestamptz;
