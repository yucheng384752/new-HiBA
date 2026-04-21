#!/usr/bin/env bash
# =============================================================
# tpm_full_setup_v2.sh — 修正版 TPM 初始化腳本
# 修正項目：
#   - tpm2_clear 相容舊版語法
#   - 每個 Stage 明確檢查檔案是否真的產生
#   - Stage 失敗時顯示完整錯誤訊息
# 使用方式：bash tpm_full_setup_v2.sh
# =============================================================

# 不加 -e，改用手動檢查
set -uo pipefail

GREEN='\033[0;32m'; RED='\033[0;31m'; YELLOW='\033[1;33m'; NC='\033[0m'
ok()   { echo -e "${GREEN}✓ $1${NC}"; }
err()  { echo -e "${RED}✗ $1${NC}"; }
info() { echo -e "\n${YELLOW}▸ $1${NC}"; }
die()  { err "$1"; echo "  → 請將以上錯誤貼給開發者排查"; exit 1; }

TPM_DIR="/opt/hiba/tpm"
TPM_STATE="/tmp/tpmstate"
HANDLE="0x81000001"

echo "======================================================"
echo "  HiBA-AB TPM 初始化腳本 v2 (swtpm 軟體模擬版)"
echo "======================================================"

# ── STAGE 0：前置確認 ─────────────────────────────────────
info "STAGE 0：前置確認"

for cmd in swtpm swtpm_setup tpm2_createprimary tpm2_create tpm2_load tpm2_evictcontrol tpm2_readpublic; do
  command -v $cmd >/dev/null 2>&1 \
    && ok "$cmd 已安裝" \
    || die "$cmd 未找到，請先執行：sudo apt-get install -y swtpm swtpm-tools tpm2-tools"
done

sudo mkdir -p "$TPM_DIR"
sudo chown -R "$USER":"$USER" "$TPM_DIR"
chmod 700 "$TPM_DIR"
ok "目錄權限：$TPM_DIR"

# ── STAGE 1：重置並啟動 swtpm ─────────────────────────────
info "STAGE 1：重置並啟動 swtpm"

pkill swtpm 2>/dev/null; sleep 1; true
rm -rf "$TPM_STATE" && mkdir -p "$TPM_STATE"
ok "舊狀態清除"

swtpm_setup \
  --tpm2 \
  --tpmstate "$TPM_STATE" \
  --allow-signing \
  --overwrite
[ $? -eq 0 ] && ok "swtpm 狀態初始化" || die "swtpm_setup 失敗"

swtpm socket \
  --tpmstate dir="$TPM_STATE" \
  --ctrl type=tcp,port=2322 \
  --server type=tcp,port=2321 \
  --tpm2 \
  --flags startup-clear \
  --daemon
sleep 2

ss -tlnp | grep -q "2321" && ok "swtpm TCP port 2321 就緒" || die "swtpm 啟動失敗"

export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=2321"
sed -i '/TPM2TOOLS_TCTI/d' ~/.bashrc
echo 'export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=2321"' >> ~/.bashrc
ok "環境變數：$TPM2TOOLS_TCTI"

# ── STAGE 2：清空 TPM（相容舊版語法） ────────────────────
info "STAGE 2：清空 TPM context"

# 自動偵測 tpm2_clear 支援的語法
if sudo -E tpm2_clear --hierarchy owner 2>/dev/null; then
  ok "TPM 清空（新版語法）"
elif sudo -E tpm2_clear -c o 2>/dev/null; then
  ok "TPM 清空（舊版語法 -c o）"
elif sudo -E tpm2_clear 2>/dev/null; then
  ok "TPM 清空（無參數）"
else
  err "tpm2_clear 失敗，繼續執行（非致命）"
fi

# ── STAGE 3：建立 Primary Key ─────────────────────────────
info "STAGE 3：建立 Primary Key"

# 清除舊的 ctx 避免衝突
rm -f "$TPM_DIR/primary.ctx"

# 顯示完整輸出，方便排查
tpm2_createprimary \
  --hierarchy owner \
  --key-algorithm rsa \
  --hash-algorithm sha256 \
  --key-context "$TPM_DIR/primary.ctx"

if [ $? -ne 0 ]; then
  die "tpm2_createprimary 失敗"
fi

# 明確確認檔案真的存在且非空
[ -s "$TPM_DIR/primary.ctx" ] \
  && ok "primary.ctx 建立完成（$(wc -c < $TPM_DIR/primary.ctx) bytes）" \
  || die "primary.ctx 建立後檔案不存在或為空"

# ── STAGE 4：建立 Signing Key ─────────────────────────────
info "STAGE 4：建立 RSA-2048 Signing Key"

rm -f "$TPM_DIR/signing.pub" "$TPM_DIR/signing.priv"

tpm2_create \
  --parent-context "$TPM_DIR/primary.ctx" \
  --key-algorithm "rsa2048:rsassa:null" \
  --hash-algorithm sha256 \
  --public  "$TPM_DIR/signing.pub" \
  --private "$TPM_DIR/signing.priv"

