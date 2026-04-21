#!/usr/bin/env bash
# =============================================================
# 04_health_check.sh — 本機健康確認
# 執行：bash 04_health_check.sh
# =============================================================
set -euo pipefail

PORT="${PORT:-3000}"
BASE="http://localhost:${PORT}"

echo "======================================"
echo " HiBA Sub-Web 健康確認"
echo "======================================"

# 1. 服務狀態
echo "[1] systemd 服務狀態："
systemctl is-active hiba-subweb && echo "  ✓ active" || echo "  ✗ inactive"

# 2. /health 端點
echo "[2] /health："
HEALTH=$(curl -sf "${BASE}/health" 2>/dev/null) && \
  echo "$HEALTH" | python3 -m json.tool || echo "  ✗ 無法連線"

# 3. /scripts 端點
echo "[3] /scripts："
SCRIPTS=$(curl -sf "${BASE}/scripts" 2>/dev/null) && \
  echo "$SCRIPTS" | python3 -c "
import json,sys
data = json.load(sys.stdin)
print(f\"  節點 ID : {data.get('nodeId')}\")
for s in data.get('scripts',[]):
    print(f\"  腳本    : {s['name']} — {s.get('description','')}\")
" || echo "  ✗ 無法取得腳本清單"

# 4. TPM 狀態
echo "[4] TPM 狀態："
if tpm2_getcap handles-persistent 2>/dev/null | grep -q "0x81000001"; then
  echo "  ✓ Persistent Handle 0x81000001 存在"
  cat /opt/hiba/tpm/ek_fingerprint.txt 2>/dev/null && echo "  ✓ EK Fingerprint 就緒" || echo "  ⚠ EK Fingerprint 尚未初始化"
else
  echo "  ⚠ TPM Handle 尚未初始化（請先執行 01_tpm_init.sh）"
fi

echo ""
echo "======================================"
echo " 確認完成"
echo "======================================"

#!/usr/bin/env bash
# =============================================================
# 05_register_node.sh — 向 Claw 主控端登錄此節點
# 執行：bash 05_register_node.sh
# =============================================================
# 讀取 .env
set -a
source /opt/hiba/subweb/.env
set +a

SELF_IP=$(hostname -I | awk '{print $1}')
SELF_URL="http://${SELF_IP}:${PORT:-3000}"
EK_FINGERPRINT=$(cat /opt/hiba/tpm/ek_fingerprint.txt 2>/dev/null || echo "no-tpm")
PUBKEY=$(cat /opt/hiba/tpm/signing_public.pem 2>/dev/null | base64 -w 0 || echo "")

echo "======================================"
echo " 向 Claw 登錄節點"
echo " NODE_ID : $NODE_ID"
echo " URL     : $SELF_URL"
echo " Claw    : $CLAW_URL"
echo "======================================"

PAYLOAD=$(python3 -c "
import json
print(json.dumps({
    'nodeId': '${NODE_ID}',
    'url': '${SELF_URL}',
    'ekFingerprint': '${EK_FINGERPRINT}',
    'publicKey': '${PUBKEY}',
    'registeredAt': __import__('datetime').datetime.utcnow().isoformat() + 'Z'
}))
")

RESPONSE=$(curl -sf \
  -X POST "${CLAW_URL}/api/nodes/register" \
  -H "Content-Type: application/json" \
  -d "$PAYLOAD" 2>/dev/null)

if [ $? -eq 0 ]; then
  echo "✓ 登錄成功"
  echo "$RESPONSE" | python3 -m json.tool 2>/dev/null || echo "$RESPONSE"
else
  echo "✗ 登錄失敗（Claw 可能尚未啟動，稍後重試）"
  echo "  手動測試：curl -X POST ${CLAW_URL}/api/nodes/register -H 'Content-Type: application/json' -d '$PAYLOAD'"
fi
