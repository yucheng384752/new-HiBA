# 場域拓樸檔案（facilities/）

每個 `<facilityId>.json` 描述一個「場域」（產線/site）完整的產線生產過程——站點（stations）
與站點間的關係（edges），不是點對點邊的攤平集合。由 `hiba-core/tools/accounting-server.mjs`
在啟動/請求時讀取（見該檔案的 `/api/facilities*` 端點），型別定義在
`hiba-core/packages/hiba-agent/src/topology/FacilityTopology.types.ts`。

## 這些檔案是真實來源

人工編輯、git 追蹤。accounting-server.mjs 不會自己「發明」場域——它只讀取這個目錄底下
存在的 `.json` 檔案，檔案本身就是登錄表，沒有另一份需要保持同步的索引檔（避免重蹈這個
repo 稍早清理過的「根目錄複本 vs 實際使用版本各自漂移」的覆轍）。

## `facilityId` 規則

必須符合 `^[a-z0-9][a-z0-9_-]{0,63}$`，且必須等於檔名（不含 `.json`）。
`POST /api/facilities` 建立新場域時會驗證這個規則，格式不符回 400，`facilityId` 已存在回 409。

## Schema

```jsonc
{
  "schemaVersion": 1,
  "facilityId": "line-A",
  "name": "產線 A 顯示名稱",
  "processDescription": "整體產線生產過程的自由文字敘述",
  "stations": [
    {
      "stationId": "cut",             // 場域內唯一
      "name": "切割站",
      "nodeId": "node-1",             // 綁定 accounting-server 節點登錄；非自動化站點可為 null
      "description": "站點作業描述",
      "metadata": {}
    }
  ],
  "edges": [
    {
      "fromStationId": "cut",
      "relation": "upstream_of",      // upstream_of | downstream_of | backup_for | same_line
      "toStationId": "cnc",
      "lineId": "line-A",             // 選填，供多產線交錯的場域分類用
      "status": "approved",           // suggested | approved
      "source": "manual",             // manual | audit_trail_inference
      "metadata": {},
      "updatedAt": "2026-08-31T00:00:00.000Z"
    }
  ],
  "updatedAt": "2026-08-31T00:00:00.000Z"
}
```

邊的識別鍵是 `(fromStationId, relation, toStationId)` 三元組。

## 人工維護 vs AuditTrail 自動偵測

- **人工新增**（`POST /api/facilities/:id/edges`）：`source: 'manual'`，立即 `status: 'approved'`，
  解決冷啟動問題——新場域上線當下就能有拓樸資料。
- **AuditTrail 自動偵測**（`TopologySequenceDetector`，`POST /api/facilities/:id/edges/suggest`）：
  `source: 'audit_trail_inference'`，寫入 `status: 'suggested'`，不自動生效。已經是 `approved`
  的邊不會被自動偵測降級回 `suggested`。
- 需要人工在 Dashboard「產線拓樸」分頁核准（`POST /api/facilities/:id/edges/approve`），
  待審核的邊才會出現在 `orchestrator.retrieveContext` 讀到的結果裡
  （只讀 `status=approved`）。

## 沒有 delete 端點

這些是要給人直接編輯、git 追蹤的檔案——要刪除一個站點或整個場域，直接編輯或刪除對應的
`.json` 檔案即可，不需要（也刻意不提供）API 層級的刪除功能。

## 冷啟動注意事項

`TopologySequenceDetector`（AuditTrail 自動偵測）只能在「兩個 nodeId 都已經是某個場域的
station」時才能歸屬出一條建議邊——場域跟站點要先有人工登記，自動偵測才有東西可以掛，
不會無中生有出一個新場域。
