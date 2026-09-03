---
id: "20260903-hiba-web3-persistent-index"
title: "HiBA-AB Web3 持久化交易索引"
status: "completed"
owner: "none"
reviewer: "none"
priority: "high"
created_by: "codex"
created_at: "2026-09-03T14:22:02+08:00"
updated_at: "2026-09-03T14:39:36+08:00"
role_priority:
  implementation: "codex"
  review: "claude"
  tests: "claude"
  requirements: "user"
artifacts:
  - path: "hiba-core/packages/hiba-agent/src/tools/hiba.tools.ts"
    type: "patch"
  - path: "hiba-core/packages/hiba-agent/src/tools/FileProtectionIndex.ts"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/tools/FileProtectionIndex.test.ts"
    type: "test"
  - path: "hiba-core/packages/hiba-agent/src/tools/hiba.web3.e2e.test.ts"
    type: "test"
  - path: "hiba-core/packages/hiba-agent/.env.example"
    type: "file"
  - path: "hiba-core/packages/hiba-agent/src/tools/hiba.tools.test.ts"
    type: "test"
---

# Goal

將已驗證的 HiBA-AB、Java HiBA 與 Web3 串接回寫原始專案，並以 SQLite 持久保存 file hash 對應的交易與區塊資訊。

# Success Criteria

- `material.protectFile` 使用 Java 現有 multipart API 並確認實際鏈上交易。
- 交易索引在程序或資料庫連線重啟後仍可查詢。
- 索引隔離不同 chain ID 與 FileProtection 合約。
- 原始專案通過型別、回歸與 live Web3 E2E 測試。

# Current Context

- Java HiBA：`http://127.0.0.1:8092`。
- Web3 RPC：`http://127.0.0.1:8545`，chain ID `31337`。
- FileProtection：`0x5FbDB2315678afecb367f032d93F642f64180aa3`。
- SQLite 路徑由 `FILE_PROTECTION_INDEX_PATH` 設定，預設 `./data/file-protection-index.db`。

# Codex Notes

- Java metadata hash 為 SHA-256：依序輸入檔案內容、檔名、檔案大小、`SHA-256`、`8192`。
- 索引複合主鍵為 `(file_hash, chain_id, contract_address)`。
- 寫入欄位包含 `tx_hash`、`block_hash` 與 `protected_at`。
- 使用既有 `better-sqlite3`，沒有新增套件。

# Claude Notes

事後審查（使用者要求）發現 `findProtectionTransaction`（`hiba.tools.ts`）原本只用「呼叫前後區塊範圍內、`to == FileProtection 合約地址`」的第一筆交易反查 `tx_hash/block_hash`，沒有比對這筆交易是否真的帶有這次呼叫的 `fileHash`。若同一區塊範圍內有第二筆打去同一合約的交易（併發的 `material.protectFile` 呼叫、或任何人手動呼叫合約），會撈到別人的交易，把錯的 `tx_hash/block_hash` 寫進索引，且不會報錯——屬於違反「嚴禁靜默失敗」的靜默寫錯資料風險。

修正（不新增套件，延續 Codex 的既有原則）：
- Solidity 對 `string` 參數的 ABI 編碼是「32-byte 長度 + UTF-8 內容」；`fileHash` 固定 64 字元 hex（剛好 2 個 EVM word，無需 padding），其 hex 形式必定原樣出現在該次呼叫的 `tx.input` 裡。
- 新增 `fileHashCalldataMarker()`：把 `fileHash` 轉成 ASCII→hex 當作 calldata 特徵子字串。
- `findProtectionTransaction` 改為同時比對 `to == contract` 且 `input` 包含這個 marker，並 export 供測試使用；呼叫端 `material.protectFile` 同步傳入 `fileHash`。
- 新增 `hiba.tools.test.ts` 兩個測試：(1) 同區塊有 decoy 交易（`to` 對、`fileHash` 不對）+ 真正交易，須挑中真正那筆；(2) 區塊範圍內只有 decoy，須丟錯而非誤配。

# Review Findings

- 已確認原始目標檔案回寫前沒有使用者未提交修改。
- training 目錄既有未追蹤資料未被修改。
- 輸入的 file hash、chain ID、合約地址、交易及區塊 hash 均有格式驗證。
- （已修正，見上方 Claude Notes）`findProtectionTransaction` 原本僅以 `to` 位址反查交易，併發呼叫下可能誤配到別的交易；改為額外比對 calldata 是否帶有本次 `fileHash`。

# Test Plan

1. 執行 `npm.cmd run typecheck`。
2. 執行完整 `npm.cmd test`。
3. 設定 live E2E 環境變數後執行 `hiba.web3.e2e.test.ts`。
4. 確認 SQLite 使用不同連線仍能讀回交易，且不同 chain ID 不會誤命中。

## Test Results

- 原始專案 `npm.cmd run typecheck`：通過。
- 原始專案完整 Jest：17 suites passed、191 tests passed；1 個 live E2E 預設 skipped。
- 原始專案 live Java/Web3 E2E：1/1 passed。
- 最新交易：`0x014dbb6a8d13748c7ae986044104fa4c3a75a956f09fe8f7f4cbd42cf84fae76`。
- Block：7，block hash `0x3248fc6fdbdd48c70dc30e0a9c64854c080223602412888a89540da4762534e0`。
- Receipt 目的合約：`0x5FbDB2315678afecb367f032d93F642f64180aa3`。

### Claude 事後修正驗證

- `npm.cmd run typecheck`：通過。
- `npm.cmd test`：17 suites passed（+1 live E2E 預設 skipped）、**193 tests passed**（原 191 + 新增 2 個 `findProtectionTransaction` 測試），無回歸。

# Decisions

- Accepted：使用 SQLite 持久化取代 process-local Map。
- Accepted：索引鍵包含 chain ID 與合約地址，避免跨鏈誤配。
- Accepted：每次操作開關資料庫連線；只有量測出吞吐瓶頸時才改長連線。
- Accepted：live E2E 預設跳過，只有 `HIBA_WEB3_E2E=1` 時寫測試鏈。
- Accepted：`findProtectionTransaction` 以 calldata 內是否含有 `fileHash` 的 hex 特徵子字串來鎖定交易，取代單純比對 `to` 位址；不引入 ABI decode 套件。

# Session Summary

HiBA-AB 已能透過 Java multipart API 保護與驗證檔案，透過 Web3 RPC 找出實際交易，並以 SQLite 持久保存 file hash、chain、contract、transaction 與 block 對應。修改已回寫 `C:/Users/gslab/Desktop/files` 原始專案；原始專案 TypeScript、191 項回歸測試與 1 項 live Java/Web3 E2E 全部通過。

事後由使用者要求 Claude 審查，發現交易反查邏輯僅以 `to` 位址比對、併發下可能誤配的風險，已修正為額外比對 calldata 中的 `fileHash` 特徵值，並新增對應單元測試，`typecheck` 與 Jest（193 tests）全數通過。

# Open Questions

- 無。