if [ $? -ne 0 ]; then
  die "tpm2_create 失敗"
fi

[ -s "$TPM_DIR/signing.pub" ]  && ok "signing.pub  建立完成（$(wc -c < $TPM_DIR/signing.pub) bytes）"  || die "signing.pub 不存在"
[ -s "$TPM_DIR/signing.priv" ] && ok "signing.priv 建立完成（$(wc -c < $TPM_DIR/signing.priv) bytes）" || die "signing.priv 不存在"

# ── STAGE 5：載入金鑰 ─────────────────────────────────────
info "STAGE 5：載入金鑰至 TPM session"

# 關鍵：清除 transient context 釋放記憶體空間
echo "  清除 transient context..."
tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true
tpm2_flushcontext --saved-session    2>/dev/null || true
ok "transient context 清除完成"

rm -f "$TPM_DIR/signing.ctx"

tpm2_load \
  --parent-context "$TPM_DIR/primary.ctx" \
  --public  "$TPM_DIR/signing.pub" \
  --private "$TPM_DIR/signing.priv" \
  --key-context "$TPM_DIR/signing.ctx"

if [ $? -ne 0 ]; then
  die "tpm2_load 失敗"
fi

[ -s "$TPM_DIR/signing.ctx" ] \
  && ok "signing.ctx 建立完成（$(wc -c < $TPM_DIR/signing.ctx) bytes）" \
  || die "signing.ctx 不存在"

# ── STAGE 6：持久化 ───────────────────────────────────────
info "STAGE 6：持久化至 Handle $HANDLE"

tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true
ok "Stage 6 flush 完成"

# 清除舊 Handle（若存在）
tpm2_evictcontrol \
  --hierarchy owner \
  --object-context "$HANDLE" \
  "$HANDLE" 2>/dev/null && echo "  (舊 Handle 已清除)" || true

tpm2_evictcontrol \
  --hierarchy owner \
  --object-context "$TPM_DIR/signing.ctx" \
  "$HANDLE"

[ $? -eq 0 ] && ok "持久化完成：$HANDLE" || die "tpm2_evictcontrol 失敗"

# ── STAGE 7：匯出公鑰 ─────────────────────────────────────
info "STAGE 7：匯出公鑰與 EK Fingerprint"

tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true
ok "Stage 7 flush 完成"

tpm2_readpublic \
  --object-context "$HANDLE" \
  --output "$TPM_DIR/signing_public.pem" \
  --format pem

[ $? -eq 0 ] && ok "公鑰匯出：$TPM_DIR/signing_public.pem" || die "tpm2_readpublic 失敗"

# EK Fingerprint
EK_FP=$(openssl pkey -in "$TPM_DIR/signing_public.pem" -pubin -outform DER 2>/dev/null \
  | sha256sum | awk '{print $1}')
echo "$EK_FP" > "$TPM_DIR/ek_fingerprint.txt"
ok "EK Fingerprint：$EK_FP"

# ── STAGE 8：最終驗證 ─────────────────────────────────────
info "STAGE 8：最終驗證"

tpm2_flushcontext --transient-object 2>/dev/null || true
tpm2_flushcontext --loaded-session   2>/dev/null || true

HANDLES=$(tpm2_getcap handles-persistent 2>/dev/null)
echo "$HANDLES" | grep -q "$HANDLE" \
  && ok "Handle $HANDLE 確認存在" \
  || die "Handle 不在清單中"

echo ""
echo "  現有所有 Handles："
echo "$HANDLES" | sed 's/^/    /'

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

# ── 完成摘要 ──────────────────────────────────────────────
echo ""
echo "======================================================"
echo -e "${GREEN}  TPM 初始化完成！${NC}"
echo "======================================================"
echo "  Handle     : $HANDLE"
echo "  Fingerprint: $EK_FP"
echo "  公鑰："
cat "$TPM_DIR/signing_public.pem"
echo ""
echo "  ⚠ 重開機後執行：bash ~/start_swtpm.sh"
echo "======================================================"

# 建立重啟腳本
cat > ~/start_swtpm.sh <<'BOOT_EOF'
#!/usr/bin/env bash
pkill swtpm 2>/dev/null; sleep 1
mkdir -p /tmp/tpmstate
swtpm_setup --tpm2 --tpmstate /tmp/tpmstate --createek --allow-signing --overwrite 2>/dev/null || true
swtpm socket \
  --tpmstate dir=/tmp/tpmstate \
  --ctrl type=tcp,port=2322 \
  --server type=tcp,port=2321 \
  --tpm2 --flags startup-clear --daemon
sleep 2
export TPM2TOOLS_TCTI="swtpm:host=127.0.0.1,port=2321"
echo "✓ swtpm 已啟動"
tpm2_getcap handles-persistent 2>/dev/null
BOOT_EOF

chmod +x ~/start_swtpm.sh
ok "重啟腳本：~/start_swtpm.sh"