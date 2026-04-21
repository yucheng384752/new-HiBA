-- ============================================================
-- AuditTrail SQLite Schema
-- 對應 HiBA-AB 部署架構決策：AuditTrail 本地儲存（SQLite）
-- 位置：Sub-Web Pi 端，每個節點各自一份
-- ============================================================

PRAGMA journal_mode = WAL;   -- 支援多讀一寫，減少鎖競爭
PRAGMA foreign_keys = ON;

-- ── 主稽核日誌表 ─────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS tool_audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 追蹤鏈（對應 X-Trace-Id / X-Agent-Id / X-Depth headers）
    trace_id      TEXT    NOT NULL,   -- {taskId}-{stepId}
    agent_id      TEXT    NOT NULL,   -- 呼叫此腳本的 Agent ID
    depth         INTEGER DEFAULT 0, -- 委派深度，對應 T1 定理

    -- Tool 身份（對應 manifest.json 欄位）
    tool_name     TEXT    NOT NULL,   -- 正式命名 {domain}.{verbObject}，如 machine.queryStatus
    tool_domain   TEXT    NOT NULL,   -- 域分類：machine / env / material / method / man / orchestrator
    script_name   TEXT    NOT NULL,   -- 實際 .py 檔名，如 script_2
    version       TEXT    DEFAULT '1.0.0',

    -- 執行結果
    success       INTEGER NOT NULL,   -- 1=成功 / 0=失敗
    duration_ms   INTEGER,            -- 執行耗時（毫秒）
    executed_at   TEXT    NOT NULL,   -- ISO 8601，如 2026-04-16T10:00:00Z
    error_msg     TEXT,               -- 失敗時的錯誤訊息，成功時為 NULL

    -- Phase 欄位（用於 fileio 等多階段腳本）
    phase         TEXT,               -- probe / write / full / NULL

    -- 稽核雜湊（AuditProof，供選擇性上鏈）
    audit_hash    TEXT                -- SHA-256(traceId + toolName + executedAt + success)
);

-- 查詢效能索引
CREATE INDEX IF NOT EXISTS idx_audit_trace_id    ON tool_audit_log (trace_id);
CREATE INDEX IF NOT EXISTS idx_audit_tool_name   ON tool_audit_log (tool_name);
CREATE INDEX IF NOT EXISTS idx_audit_executed_at ON tool_audit_log (executed_at);
CREATE INDEX IF NOT EXISTS idx_audit_agent_id    ON tool_audit_log (agent_id);

-- ── Accounting 計費彙整 View ──────────────────────────────────
-- 對應部署架構決策：Accounting Server 所需欄位
-- toolName + version + agentId + timestamp + executionDuration
CREATE VIEW IF NOT EXISTS v_accounting AS
SELECT
    tool_name     AS toolName,
    version,
    agent_id      AS agentId,
    tool_domain   AS domain,
    executed_at   AS timestamp,
    duration_ms   AS executionDuration,
    success
FROM tool_audit_log;

-- ── 健康統計 View ─────────────────────────────────────────────
CREATE VIEW IF NOT EXISTS v_tool_stats AS
SELECT
    tool_name,
    tool_domain,
    COUNT(*)                                        AS totalCalls,
    SUM(success)                                    AS successCount,
    COUNT(*) - SUM(success)                         AS failureCount,
    ROUND(AVG(duration_ms), 1)                      AS avgDurationMs,
    MAX(executed_at)                                AS lastExecutedAt
FROM tool_audit_log
GROUP BY tool_name, tool_domain;
