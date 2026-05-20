# deploy_mqtt — MQTT + WASM 邊緣節點部署說明書

## 概覽

此資料夾用於將 Raspberry Pi 設定為 **MQTT 邊緣任務執行節點**，採用「零編譯器」原則：

- 節點**不安裝** Node.js / Express / 任何語言 Runtime
- 所有編譯工作集中在 Server A（Claw 端）完成
- 節點只需 **paho-mqtt**（接收任務）+ **iwasm**（WASM 沙箱執行）
- 透過 WAMR 沙箱隔離，任務無法存取宿主系統檔案與網路

適用場景：Agent 自動派發任務、大量邊緣節點、高安全隔離需求。

---

## 與 HTTP 版本的差異

| 面向 | HTTP 版本 (deploy_http) | MQTT 版本 (deploy_mqtt) |
|------|------------------------|------------------------|
| 觸發方式 | Dashboard 手動 / HTTP POST | Agent 自動派發（MQTT） |
| 執行格式 | Python .py 腳本 | .wasm binary（交叉編譯） |
| 沙箱隔離 | 無（python3 直接執行） | WAMR 記憶體隔離 + WASI 能力模型 |
| 結果回傳 | HTTP 同步回應 | MQTT `results/{job_id}` topic |
| 安裝大小 | ~200MB（Node.js + npm） | ~5MB（python3 + paho + iwasm） |
| 操作介面 | Claw Dashboard | 純 Agent 自動化 |

---

## 資料夾內容

```
deploy_mqtt/
├── 00_setup.sh            ← ★ 主要安裝腳本（整合全部步驟，執行這一個即可）
├── 01_tpm_init.sh         ← TPM 金鑰初始化（選用）
├── 01_tpm_full_setup.sh   ← TPM 軟體模擬版（測試用途）
├── runner.py              ← MQTT subscriber + iwasm 執行器
├── agent-runner.service   ← systemd unit
└── README.md              ← 本說明書
```

---

## 前置條件（Server A / Claw 端）

MQTT 版本需要 Server A 先完成：

**1. 安裝 Mosquitto broker（在 Server A 上）**
```bash
sudo apt-get install -y mosquitto mosquitto-clients
sudo systemctl enable --now mosquitto
# 驗證：
mosquitto_pub -t test -m hello && echo "broker 正常"
```

**2. Server 端實作 MQTT dispatcher**（`hiba-core/mqtt_dispatcher.ts`）
- 連線 broker
- 呼叫 `compile_to_wasm(source)` 產生 .wasm
- `publish('tasks/{node_id}', JobPayload)`
- `subscribe('results/#')` 等待回傳

---

## 快速開始（全新節點）

### 步驟

**1. 將整個 `deploy_mqtt/` 資料夾複製到 Pi**

```bash
# 在你的電腦上執行（替換 IP）
scp -r deploy_mqtt/ pi@192.168.50.X:~/
```

**2. SSH 進入 Pi，執行安裝腳本**

```bash
ssh pi@192.168.50.X
sudo bash ~/deploy_mqtt/00_setup.sh [NODE_ID] [BROKER_IP] [CLAW_URL]

# 範例：
sudo bash ~/deploy_mqtt/00_setup.sh m2 192.168.50.100 http://192.168.50.100:8080
```

安裝完成後自動：
- 安裝 `paho-mqtt`
- 下載 `iwasm`（WAMR v2.1.2，aarch64）
- 啟動 `agent-runner` systemd 服務
- 訂閱 `tasks/m2` topic
- 發送首次 heartbeat 至 `heartbeat/m2`

**3. 在 Server 端驗證**

```bash
# 訂閱 heartbeat，確認 Pi 節點上線
mosquitto_sub -t "heartbeat/#" -v
# 應看到：heartbeat/m2 {"node_id":"m2","ts":"..."}
```

---

## 參數說明

| 參數 | 預設值 | 說明 |
|------|--------|------|
| `NODE_ID` | `m1` | 節點唯一識別碼，決定訂閱的 MQTT topic |
| `BROKER` | `192.168.1.100` | Mosquitto broker IP（通常是 Server A） |
| `CLAW_URL` | `http://192.168.1.100:8080` | Claw 位址（節點登錄用） |
| `BROKER_PORT` | `1883` | broker port（環境變數覆蓋） |
| `WASM_TIMEOUT` | `30` | WASM 任務最大執行秒數（環境變數覆蓋） |

---

## MQTT Topic 規範

| Topic | 方向 | 說明 |
|-------|------|------|
| `tasks/{NODE_ID}` | Server → Pi | 任務派發（JobPayload） |
| `results/{job_id}` | Pi → Server | 執行結果（JobResult） |
| `heartbeat/{NODE_ID}` | Pi → Server | 存活通知（每 30s） |

