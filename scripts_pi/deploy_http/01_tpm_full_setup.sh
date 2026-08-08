#!/usr/bin/env bash
# =============================================================
# 01_tpm_full_setup.sh — 持久化 swtpm 初始化腳本
#
# 特性：
#   - swtpm 狀態存於 /opt/hiba/tpm/swtpm-state（重開機保留）
#   - 首次執行：建立 swtpm 狀態 + systemd 服務 + TPM 金鑰
#   - 重複執行（冪等）：重新連接已有狀態，跳過已完成步驟
#   - 開機自啟：swtpm.service 由 systemd 管理
#   - 指紋穩定：同一 swtpm 狀態每次 EK 相同
#
# 使用方式：sudo bash 01_tpm_full_setup.sh
# =============================================================

set -uo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; }
info() { echo -e "\n${YELLOW}▸ $1${NC}"; }
skip() { echo -e "${CYAN}↷ $1（已存在，跳過）${NC}"; }
die()  { err "$1"; echo "  → 請將以上錯誤貼給開發者排查"; exit 1; }

# ── 路徑設定（全部持久化至 /opt/hiba/tpm） ───────────────────
TPM_DIR="/opt/hiba/tpm"
TPM_STATE="${TPM_DIR}/swtpm-state"   # 持久化：非 /tmp
HANDLE="0x81000001"
TCTI_ENV_FILE="/etc/profile.d/hiba-tpm.sh"
SWTPM_SERVICE="/etc/systemd/system/swtpm.service"
TCTI_CONF="${TPM_DIR}/tcti.conf"     # 供 systemd EnvironmentFile 使用
SWTPM_LOG="${TPM_DIR}/swtpm.log"

TCTI_VALUE="swtpm:host=127.0.0.1,port=2321"

echo "======================================================"
echo "  HiBA-AB TPM 持久化初始化腳本"
echo "  TPM State : $TPM_STATE"
echo "  Handle    : $HANDLE"
echo "======================================================"

# ── STAGE 0：前置確認 ─────────────────────────────────────────
info "STAGE 0：前置確認"

[[ $EUID -eq 0 ]] || die "請以 sudo 執行：sudo bash $0"

# 自動安裝缺少的套件（避免需要使用者手動安裝）
PKGS_NEEDED=()
command -v swtpm       >/dev/null 2>&1 || PKGS_NEEDED+=(swtpm)
command -v swtpm_setup >/dev/null 2>&1 || PKGS_NEEDED+=(swtpm-tools)
command -v tpm2_createprimary >/dev/null 2>&1 || PKGS_NEEDED+=(tpm2-tools)
command -v openssl     >/dev/null 2>&1 || PKGS_NEEDED+=(openssl)

