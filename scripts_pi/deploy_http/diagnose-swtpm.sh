#!/usr/bin/env bash
# diagnose-swtpm.sh — 診斷 swtpm 無法啟動的原因
# 執行：sudo bash diagnose-swtpm.sh
set -uo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; }
info() { echo -e "\n${YELLOW}▸ $1${NC}"; }

TPM_STATE="/opt/hiba/tpm/swtpm-state"
TEST_LOG="/tmp/swtpm-diag.log"
TEST_PORT=12321
TEST_CTRL=12322

echo "======================================================"
echo "  swtpm 診斷工具"
echo "  $(date)"
echo "======================================================"

# ── 1. 系統基本資訊 ────────────────────────────────────────
info "1. 系統環境"
echo "  OS      : $(grep PRETTY_NAME /etc/os-release 2>/dev/null | cut -d= -f2 | tr -d '\"' || uname -a)"
echo "  Kernel  : $(uname -r)"
echo "  Arch    : $(uname -m)"
echo "  User    : $(id)"

# ── 2. swtpm 版本 ──────────────────────────────────────────
info "2. swtpm 版本"
swtpm --version 2>&1 || err "swtpm --version 失敗"
swtpm_setup --version 2>&1 || err "swtpm_setup --version 失敗"

# ── 3. libtpms 函式庫 ──────────────────────────────────────
info "3. libtpms 相依函式庫"
ldd "$(command -v swtpm)" 2>/dev/null | grep -E "tpms|not found" || echo "  (ldd 不可用)"
dpkg -l libtpms* 2>/dev/null | grep -E "^ii" || echo "  dpkg: 找不到 libtpms 封裝資訊"

# ── 4. AppArmor 狀態 ───────────────────────────────────────
info "4. AppArmor"
if command -v aa-status >/dev/null 2>&1; then
  aa-status 2>/dev/null | head -20 || true
  # 看 swtpm profile 是否 enforce
  aa-status 2>/dev/null | grep -i swtpm && err "swtpm 受 AppArmor 管控！" || ok "swtpm 不在 enforce 清單"
else
  ok "AppArmor 未安裝"
fi

# ── 5. 目錄與權限 ──────────────────────────────────────────
info "5. TPM 目錄狀態"
echo "  /opt/hiba/tpm :"
ls -la /opt/hiba/tpm/ 2>/dev/null || echo "  （不存在）"
echo ""
echo "  $TPM_STATE :"
ls -la "$TPM_STATE/" 2>/dev/null || echo "  （不存在）"

# ── 6. 停止現有 swtpm.service ──────────────────────────────
info "6. 停止現有 swtpm"
systemctl stop swtpm.service 2>/dev/null || true
pkill -x swtpm 2>/dev/null || true
sleep 1

# ── 7. 直接啟動 swtpm 測試（不透過 swtpm_setup）─────────────
info "7. 直接啟動 swtpm（不含 swtpm_setup）"
mkdir -p "$TPM_STATE"
chmod 755 "$TPM_STATE"

rm -f "$TEST_LOG"
swtpm socket \
  --tpmstate "dir=$TPM_STATE" \
  --ctrl "type=tcp,port=$TEST_CTRL" \
  --server "type=tcp,port=$TEST_PORT" \
  --tpm2 --flags startup-clear --daemon \
  --log "file=$TEST_LOG,level=5" 2>&1

sleep 2

if pgrep -x swtpm >/dev/null 2>&1; then
  ok "swtpm 直接啟動成功（port $TEST_PORT 有程序）"
  pkill -x swtpm 2>/dev/null || true
else
  err "swtpm 直接啟動失敗！"
  echo ""
  echo "  ── swtpm 測試 log ──"
  cat "$TEST_LOG" 2>/dev/null || echo "  （log 為空）"
  echo "  ────────────────────"
fi

# ── 8. swtpm_setup 詳細輸出（清空舊狀態後重試）──────────────
info "8. swtpm_setup 診斷執行"
echo "  清空 $TPM_STATE 並重新初始化..."
rm -rf "${TPM_STATE:?}"/*
chmod 755 "$TPM_STATE"

SETUP_LOG="/tmp/swtpm-setup-diag.log"
rm -f "$SETUP_LOG"

swtpm_setup \
  --tpm2 \
  --tpmstate "$TPM_STATE" \
  --allow-signing \
  --createek \
  --swtpm-user root \
  --swtpm-group root \
  --create-config-files overwrite \
  --log "$SETUP_LOG" \
  2>&1

SETUP_RC=$?
echo "  exit code: $SETUP_RC"
echo ""
echo "  ── swtpm_setup log ──"
cat "$SETUP_LOG" 2>/dev/null || echo "  （log 為空）"
echo "  ─────────────────────"

# ── 9. dmesg（AppArmor / 核心錯誤）────────────────────────
info "9. dmesg 最後 20 行（含 swtpm / apparmor）"
dmesg 2>/dev/null | grep -iE "swtpm|apparmor|denied|avc" | tail -20 || echo "  (無相關 kernel 訊息)"

# ── 10. 既有 swtpm.log ────────────────────────────────────
info "10. /opt/hiba/tpm/swtpm.log（若存在）"
EXISTING_LOG="/opt/hiba/tpm/swtpm.log"
if [[ -f "$EXISTING_LOG" ]]; then
  echo "  最後 40 行："
  tail -40 "$EXISTING_LOG"
else
  echo "  （尚不存在）"
fi

echo ""
echo "======================================================"
echo "  診斷完成。請將以上全部輸出貼給開發者。"
echo "======================================================"