### JobPayload 格式

```json
{
  "job_id":    "550e8400-e29b-41d4-a716-446655440000",
  "node_id":   "m2",
  "wasm":      "<base64 encoded .wasm binary>",
  "args":      ["--input", "data.json"],
  "timeout":   30,
  "issued_at": "2026-04-23T10:00:00Z"
}
```

### JobResult 格式

```json
{
  "job_id":       "550e8400-e29b-41d4-a716-446655440000",
  "node_id":      "m2",
  "stdout":       "...",
  "stderr":       "",
  "exit_code":    0,
  "completed_at": "2026-04-23T10:00:05Z",
  "issued_at":    "2026-04-23T10:00:00Z"
}
```

---

## 已安裝的套件

| 套件 | 用途 |
|------|------|
| paho-mqtt (Python) | MQTT client（訂閱任務、發布結果） |
| iwasm (WAMR 2.1.2) | WASM 執行沙箱 |
| python3 | 執行 runner.py |
| tpm2-tools | TPM 金鑰操作（選用） |

**不需要**：Node.js、gcc、Docker、任何語言 compiler

---

## 目錄結構（安裝後）

```
/opt/agent/
└── runner.py              ← MQTT Agent 主程式

/etc/agent/
└── env                    ← 環境變數

/usr/local/bin/
└── iwasm                  ← WASM runtime binary

/opt/hiba/
├── tpm/                   ← TPM 金鑰（選用）
└── logs/
    ├── agent-runner.log
    └── agent-runner-err.log
```

---

## 環境變數（/etc/agent/env）

| 變數 | 範例值 | 說明 |
|------|--------|------|
| `NODE_ID` | `m2` | 節點 ID（MQTT topic 路由依據） |
| `BROKER` | `192.168.50.100` | Mosquitto broker IP |
| `BROKER_PORT` | `1883` | broker port |
| `CLAW_URL` | `http://192.168.50.100:8080` | Claw 位址 |
| `IWASM_PATH` | `/usr/local/bin/iwasm` | iwasm binary 路徑 |
| `WASM_TIMEOUT` | `30` | 任務執行超時秒數 |

---

## 常用指令

```bash
# 服務管理
systemctl status agent-runner       # 查看狀態
systemctl restart agent-runner      # 重啟
journalctl -u agent-runner -f       # 即時日誌

# 日誌
tail -f /opt/hiba/logs/agent-runner.log

# 手動測試：送一個假任務（需在 Server 或有 mosquitto-clients 的機器執行）
mosquitto_pub -h 192.168.50.100 -t "tasks/m2" -m '{
  "job_id":"test-001",
  "node_id":"m2",
  "wasm":"<base64_wasm>",
  "args":[],
  "timeout":30,
  "issued_at":"2026-04-23T00:00:00Z"
}'

# 監聽結果
mosquitto_sub -h 192.168.50.100 -t "results/#" -v

# 監聽 heartbeat
mosquitto_sub -h 192.168.50.100 -t "heartbeat/#" -v
```

---

## 安全沙箱說明（WAMR）

| 隔離特性 | 說明 |
|----------|------|
| 記憶體隔離 | WASM 線性記憶體無法存取宿主系統 |
| 無任意系統呼叫 | WASI 能力模型，預設阻斷 file I/O、network |
| 無法執行 native binary | 只能執行合法 WASM 指令集 |
| 資源限制 | systemd `MemoryMax=256M` + `CPUQuota=80%` |

---

## TPM 金鑰初始化（選用）

若需要 TPM 硬體信任（論文 I6 創新點）：

```bash
# 真實 TPM
sudo bash ~/deploy_mqtt/01_tpm_init.sh

# 軟體模擬（開發測試）
bash ~/deploy_mqtt/01_tpm_full_setup.sh
```

---

## 疑難排解

| 問題 | 解法 |
|------|------|
| `paho-mqtt import error` | `python3 -m pip install paho-mqtt --break-system-packages` |
| `iwasm not found` | 手動下載：見 00_setup.sh 中的 `WAMR_URL` 變數 |
| broker 連線失敗 | 確認 Mosquitto 在 Server A 運行：`mosquitto_sub -h IP -t test` |
| 任務無回應 | 確認 `tasks/{NODE_ID}` topic 名稱與 NODE_ID 一致 |
| WASM 執行失敗 | 確認 .wasm 為 `wasm32-wasi` target 編譯 |
| 服務未啟動 | `journalctl -u agent-runner -n 50` 查看錯誤 |
