-- Expand-only：保留已有问答开关、个人介绍与许可文件；空配置不展示个人联系方式。
ALTER TABLE public.petrichor_site_appearance
    ADD COLUMN IF NOT EXISTS branding_json text NOT NULL DEFAULT '{}';
