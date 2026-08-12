-- pgvector。compose 的 db 镜像是 pgvector/pgvector:pg17，扩展文件已在镜像里；
-- 测试用的 PGlite 靠 @electric-sql/pglite-pgvector 装载（见 src/testing.ts）
CREATE EXTENSION IF NOT EXISTS vector;