if [[ ${#PKGS_NEEDED[@]} -gt 0 ]]; then
  info "自動安裝缺少套件：${PKGS_NEEDED[*]}"
  apt-get update -q 2>/dev/null || true
  apt-get install -y "${PKGS_NEEDED[@]}" \
    || die "套件安裝失敗，請手動執行：sudo apt-get install -y swtpm swtpm-tools tpm2-tools openssl"
fi

for cmd in swtpm swtpm_setup tpm2_createprimary tpm2_create tpm2_load \
           tpm2_evictcontrol tpm2_readpublic tpm2_flushcontext openssl; do
  command -v "$cmd" >/dev/null 2>&1 \
    && ok "$cmd 已安裝" \
    || die "$cmd 未找到（安裝失敗）"
done

# 建立目錄（持久化路徑）
mkdir -p "$TPM_DIR" "$TPM_STATE"
REAL_USER="${SUDO_USER:-${USER:-$(logname 2>/dev/null || whoami)}}"
# 755 讓 swtpm 子程序（可能以 swtpm 系統帳號執行）也能進入目錄
chmod 755 "$TPM_STATE"
chown -R "$REAL_USER":"$REAL_USER" "$TPM_DIR"
ok "目錄建立：$TPM_DIR（owner: $REAL_USER, mode: 755）"

# AppArmor 修正：swtpm profile 預設只允許 /var/lib/swtpm/**，
# 若 TPM_STATE 在 /opt/... 會被 DENIED（operation=mknod）
# 解法：寫入 local override，加入 /opt/hiba/tpm/** 白名單後 reload
if command -v aa-status >/dev/null 2>&1 && aa-status --enabled 2>/dev/null; then
  AA_LOCAL="/etc/apparmor.d/local/usr.bin.swtpm"
  AA_PROFILE="/etc/apparmor.d/usr.bin.swtpm"

  # 確保 local override 目錄存在
  mkdir -p /etc/apparmor.d/local

  # 若 local override 尚未包含 /opt/hiba/tpm，加入
  if [[ ! -f "$AA_LOCAL" ]] || ! grep -q "/opt/hiba/tpm" "$AA_LOCAL" 2>/dev/null; then
    cat >> "$AA_LOCAL" <<'AAEOF'

# HiBA-AB swtpm state — added by 01_tpm_full_setup.sh
/opt/hiba/tpm/  r,
/opt/hiba/tpm/** rwk,
AAEOF
    ok "AppArmor: 已加入 /opt/hiba/tpm 白名單至 $AA_LOCAL"
  else
    ok "AppArmor: /opt/hiba/tpm 已在白名單中"
  fi

  # Reload swtpm profile
  if [[ -f "$AA_PROFILE" ]]; then
    apparmor_parser -r "$AA_PROFILE" 2>/dev/null \
      && ok "AppArmor: swtpm profile 已 reload" \
      || err "AppArmor: profile reload 失敗（非致命，繼續執行）"
  fi
fi

# ── STAGE 1：swtpm 狀態初始化（冪等：僅首次執行） ────────────
info "STAGE 1：swtpm 狀態初始化"

STATE_MARKER="${TPM_STATE}/.initialized"

if [[ -f "$STATE_MARKER" ]]; then
  skip "swtpm 狀態已存在（$TPM_STATE），跳過 swtpm_setup"
  echo "  → 指紋與首次初始化相同（穩定）"
else
  # swtpm 0.6.x：--swtpm-user / --create-config-files 不存在
  # swtpm 0.7+：支援 --create-config-files overwrite
  # 以 --runas root 確保子程序有寫入權限（0.6.x 的對應旗標）
  swtpm_setup \
    --tpm2 \
    --tpmstate "$TPM_STATE" \
    --allow-signing \
    --createek \
    --runas root \
    2>>"$SWTPM_LOG"
  SETUP_RC=$?

  # 若 --runas 不被此版本支援（exit 非零），改不帶 --runas 重試
  if [[ $SETUP_RC -ne 0 ]]; then
    echo "  (retry without --runas)" >> "$SWTPM_LOG"
    swtpm_setup \
      --tpm2 \
      --tpmstate "$TPM_STATE" \
      --allow-signing \
      --createek \
      2>>"$SWTPM_LOG"
    SETUP_RC=$?
  fi
  if [[ $SETUP_RC -ne 0 ]]; then
    err "swtpm_setup 失敗（exit $SETUP_RC）"
    echo ""
    echo "  ── swtpm.log 最後 30 行 ──"
    tail -30 "$SWTPM_LOG" 2>/dev/null || echo "  （log 為空或不存在）"
    echo "  ──────────────────────────"
    echo ""
    echo "  常見修復方案："
    echo "    1. sudo apt-get install --reinstall swtpm swtpm-tools"
    echo "    2. sudo apt-get install apparmor-utils && sudo aa-complain /usr/bin/swtpm"
    echo "    3. sudo rm -rf $TPM_STATE && sudo bash $0"
    die "swtpm_setup 失敗，請依上方提示排查"
  fi

  touch "$STATE_MARKER"
  chown "$REAL_USER":"$REAL_USER" "$STATE_MARKER"
  ok "swtpm 狀態初始化完成（EK 已建立，指紋固定）"
fi

# ── STAGE 2：建立 systemd 服務（冪等） ───────────────────────
info "STAGE 2：swtpm systemd 服務"

# 寫入 EnvironmentFile（供 systemd service 讀取 TCTI）
cat > "$TCTI_CONF" <<EOF
TPM2TOOLS_TCTI=${TCTI_VALUE}
EOF
chown root:root "$TCTI_CONF"
chmod 644 "$TCTI_CONF"
ok "TCTI 設定檔：$TCTI_CONF"

if [[ -f "$SWTPM_SERVICE" ]]; then
  skip "swtpm.service 已存在"
else
  cat > "$SWTPM_SERVICE" <<EOF
[Unit]
Description=Software TPM (swtpm) for HiBA-AB
After=network.target
Before=hiba-subweb.service

[Service]
Type=forking
User=root
ExecStartPre=/bin/mkdir -p ${TPM_STATE}
ExecStart=/usr/bin/swtpm socket \\
  --tpmstate dir=${TPM_STATE} \\
  --ctrl type=tcp,port=2322 \\
  --server type=tcp,port=2321 \\
  --tpm2 \\
  --flags startup-clear \\
  --daemon \\
  --log file=${SWTPM_LOG},level=5
ExecStop=/usr/bin/pkill -f "swtpm socket"
RemainAfterExit=yes
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
  ok "swtpm.service 建立完成"
fi

# 啟用並（重）啟動 swtpm 服務
systemctl daemon-reload
systemctl enable swtpm.service
systemctl restart swtpm.service
sleep 2

if systemctl is-active --quiet swtpm.service; then
  ok "swtpm.service 運行中"
else
  journalctl -u swtpm.service -n 20 --no-pager
  die "swtpm.service 啟動失敗"
fi

# 確認 TCP 連接埠就緒（ss 不一定存在，改用 Python socket 探測）
if python3 -c "
import socket, sys
s = socket.socket()
s.settimeout(3)
try:
    s.connect(('127.0.0.1', 2321))
    s.close()
    sys.exit(0)
except Exception:
    sys.exit(1)
" 2>/dev/null; then
  ok "swtpm TCP port 2321 就緒"
elif pgrep -x swtpm >/dev/null 2>&1; then
  ok "swtpm 程序存在（port 探測異常，繼續執行）"
else
  die "swtpm port 2321 未就緒（swtpm 程序未啟動）"
fi

# ── STAGE 3：設定 TCTI 環境變數（系統全域） ──────────────────
info "STAGE 3：設定 TCTI 環境變數"

# /etc/profile.d/（互動式 shell）
cat > "$TCTI_ENV_FILE" <<EOF
# HiBA-AB swtpm TCTI — 由 01_tpm_full_setup.sh 自動產生
export TPM2TOOLS_TCTI="${TCTI_VALUE}"
EOF
chmod 644 "$TCTI_ENV_FILE"
ok "系統全域環境變數：$TCTI_ENV_FILE"

# 目前 shell session 立即生效
export TPM2TOOLS_TCTI="$TCTI_VALUE"

# 若 hiba-subweb.service 存在，更新其 EnvironmentFile 使其讀取 TCTI
SUBWEB_ENV="/opt/hiba/subweb/.env"
if [[ -f "$SUBWEB_ENV" ]]; then
  sed -i '/^TPM2TOOLS_TCTI/d' "$SUBWEB_ENV"
  echo "TPM2TOOLS_TCTI=${TCTI_VALUE}" >> "$SUBWEB_ENV"
  ok "hiba-subweb .env 更新 TPM2TOOLS_TCTI"
fi

# 確保此 shell 的 TCTI 已指向 swtpm
export TPM2TOOLS_TCTI="${TCTI_VALUE}"

# ── 冪等守衛：若 Handle 已持久化則跳過 STAGES 4-7 ────────────
if [[ -f "$STATE_MARKER" ]] && \
   tpm2_getcap handles-persistent 2>/dev/null | grep -q "$HANDLE"; then
  skip "簽名密鑰已持久化至 $HANDLE，跳過 STAGES 4-7（冪等保護）"
  # 直接跳往 STAGE 8
else

# ── STAGE 4：清空 TPM context ────────────────────────────────
info "STAGE 4：清空 TPM context"

if tpm2_clear --hierarchy owner 2>/dev/null; then
  ok "TPM 清空（新版語法）"
elif tpm2_clear -c o 2>/dev/null; then
  ok "TPM 清空（舊版語法 -c o）"
elif tpm2_clear 2>/dev/null; then
  ok "TPM 清空（無參數）"
else
  err "tpm2_clear 失敗，繼續執行（非致命）"
fi

# ── STAGE 5：建立 Primary Key ────────────────────────────────
info "STAGE 5：建立 Primary Key"

rm -f "${TPM_DIR}/primary.ctx"

tpm2_createprimary \
  --hierarchy owner \
  --key-algorithm rsa \
  --hash-algorithm sha256 \
  --key-context "${TPM_DIR}/primary.ctx" || die "tpm2_createprimary 失敗"

[[ -s "${TPM_DIR}/primary.ctx" ]] \
  && ok "primary.ctx 建立完成（$(wc -c < "${TPM_DIR}/primary.ctx") bytes）" \
  || die "primary.ctx 建立後為空"

# ── STAGE 6：建立 Signing Key ────────────────────────────────
info "STAGE 6：建立 RSA-2048 Signing Key"

rm -f "${TPM_DIR}/signing.pub" "${TPM_DIR}/signing.priv"

tpm2_create \
  --parent-context "${TPM_DIR}/primary.ctx" \
  --key-algorithm "rsa2048:rsassa:null" \
  --hash-algorithm sha256 \
  --public  "${TPM_DIR}/signing.pub" \
  --private "${TPM_DIR}/signing.priv" || die "tpm2_create 失敗"

[[ -s "${TPM_DIR}/signing.pub" ]]  && ok "signing.pub  建立完成" || die "signing.pub 不存在"
[[ -s "${TPM_DIR}/signing.priv" ]] && ok "signing.priv 建立完成" || die "signing.priv 不存在"

# ── STAGE 7：載入並持久化 ────────────────────────────────────
info "STAGE 7：載入金鑰並持久化至 $HANDLE"

tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true
tpm2_flushcontext --saved-session    2>/dev/null || true

rm -f "${TPM_DIR}/signing.ctx"

tpm2_load \
  --parent-context "${TPM_DIR}/primary.ctx" \
  --public  "${TPM_DIR}/signing.pub" \
  --private "${TPM_DIR}/signing.priv" \
  --key-context "${TPM_DIR}/signing.ctx" || die "tpm2_load 失敗"

[[ -s "${TPM_DIR}/signing.ctx" ]] && ok "signing.ctx 建立完成" || die "signing.ctx 不存在"

tpm2_flushcontext --transient-object 2>/dev/null || true

# 清除舊 Handle（若存在）
tpm2_evictcontrol \
  --hierarchy owner \
  --object-context "$HANDLE" \
  "$HANDLE" 2>/dev/null && echo "  (舊 Handle 已清除)" || true

tpm2_evictcontrol \
  --hierarchy owner \
  --object-context "${TPM_DIR}/signing.ctx" \
  "$HANDLE" || die "tpm2_evictcontrol 失敗"

ok "持久化完成：$HANDLE"

fi  # ── end of STAGES 4-7（冪等守衛）────────────────────────

# ── STAGE 8：匯出公鑰與 EK Fingerprint ──────────────────────
info "STAGE 8：匯出公鑰與 EK Fingerprint"

tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true

tpm2_readpublic \
  --object-context "$HANDLE" \
  --output "${TPM_DIR}/signing_public.pem" \
  --format pem || die "tpm2_readpublic 失敗"

ok "公鑰匯出：${TPM_DIR}/signing_public.pem"

EK_FP=$(openssl pkey -in "${TPM_DIR}/signing_public.pem" -pubin -outform DER 2>/dev/null \
  | sha256sum | awk '{print $1}')
echo "$EK_FP" > "${TPM_DIR}/ek_fingerprint.txt"
chown "$REAL_USER":"$REAL_USER" "${TPM_DIR}/ek_fingerprint.txt"
ok "EK Fingerprint：$EK_FP"

# ── STAGE 9：最終驗證 ────────────────────────────────────────
info "STAGE 9：最終驗證"

tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true

HANDLES=$(tpm2_getcap handles-persistent 2>/dev/null)
echo "$HANDLES" | grep -q "$HANDLE" \
  && ok "Handle $HANDLE 確認存在" \
  || die "Handle 不在清單中"

# 簽章測試
echo "hiba-test" > /tmp/_hiba_test.txt
tpm2_sign \
  --key-context "$HANDLE" \
  --hash-algorithm sha256 \
  --scheme rsassa \
  --signature /tmp/_hiba_sig.bin \
  /tmp/_hiba_test.txt 2>/dev/null \
  && ok "簽章測試通過" \
  || err "簽章測試失敗（非致命，持久化已成功）"
rm -f /tmp/_hiba_test.txt /tmp/_hiba_sig.bin

# ── 若 hiba-subweb.service 已安裝，重啟以套用新環境變數 ──────
if systemctl is-enabled hiba-subweb.service 2>/dev/null | grep -q "enabled"; then
  systemctl restart hiba-subweb.service
  ok "hiba-subweb.service 已重啟（套用 TPM 環境變數）"
fi

# ── 自動匯出 machine-pubkey.pem 至執行目錄 ───────────────────
EXPORT_DIR="$(pwd)"
PUBKEY_EXPORT="${EXPORT_DIR}/machine-pubkey.pem"
if cp "${TPM_DIR}/signing_public.pem" "$PUBKEY_EXPORT" 2>/dev/null; then
  chown "$REAL_USER":"$REAL_USER" "$PUBKEY_EXPORT" 2>/dev/null || true
  ok "machine-pubkey.pem 已匯出至：$PUBKEY_EXPORT"
else
  err "machine-pubkey.pem 匯出失敗（非致命）"
fi

# ── 完成摘要 ──────────────────────────────────────────────────
echo ""
echo "======================================================"
echo -e "${GREEN}  TPM 持久化初始化完成！${NC}"
echo "======================================================"
echo "  Handle      : $HANDLE"
echo "  狀態目錄    : $TPM_STATE（開機保留）"
echo "  公鑰（系統）: ${TPM_DIR}/signing_public.pem"
echo "  公鑰（上傳）: ${PUBKEY_EXPORT}"
echo ""
echo "  服務狀態："
systemctl is-active swtpm.service      && echo "    swtpm      : running ✓" || echo "    swtpm      : FAILED ✗"
systemctl is-enabled swtpm.service     && echo "    開機自啟   : enabled ✓" || echo "    開機自啟   : disabled"
echo ""
echo "  環境變數（已寫入 $TCTI_ENV_FILE）："
echo "    TPM2TOOLS_TCTI=${TCTI_VALUE}"
echo ""
echo "  下一步："
echo "    將 machine-pubkey.pem 上傳至 Kit Composer 平台以取得機器綁定授權"
echo "    （或執行 get-machine-pubkey.sh 重新匯出）"
echo ""
echo "  ⚠ 重開機後 swtpm 由 systemd 自動啟動，無需手動操作"
echo "  ⚠ 勿執行 swtpm_setup --overwrite，會導致公鑰改變"
echo "======================================================"
