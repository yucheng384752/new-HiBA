#!/usr/bin/env python3
"""
scripts/script_fileio.py — 檔案寫入回讀測試腳本（2-phase）
驗證 Pi 本地檔案系統可正常讀寫，支援分階段執行

輸入：
  {
    "mode":     "probe" | "write" | "full",   ← 執行模式（選填，預設 "full"）
    "content":  "hello from PC",              ← 要寫入的字串（write/full 用，預設為時間戳）
    "filename": "test_io.txt"                 ← 檔名（選填，預設 test_io.txt）
  }

模式說明：
  "probe" → Phase 1：傳空檔，驗證檔案存在（傳輸通道測試）
            Orchestrator 收到後，確認 transferOk=true 再呼叫 write
  "write" → Phase 2：寫入實際內容並回讀驗證
            通常在 probe 確認通過後由 Orchestrator 觸發
  "full"  → 自動執行 probe + write 完整流程（probe 失敗時短路）

輸出（probe 模式）：
  {
    "success":     true,
    "phase":       "probe",
    "transferOk":  true,
    "path":        "/opt/hiba/subweb/scripts/test_io.txt",
    "renderHint":  "table"
  }

輸出（write / full 模式）：
  {
    "success":     true,
    "phase":       "write" | "full",
    "transferOk":  true,          ← full 模式才有此欄位
    "written":     true,
    "content":     "hello from PC",
    "path":        "/opt/hiba/subweb/scripts/test_io.txt",
    "sizeBytes":   14,
    "writtenAt":   "...",
    "readBack":    "hello from PC",
    "matched":     true,
    "renderHint":  "table"
  }
"""
import sys, json, os, datetime

def main():
    params   = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    mode     = params.get("mode", "full")   # "probe" | "write" | "full"
    content  = params.get("content",
               f"test-{datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ')}")
    filename = params.get("filename", "test_io.txt")

    # 限制檔名只能在腳本目錄內（防止路徑穿越）
    scripts_dir = os.path.dirname(os.path.abspath(__file__))
    safe_name   = os.path.basename(filename)
    filepath    = os.path.join(scripts_dir, safe_name)

    # ── Phase 1: probe（傳空檔，驗證傳輸通道）───────────────────────────────
    if mode in ("probe", "full"):
        with open(filepath, "w", encoding="utf-8") as f:
            f.write("")
        transfer_ok = os.path.exists(filepath) and os.path.getsize(filepath) == 0

        if mode == "probe":
            print(json.dumps({
                "success":    transfer_ok,
                "phase":      "probe",
                "transferOk": transfer_ok,
                "path":       filepath,
                "renderHint": "table",
                "toolName":   "env.verifyFileIo",
                "domain":     "env"
            }, ensure_ascii=False))
            return

        # full 模式：probe 失敗則短路，不繼續寫入
        if not transfer_ok:
            print(json.dumps({
                "success":    False,
                "phase":      "probe",
                "transferOk": False,
                "failReason": "空檔傳輸失敗，目錄可能不可寫",
                "path":       filepath,
                "renderHint": "table",
                "toolName":   "env.verifyFileIo",
                "domain":     "env"
            }, ensure_ascii=False))
            return

    # ── Phase 2: write（寫入實際內容並回讀驗證）─────────────────────────────
    written_at = datetime.datetime.now(datetime.timezone.utc).isoformat().replace("+00:00", "Z")

    with open(filepath, "w", encoding="utf-8") as f:
        f.write(content)

    with open(filepath, "r", encoding="utf-8") as f:
        read_back = f.read()

    size_bytes = os.path.getsize(filepath)
    matched    = (read_back == content)

    result = {
        "success":    matched,
        "phase":      "full" if mode == "full" else "write",
        "written":    True,
        "content":    content,
        "path":       filepath,
        "sizeBytes":  size_bytes,
        "writtenAt":  written_at,
        "readBack":   read_back,
        "matched":    matched,
        "renderHint": "table",
        "toolName":   "env.verifyFileIo",
        "domain":     "env"
    }
    if mode == "full":
        result["transferOk"] = True   # probe 已通過，補上欄位供 Orchestrator 完整審計

    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
