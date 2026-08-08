# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本檔案內容源自 `初始專案開發設定與管理/輔助開發文件`，為專案通用 AI 協作規範。

## 專案狀態

**骨架完成，進入 Phase 1：建立 RBAC 登入系統。**
前後端可獨立啟動並互通（`/health`）。資料模型決策見 `docs/schema/data-model-draft.md`（v2 決策版，含分階段與「暫定決策待覆核」清單）。
- **Phase 1（目前）**：`user` / `role` / `product` / `station` / `operator_station` + 登入 / JWT / 授權中介層。
- **Phase 2 起（暫緩）**：`batch` / `metric` / `measurement` / `alarm` / `attachment` 與儀表板、即時推播。
依 Data-First，僅實作已定案的 Phase 1 範圍。

## 專案背景與技術定義 (Project & Tech Stack)

- **專案名稱與目標**：岱暉製程可視化系統 —— 紙本電子化。三種使用者：產線 operator（~40 人，即時填入產線數據）、產線 manager（增查刪改 operator 資料、接收報警）、admin（查看任意數據、系統管理）。
- **主要程式語言**：TypeScript（前端）、Python（後端）
- **套件管理與環境**：`pnpm`（前端）、`uv`（後端）
- **核心框架與依賴**：React + Vite / FastAPI + SQLAlchemy + Alembic / PostgreSQL 16 / MinIO（影像物件儲存）/ docker-compose

## 架構總覽 (Architecture)

Monorepo，前後端分離：

- `backend/` — FastAPI。分層：`app/core`（設定）、`app/db`（engine/session/Base）、`app/models`（ORM）、`app/schemas`（Pydantic I/O，與 ORM 分離）、`app/api/routes`（路由）。`app/main.py` 為進入點，domain router 隨 schema 確認逐一掛入。
- `frontend/` — React + TS + Vite。`src/api/client.ts` 為唯一 API 層；`src/pages`、`src/components` 依 `docs/ui-reference/` 的視覺參考建置。
- **影像**存 MinIO，PostgreSQL 只存 metadata + 物件 key（見 `attachment` 實體）。
- **即時性**：operator 即時上傳、manager 報警推播規劃走 WebSocket（尚未實作）。
- `docs/schema/` 為 Data-First 的單一事實來源 —— 改資料模型先改這裡並取得確認。

## 常用指令 (Commands)

```bash
# 全部服務（推薦）
cp .env.example .env && docker compose up --build

# 後端 (cd backend)
uv sync
uv run alembic upgrade head                # 套用資料庫遷移
uv run python -m app.seed                  # seed admin + 產品（讀 .env）
uv run uvicorn app.main:app --reload      # 開發伺服器
uv run pytest                             # 全部測試（sqlite 記憶體，免 DB）
uv run pytest tests/test_auth.py::test_login_success_flags_forced_change  # 單一測試
uv run ruff check .                        # lint
uv run alembic revision --autogenerate -m "msg"   # 產生新遷移

# 前端 (cd frontend；先 corepack enable 啟用 pnpm)
pnpm install
pnpm dev            # 開發伺服器 :5173
pnpm typecheck      # tsc 型別檢查
pnpm build          # 正式建置
```

## 核心協作原則 (Core Collaboration Principles)

- **溝通與輸出風格**：回覆簡潔有力。以「引導思考」為主、「直接給答案」為輔；確認整體思考過程與邏輯正確後，再給出最終程式碼或答案。
- **需求釐清邊界**：遇到模糊、缺乏上下文或有潛在矛盾的要求時，**絕對不要自行腦補或猜測**。先主動提問，取得具體明確的要求後，再實作。
- **嚴格的程式碼審查**：Code Review 或重構時採最嚴格標準。明確指出效能瓶頸、狀態管理風險或架構缺陷，並給出具體修改建議與替代方案。
- **卡關與除錯機制**：除錯過程若經 **三次對答** 仍未找到解法，立即停止盲目試錯。退一步條列目前的「思考過程與假設」，待確認邏輯盲區後再繼續。

## 架構與實作守則 (Architecture & Implementation Rules)

- **Data-First（資料結構優先）**：實作任何業務邏輯前，先確認關聯式資料庫 Schema、API 介面或資料模型（Data Model）已定義完整。
- **單一職責與解耦**：確保模組獨立性。前端元件或後端服務都避免將與業務無關的邏輯硬編碼在核心模組中。
- **防禦性設計 (Defensive Programming)**：驗證所有外部輸入與邊界條件。遇非預期錯誤時優雅處理（Graceful Degradation），提供有意義的日誌或錯誤訊息，**嚴禁靜默失敗（Silent Failures）**。
- **型別優先**：TypeScript 不得以 `any` 蒙混通過。
- **資料流清楚**：UI state、domain state、derived state 分開管理。
- **錯誤處理一致**：UI 顯示、fallback、empty state 樣式須統一。

## 安全基準線 (Security Baseline)

