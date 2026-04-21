#!/usr/bin/env python3
"""
scripts/script_read_attach.py — 讀取附加文件並回傳摘要
示範腳本如何從 params._filePath 讀取前端上傳的文件

輸入：
  {
    "_filePath": "/tmp/hiba_uploads/xxx_data.json",  ← 由後端自動注入
    "_fileName": "data.json",                         ← 原始檔名，後端注入
    "maxRows":   10                                    ← 選填，最多回傳幾行
  }

輸出：
  {
    "success":   true,
    "fileName":  "data.json",
    "sizeBytes": 1234,
    "lineCount": 50,
    "preview":   "前 N 行或 JSON 摘要...",
    "dataType":  "json" | "text",
    "renderHint": "table"
  }
"""
import sys, json, os

def main():
    params    = json.loads(sys.argv[1] if len(sys.argv) > 1 else '{}')
    file_path = params.get("_filePath", "")
    file_name = params.get("_fileName", "unknown")
    max_rows  = int(params.get("maxRows", 20))

    if not file_path:
        print(json.dumps({"success": False, "error": "未附加文件（_filePath 缺失）"}))
        return

    if not os.path.exists(file_path):
        print(json.dumps({"success": False, "error": f"找不到附件路徑：{file_path}"}))
        return

    with open(file_path, "r", encoding="utf-8") as f:
        raw = f.read()

    size_bytes = len(raw.encode("utf-8"))
    lines      = raw.splitlines()
    line_count = len(lines)

    # 判斷是否為 JSON
    data_type = "text"
    parsed    = None
    try:
        parsed    = json.loads(raw)
        data_type = "json"
    except Exception:
        pass

    # 建立預覽
    if data_type == "json":
        if isinstance(parsed, list):
            preview_rows = parsed[:max_rows]
            preview = json.dumps(preview_rows, ensure_ascii=False, indent=2)
            summary = f"JSON 陣列，共 {len(parsed)} 筆，顯示前 {min(len(parsed), max_rows)} 筆"
        elif isinstance(parsed, dict):
            preview = json.dumps(parsed, ensure_ascii=False, indent=2)[:2000]
            summary = f"JSON 物件，共 {len(parsed)} 個欄位"
        else:
            preview = str(parsed)[:2000]
            summary = "JSON 純值"
    else:
        preview = "\n".join(lines[:max_rows])
        summary = f"純文字，共 {line_count} 行，顯示前 {min(line_count, max_rows)} 行"

    result = {
        "success":    True,
        "fileName":   file_name,
        "sizeBytes":  size_bytes,
        "lineCount":  line_count,
        "dataType":   data_type,
        "summary":    summary,
        "preview":    preview,
        "renderHint": "table",
        "toolName":   "material.readAttachment",
        "domain":     "material"
    }
    print(json.dumps(result, ensure_ascii=False))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"success": False, "error": str(e)}), file=sys.stderr)
        sys.exit(1)
