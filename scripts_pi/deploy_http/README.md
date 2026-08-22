# deploy_http — HTTP Sub-Web 節點部署說明書

> Manifest 最新規範版本：Tool `1.0.0` / metadata schema `1.0`。兩者獨立版控；只更新說明或摘要 metadata 不得提升 Tool 執行版本。每個腳本必須提供 `description`、`inputSchema`、`outputSchema` 與 `summaryHints`；Node 的 `/scripts` 是 Accounting 與 LLM 摘要的資料來源。完整規範見 `HiBA腳本Manifest與LLM摘要規範.md`。

## 概覽

此資料夾用於將 Raspberry Pi 設定為 **HTTP REST Sub-Web 節點**，提供以下功能：

- `POST /execute`：執行 Python 腳本（Tool 執行端點）
- `POST /deploy`：從 Claw Dashboard 推送腳本或檔案
- `GET /health`：節點健康狀態
- `GET /scripts`：已登錄腳本清單
- `POST /cmd`：Shell 診斷指令（白名單限制）
- AuditTrail SQLite 稽核記錄（A3 公理）

適用場景：Dashboard 手動操作、腳本即時執行、工廠操作員直接互動。

---

## 資料夾內容

```
deploy_http/
├── 00_setup.sh            ← ★ 主要安裝腳本（整合全部步驟，執行這一個即可）
├── 01_tpm_init.sh         ← TPM 金鑰初始化（選用，需 tpm2-tools）
├── 01_tpm_full_setup.sh   ← TPM 軟體模擬版（用 swtpm，測試用途）
├── sub_web_server.js      ← Pi 端 Express.js 伺服器主程式
├── system.deployServer.py ← 自部署腳本（舊系統加裝用，透過 Dashboard 執行）
└── README.md              ← 本說明書
```

---

## 快速開始（全新節點）

### 前置條件

- Raspberry Pi（3B+ 以上）
- Raspberry Pi OS（Bookworm/Bullseye）
- 可連線網路（下載 Node.js、npm 套件）
- 與 Claw 主控端同一區網

### 步驟

**1. 將整個 `deploy_http/` 資料夾複製到 Pi**

```bash
# 在你的電腦上執行（替換 IP）
scp -r deploy_http/ pi@192.168.50.X:~/
```

**2. SSH 進入 Pi，執行安裝腳本**

```bash
ssh pi@192.168.50.X
sudo bash ~/deploy_http/00_setup.sh [NODE_ID] [CLAW_URL]

# 範例：
sudo bash ~/deploy_http/00_setup.sh m1 http://192.168.50.100:8080
```

安裝完成後自動：
- 啟動 `hiba-subweb` systemd 服務（port 3000）
- 向 Claw 登錄節點
- 顯示 `/health` 回應

**3. 在 Claw Dashboard 驗證**

在左側輸入 Pi 的 IP 加 port，點擊 Add：
```
http://192.168.50.X:3000
```
Health 分頁應顯示節點為綠色 online。

---

## 參數說明

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `NODE_ID` | `m1` | 節點唯一識別碼（對應 MQTT topic / Dashboard 顯示名稱） |
| `CLAW_URL` | `http://192.168.1.100:8080` | Claw 主控端位址 |

---

## 已安裝的套件

| 套件 | 用途 |
|------|------|
| Node.js 20 (NodeSource) | 執行 sub_web_server.js |
| express ^4.19.2 | HTTP REST 框架 |
| better-sqlite3 ^9.4.3 | AuditTrail SQLite 寫入 |
| python3 | 執行 Tool 腳本 (.py) |
| tpm2-tools | TPM 金鑰操作（TPM 初始化時需要） |

---

## 目錄結構（安裝後）

```
/opt/hiba/
├── subweb/
│   ├── sub_web_server.js    ← 伺服器主程式
│   ├── package.json
│   ├── node_modules/
│   ├── .env                 ← 環境變數
│   └── audit_trail.db       ← AuditTrail SQLite
├── scripts/
│   ├── manifest.json        ← ToolRegistry（腳本清單）
│   └── *.py                 ← 各 Tool 腳本
├── data/                    ← Deploy File 模式目標（data 類）
├── tpm/                     ← TPM 金鑰檔案
└── logs/
    ├── subweb.log
    └── subweb-err.log
```

---

## 環境變數（/opt/hiba/subweb/.env）

| 變數 | 範例值 | 說明 |
|------|--------|------|
| `NODE_ID` | `m1` | 節點 ID |
| `CLAW_URL` | `http://192.168.50.100:8080` | Claw 位址 |
| `SCRIPTS_DIR` | `/opt/hiba/scripts` | 腳本目錄 |
| `DATA_DIR` | `/opt/hiba/data` | 資料目錄 |
| `AUDIT_DB` | `/opt/hiba/subweb/audit_trail.db` | SQLite 路徑 |
| `PORT` | `3000` | 監聽 port |

---

## 常用指令

```bash
# 服務管理
systemctl status hiba-subweb       # 查看狀態
systemctl restart hiba-subweb      # 重啟
journalctl -u hiba-subweb -f       # 即時日誌

# 健康確認
curl http://localhost:3000/health
curl http://localhost:3000/scripts

# 執行腳本（測試）
curl -X POST http://localhost:3000/execute \
  -H "Content-Type: application/json" \
  -H "X-Trace-Id: test-001" \
  -d '{"scriptName":"script_echo","params":{"message":"hello"}}'

# 日誌
tail -f /opt/hiba/logs/subweb.log
```

---

## 舊系統加裝（已有 sub_web_server 的節點）

若節點已運行舊版 sub_web_server.js，不需要 SSH，透過 Dashboard 更新：

1. Dashboard → 選擇節點 → Deploy 分頁
2. 切換至 **Script 模式**
3. 上傳 `system.deployServer.py`，腳本名稱填 `system.deployServer`
4. Scripts 分頁 → 找到 `system.deployServer` → Execute
5. 腳本會自動寫入新版 JS、重啟服務

---

## TPM 金鑰初始化（選用）

若需要 TPM 硬體信任（論文 I6 創新點）：

```bash
# 真實 TPM（Raspberry Pi 配備硬體 TPM）
sudo bash ~/deploy_http/01_tpm_init.sh

# 軟體模擬（開發測試用，需 swtpm）
bash ~/deploy_http/01_tpm_full_setup.sh
```

完成後 EK Fingerprint 儲存於 `/opt/hiba/tpm/ek_fingerprint.txt`。

---

## 疑難排解

| 問題 | 解法 |
|------|------|
| `npm install` 失敗 | 確認 Node.js 版本：`node --version`（需 v20+） |
| 服務未啟動 | `journalctl -u hiba-subweb -n 50` 查看錯誤 |
| `/health` 無回應 | `systemctl is-active hiba-subweb`，確認 port 3000 未被佔用 |
| Claw 登錄失敗 | 手動：`curl -X POST http://CLAW:8080/api/nodes/register ...` |
| `better-sqlite3` 編譯錯誤 | `apt-get install -y build-essential python3-dev` 後重新 `npm install` |