2026-07-11 全專案漏洞掃描後補上，往後改動需維持：

- **登入防暴力破解**：`/auth/login` 依 username 做 5 次/15 分鐘鎖定（`app/api/routes/auth.py`，process-local in-memory）。僅單一 worker 部署有效；若改多 worker/多實例部署，需換成共享儲存（如 Redis）才能生效。
- **安全標頭**：後端 `app/main.py` middleware 與前端 `frontend/nginx.conf` 皆加了 `X-Content-Type-Options: nosniff`、`X-Frame-Options: DENY`、`Referrer-Policy: same-origin`。新增回應路徑（如檔案下載）時留意是否需要額外標頭。
- **Secrets 規範**：`.env` 已由 `.gitignore` 排除、禁止進版控。`JWT_SECRET` 需 ≥32 字元隨機值（`openssl rand -hex 32`）；短於此長度時後端啟動會記 warning log，但不會擋啟動（保留本機開發用預設值可跑）。**正式或任何非本機部署前，務必更換** `.env.example` 中所有 `change_me*` 預留值（`JWT_SECRET`／`POSTGRES_PASSWORD`／`MINIO_ROOT_PASSWORD`／`ADMIN_PASSWORD`）。
- **密碼原則**：現行僅檢查長度 >8 碼（`app/core/passwords.py`），無複雜度規則；首次登入強制改密碼（`must_change_password`）已覆蓋 seed 帳號外洩風險。若要加複雜度規則，屬政策調整，先與使用者確認再動手。
- **已知設計取捨（非疏漏，勿重複回報）**：JWT 為 stateless bearer token，無 revoke/blacklist（8 小時到期即失效）；前端 token 存 `localStorage`（目前程式碼無 `dangerouslySetInnerHTML`/`eval` 等 XSS 注入面，風險低但屬架構取捨，非本次掃描範圍）。

## 功能開發分支流程 (Feature Branch Workflow)

**每次開發「新功能」時，必須遵守：**

1. **開專屬分支**：為該功能開一個新的 git 分支處理（如 `feature/<name>`），不直接在 `main` 上開發。
2. **完整開發並留下記錄**：功能完成需包含 —— 開發內容記錄、目的、測試方式與結果記錄（寫入 commit / mailbox thread / docs）。
3. **提醒重置聊天**：功能**完整開發完成後**，主動提醒使用者使用 `/clear` 指令重製此聊天，再開始下一個功能。
4. **commit**：每次上傳git時，撰寫commit需要遵守**約定式提交**的格式內容，且不可加入emoji、icon等圖示，以純文字描述

## 開發與驗證流程 (Workflow & Validation)

開發新功能時依循 L2 規格驅動流程：

1. **規格對齊**：讀取對應的 PRD、Schema 或需求 Markdown。規格不完整時觸發「需求釐清」原則。
2. **計畫擬定**：撰寫程式碼前，先列出實作步驟（Step-by-step Plan）與預計修改的檔案清單。
3. **程式碼生成**：依計畫生成，符合本文件的技術定義與架構守則。
4. **測試與驗證**：為核心邏輯產出對應單元測試（Unit Test）或測試情境描述，確保行為與規格一致。

執行守則：
- **一次只做一件事**：一個 PR / commit 只解一個 bug 或一個 feature。
- **最小改動**：既有專案禁止大重構（除非使用者明確同意）。
- **每次改動可驗證**：提供 lint / typecheck / 測試或手動驗證清單。
- **新增功能拆元件**：頁面 component 過長時抽出共用元件。
- **輸出格式固定**：先給變更摘要 → 再給檔案清單 → 最後給驗證方式。

## 任務指派格式 (Prompt Format)

指派任務時建議依此結構描述：

- **Context**：任務背景是什麼
- **Request**：希望完成什麼事
- **Output Format**：結果以什麼形式交付
- **Constraints**：有哪些限制、不能假設或越界的地方
- **Checkpoint**：什麼情況下需停下來詢問使用者

## Clean Code 準則

程式碼檢查與重構時對照：

- **命名**：有意義且可搜尋；類別用名詞、方法用動詞；避免誤導性命名。
- **函數**：簡短（理想 < 20 行）、只做一件事、單一抽象層級、參數不超過 3 個、避免副作用。
- **註解**：以程式碼自我說明取代註解；註解無法彌補糟糕程式碼。
- **錯誤處理**：用 Exception 而非錯誤碼；不回傳或傳遞 null；錯誤處理與業務邏輯分離。
- **邊界**：以包裝類別封裝第三方程式碼，避免外部程式碼污染內部。
- **單元測試**：遵循 FIRST（Fast、Independent、Repeatable、Self-validating、Timely）；每個測試一個概念。
- **類別**：簡短、單一職責、高內聚低耦合、對擴展開放對修改封閉。
- **重構**：童軍規則——讓程式碼比接手時更乾淨；小步重構配合測試保護。
