#!/usr/bin/env bash
# =============================================================
# 01_tpm_init.sh — TPM 金鑰初始化（對應論文附錄 A）
# 執行：sudo bash 01_tpm_init.sh
# =============================================================
set -euo pipefail

TPM_DIR="/opt/hiba/tpm"
PERSISTENT_HANDLE="0x81000001"
LOG="$TPM_DIR/tpm_init.log"

echo "======================================"
echo " TPM 金鑰初始化"
echo " Handle : $PERSISTENT_HANDLE"
echo " Output : $TPM_DIR"
echo "======================================"

mkdir -p "$TPM_DIR"

# ── Step 1：建立 Primary Key ──────────────────────────────
echo "[1/5] 建立 Primary Key (Owner Hierarchy)..."
tpm2_createprimary \
  --hierarchy owner \
  --key-algorithm rsa \
  --hash-algorithm sha256 \
  --key-context "$TPM_DIR/primary.ctx" \
  2>>"$LOG"
echo "      ✓ primary.ctx"

# ── Step 2：建立 Signing Key ──────────────────────────────
echo "[2/5] 建立 RSA-2048 簽章金鑰 (RSASSA + SHA-256)..."
tpm2_create \
  --parent-context "$TPM_DIR/primary.ctx" \
  --key-algorithm "rsa2048:rsassa:null" \
  --hash-algorithm sha256 \
  --public  "$TPM_DIR/signing.pub" \
  --private "$TPM_DIR/signing.priv" \
  2>>"$LOG"
echo "      ✓ signing.pub / signing.priv"

# ── Step 3：載入並持久化 ──────────────────────────────────
echo "[3/5] 載入金鑰並持久化至 $PERSISTENT_HANDLE..."
tpm2_load \
  --parent-context "$TPM_DIR/primary.ctx" \
  --public  "$TPM_DIR/signing.pub" \
  --private "$TPM_DIR/signing.priv" \
  --key-context "$TPM_DIR/signing.ctx" \
  2>>"$LOG"

# 若 Handle 已存在則先清除
tpm2_evictcontrol \
  --hierarchy owner \
  --object-context "$TPM_DIR/signing.ctx" \
  "$PERSISTENT_HANDLE" \
  2>>"$LOG" || true
echo "      ✓ 持久化完成"

# ── Step 4：匯出公鑰 PEM ──────────────────────────────────
echo "[4/5] 匯出公鑰 (PEM)..."
tpm2_readpublic \
  --object-context "$PERSISTENT_HANDLE" \
  --output "$TPM_DIR/signing_public.pem" \
  --format pem \
  2>>"$LOG"
echo "      ✓ signing_public.pem"

# ── Step 5：計算 EK Fingerprint ───────────────────────────
echo "[5/5] 計算 EK Fingerprint..."
tpm2_createek \
  --ek-context "$TPM_DIR/ek.ctx" \
  --key-algorithm rsa \
  2>>"$LOG"

tpm2_readpublic \
  --object-context "$TPM_DIR/ek.ctx" \
  --output "$TPM_DIR/ek_public.pem" \
  --format pem \
  2>>"$LOG"

EK_FINGERPRINT=$(openssl pkey -in "$TPM_DIR/ek_public.pem" -pubin -outform DER 2>/dev/null \
  | sha256sum | awk '{print $1}')

echo "$EK_FINGERPRINT" > "$TPM_DIR/ek_fingerprint.txt"
echo "      ✓ EK Fingerprint: $EK_FINGERPRINT"

# ── 摘要輸出 ──────────────────────────────────────────────
echo ""
echo "======================================"
echo " TPM 初始化完成"
echo "======================================"
echo " EK Fingerprint : $EK_FINGERPRINT"
echo " 公鑰位置       : $TPM_DIR/signing_public.pem"
echo " Persistent Handle : $PERSISTENT_HANDLE"
echo ""
echo " 下一步：將 EK Fingerprint 與公鑰註冊至區塊鏈"
echo " 執行：bash 02_subweb_install.sh"
