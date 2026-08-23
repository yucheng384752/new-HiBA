# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

> 本檔案內容源自 `初始專案開發設定與管理/輔助開發文件`，為專案通用 AI 協作規範。

## 專案狀態

開發中。目前分支 `fix/scripts-tab-drawer-schema-compat` 聚焦於 Claw Dashboard 的任務鏈（Workflow）UI 重構（拖曳式節點編排、缺漏欄位提示、LLM 執行結果摘要）與 OrchestratorRunner 的節點斷線重連 / failover 邏輯。上一版已合併：`orchestrator.deployServer` 更名為 `orchestrator.updateSubWebRuntime`（語意修正：僅本機安裝/更新，非跨節點 SSH 部署）。

## 專案背景與技術定義 (Project & Tech Stack)

HiBA-AB：工廠產線 Agent 任務編排系統（研究專案，見 `HiBA-AB_研究構想說明書*.md`）。核心概念是讓 LLM 將自然語言任務轉譯為可驗證的 ExecutionPlan，再由 Orchestrator 分派到本機或遠端 Raspberry Pi 節點執行 Python 工具腳本，並將每一步寫入稽核鏈（AuditTrail）。

技術棧：
- **hiba-agent（伺服器端）**：TypeScript（CommonJS）+ Node.js 原生 `http`（無 Express）、Zod 做 schema 驗證與型別推導、better-sqlite3 做稽核／信任登錄／工作流持久化、Jest + ts-jest 測試。
- **Pi 節點端（scripts_pi/deploy_http）**：Node.js + Express.js（`sub_web_server.js`）、Python 3 工具腳本、better-sqlite3 稽核落地、TPM/swtpm 做硬體信任（選用）。
- **Dashboard（scripts_pi/claw-dashboard.html）**：純 HTML/CSS/Vanilla JS 單檔案，無建置流程，直接以瀏覽器開啟。
- **模型訓練（hiba-core/training）**：Python，LoRA 微調 pipeline，輸出 GGUF／Ollama Modelfile 供本機 LLM（`hiba-planner`）使用。

## 架構總覽 (Architecture)

> 本 repo（HiBA-AB）是在 `C:\Users\gslab\Desktop\hiba`（Java HiBA 正式版：Broker 拓樸、TPM 簽章、區塊鏈檔案完整性）**的基礎上**，加入 **LLM 智慧任務分派**與**統一 Dashboard 整合**的擴充層，細節見文末「HiBA程式碼核心」小節。

```
Claw Dashboard (claw-dashboard.html)
        │  NL 任務 / 手動操作
        ▼
hiba-agent AgentServer (HTTP API)
  ├─ NLPlanningService  ── 呼叫 LLM 產生 ExecutionPlan / 執行結果摘要
  ├─ OrchestratorRunner ── 拓樸排序 → 逐層派工，含逾時重連與跨節點 failover
  │      ├─ local  → HiBAToolbox（本機 ToolRegistry）
  │      └─ remote → Pi 節點 /api/execute（或相容 /execute，見 piCompatDispatch）
  ├─ WorkflowStore      ── 持久化工作流：planned → approved → run
  ├─ AuditTrail (SQLite)── 每一步事件記錄 + 區塊鏈錨定（batchUploadToChain）
  └─ TrustRegistry       ── 節點信任登錄

Accounting Server (hiba-core/tools/accounting-server.mjs)
  └─ 維護線上節點清單 / 各節點可執行工具清單，供 Orchestrator 動態探索節點與 Dashboard 顯示

Raspberry Pi Sub-Web 節點 (scripts_pi/deploy_http)
  └─ sub_web_server.js 暴露 /execute /health /scripts /deploy /cmd，執行 manifest.json 登錄的 Python 腳本
```

`hiba.tools.ts`（TS 端工具定義／Zod schema）與 `manifest.json`（Pi 節點端工具登錄，root 與 `deploy_http/scripts/` 各一份，需同步）必須保持 I/O 契約一致，這是 Data-First 原則在本專案的具體落地。

## 常用指令 (Commands)

```bash
# hiba-core（根套件）
cd hiba-core
npm run typecheck        # tsc --noEmit
npm test                 # node --test（hiba.toolbox / hiba.audit.sqlite）
npm run accounting       # 啟動 Accounting Server（預設 :9090）
npm run tools:check      # 檢查工具 manifest 是否同步

# hiba-agent（Orchestrator / AgentServer）
cd hiba-core/packages/hiba-agent
npm run start:env        # 讀取 .env 啟動（預設 :8090）
npm test                 # jest --runInBand
npm run typecheck

# Raspberry Pi 節點（首次安裝）
sudo bash scripts_pi/deploy_http/00_setup.sh [NODE_ID] [CLAW_URL]
curl http://localhost:3000/health

# Dashboard
# 直接以瀏覽器開啟 scripts_pi/claw-dashboard.html（無需建置）
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

- **機密不入庫**：密碼、API Key、Token 一律不寫入版本控制。只有 `.env.example`（佔位值）可提交，真實 `.env` 必須被 `.gitignore` 排除。
- **舊有機密需主動清理**：若機密已被 git 追蹤，加入 `.gitignore` 不會使其停止被追蹤，須另外 `git rm --cached` 並視情況輪替該機密（見下方審查發現）。
- **外部輸入一律驗證**：Pi 節點回傳、LLM 產出的 JSON、使用者輸入，都必須經 Zod schema 驗證（`validateRemoteResult` / `executionPlanSchema` 等），不得信任未經驗證的資料結構。
- **DOM 輸出必須逃逸**：Dashboard 任何插入 DOM 的動態內容（腳本輸出、LLM 摘要、錯誤訊息）需呼叫 `escapeHtml()`，避免反射型 XSS。
- **shell 權限最小化**：`.claude/settings.local.json` 的 Bash allowlist 應避免大範圍萬用字元（如 `ssh *`）與讀取 SSH 私鑰目錄，需要時應限定到具體 host / 具體指令。
- **TPM／簽章金鑰不入庫**：`ek_fingerprint.txt` 等節點信任金鑰檔案僅存在於節點本機 `/opt/hiba/tpm/`，不得提交。

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


## obsidian 筆記位址
- C:\Users\gslab\Desktop\HiBA-AB-Vault\HiBA-AB-Vault，所有相關紀錄，或是關鍵字可寫入此份筆記內

## HiBA程式碼核心
- C:\Users\gslab\Desktop\hiba(尚未在本機完成區塊鏈相關內容整合)

### 深度掃描摘要（2026-08-23）

獨立 git repo（`git@github.com:socomni/hiba.git`，目前在 `dev` 分支），與本 repo 技術棧完全不同，關係待確認（見下方「待確認」）——以下先如實記錄掃描結果：

- **技術棧**：Java 21 + Netty（自定義二進位協定）+ Web3j（Ethereum 客戶端）+ Solidity（智慧合約）+ Ansible（部署）+ Maven（多模組：`hiba-common` / `hiba-core` / `hiba-service-ntp`，parent artifact `com.socomni:hiba-management`）
- **核心概念**：階層式 Broker 架構（Hierarchical Broker Architecture）。節點間以 Netty 自定義二進位協定（Magic `GSLAB` + Header 16 bytes）通訊，任務走 Taker → Distributor → Executor 流水線；每則訊息經 TPM 硬體簽章、接收端做四階段驗證（Timestamp → Nonce 防重放 → TPM 簽章 → 區塊鏈公鑰比對）
- **區塊鏈整合**：
  - `hiba-core/contract/FileMetadataContract.sol`（檔案 metadata 上鏈）、`TPMDeviceRegistry.sol`（TPM 裝置 PKI，Owner/Admin RBAC）
  - Java 服務層以 `BlockchainService` 介面切換 `Web3jBlockchainServiceImpl`（正式上鏈）/ `MockBlockchainServiceImpl`（測試用 In-Memory）
  - **已核實「尚未整合」**：本機 `hiba-core/env.json` 的 `BlockchainFileProtect.contractAddress`、`.privateKey`、`BlockchainTPMRegistry.contractAddress`、`.privateKey` 目前均為空字串——合約尚未部署／憑證尚未填入，即便 `HiBANetwork.BlockchainFileProtect` 開關已經是 `true`。可用 Anvil 本地鏈（`http://192.168.1.60:8545`，networkID 31337）或 Sepolia 補齊
- **測試環境**：11 台 PVE VM（1 台 accounting-server + 10 台 worker node），透過固定 port-forwarding 規則從 `163.18.49.35`（各節點對應不同 port，如 30122/30322…）SSH 進入——`.claude/settings.local.json` 裡的 ssh alias 就是連到這批節點裡的其中一台
- **部署方式**：`make package` → `make ansible-deploy [HOST=<node> | HOSTS='<node1> <node2>']`，走 `ansible/` 下的 playbook，遠端目標路徑 `/home/user/HiBA/`
- **文件完整度高，已抽查與原始碼一致**：`docs/HANDOVER.md`（交接文件：架構圖、模組表、測試分類、FAQ）、`docs/BLOCKCHAIN.md`（合約設計、Java 服務分層、設計模式）、`docs/NETTY_PIPELINE.md`（Pipeline 設計、GSLAB 協定格式）——已核對 `hiba-core/src/main/java/org/gslab/` 套件目錄（configuration / fileProtection / handlers / mService / sdns / tpm 等）與文件描述相符

### 與本 repo 的關係（已確認）
本 repo（HiBA-AB）是在 `C:\Users\gslab\Desktop\hiba`（Java HiBA 正式版：Broker、TPM 簽章、區塊鏈檔案完整性）**的基礎上**，加入 **LLM 智慧任務分派**與**統一 Dashboard 整合**的擴充層：
- Java HiBA 提供底層 Broker 拓樸、節點間 Netty 通訊、TPM 硬體信任鏈、區塊鏈完整性驗證
- 本 repo 的 `hiba-agent`（NLPlanningService + OrchestratorRunner）在其上疊加「自然語言 → ExecutionPlan → 派工」的智慧層，`claw-dashboard.html` 則是操作員的統一操作介面
- 兩邊目前技術棧不同（Java Netty node vs. 本 repo 的 Pi HTTP sub-web node），實際整合程度／介接點仍待後續開發釐清，但方向已確定為上述擴充關係

### 節點網路範圍
執行 node 的目標機器分兩批，兩者都是有效派工對象：
- `192.168.x.x`（如 `192.168.200.23`、`192.168.50.x`）：**本機／區網 VM**，在 gslab 這台 PC 所在的區網內
- `163.18.x.x`（如 `163.18.49.35`，走 port-forwarding 到各 VM）：**其他實體機器上的 VM**，對應 `Desktop\hiba` 文件裡 PVE 平台的 11 台測試節點

`.claude/settings.local.json` 目前只收斂到 `192.168.200.23`；若之後要透過 Claude 操作 `163.18.x` 這批節點，需要再另外新增對應的 ssh 權限。
