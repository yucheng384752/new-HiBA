#!/usr/bin/env python3
"""
system.probeCapabilities.py — HiBA-AB 節點算力探測腳本
=====================================================
由 Accounting Server 透過 POST /execute 觸發，對應 A3 資源決策的 Phase 2。

輸入（sys.argv[1]，JSON）：
  { "clawIp": "192.168.50.1" }  ← 可選，用於量測網路延遲

輸出（stdout，JSON）：
  NodeCapabilities 物件（見下方 schema）

用途：
  - Accounting Server 根據 memFreeMB 分類節點 profile
  - canInstall() 六條件的資料來源
  - 寫入 TrustRegistry.capabilities 欄位
"""

import sys
import json
import os
import subprocess
import socket
import platform
import re
from datetime import datetime, timezone


# ── 工具函數 ────────────────────────────────────────────────────────────────

def run(cmd, timeout=5):
    """執行 shell 指令，回傳 stdout 字串，失敗回傳空字串"""
    try:
        result = subprocess.run(
            cmd, shell=True, capture_output=True, text=True, timeout=timeout
        )
        return result.stdout.strip()
    except Exception:
        return ""


def run_version(cmd):
    """執行版本查詢，回傳版本字串，不存在回傳 'none'"""
    out = run(cmd + " 2>/dev/null || echo none")
    if not out or out == "none":
        return "none"
    # 取第一個版本號（e.g. "Python 3.11.2" → "3.11.2"）
    match = re.search(r'[\d]+\.[\d]+[\.\d]*', out)
    return match.group(0) if match else out.split()[-1]


# ── 1. 硬體資源 ─────────────────────────────────────────────────────────────

def probe_hardware():
    cores = int(run("nproc") or "1")

    # RAM
    mem_total = mem_free = 0
    try:
        with open("/proc/meminfo") as f:
            for line in f:
                if line.startswith("MemTotal:"):
                    mem_total = int(line.split()[1]) // 1024
                elif line.startswith("MemAvailable:"):
                    mem_free = int(line.split()[1]) // 1024
    except Exception:
        pass

    # 磁碟（根分割區）
    disk_free = 0
    try:
        st = os.statvfs("/")
        disk_free = (st.f_bavail * st.f_frsize) // (1024 * 1024)
    except Exception:
        pass

    # CPU 負載（1 分鐘）
    cpu_load = 0.0
    try:
        with open("/proc/loadavg") as f:
            cpu_load = float(f.read().split()[0])
    except Exception:
        pass

    # CPU 型號（Raspberry Pi 特有路徑）
    cpu_model = run("cat /proc/cpuinfo | grep 'Model name\\|Hardware\\|Model' | head -1 | cut -d: -f2").strip()
    if not cpu_model:
        cpu_model = platform.processor() or "unknown"

    return {
        "cores":      cores,
        "memTotalMB": mem_total,
        "memFreeMB":  mem_free,
        "diskFreeMB": disk_free,
        "cpuLoad1m":  cpu_load,
        "cpuModel":   cpu_model,
    }


# ── 2. 執行環境偵測 ─────────────────────────────────────────────────────────

def probe_runtimes():
    return {
        "nodejs":     run_version("node --version"),
        "python3":    run_version("python3 --version"),
        "bash":       run_version("bash --version | head -1"),
        "powershell": "none",  # Linux 節點固定 none
    }


# ── 3. 套件管理器 ───────────────────────────────────────────────────────────

def probe_package_managers():
    mgrs = []
    for cmd in ["apt-get", "pip3", "npm"]:
        if run(f"command -v {cmd}"):
            mgrs.append(cmd)
    return mgrs


# ── 4. sudo 能力（非互動式）────────────────────────────────────────────────

def probe_sudo():
    try:
        result = subprocess.run(
            ["sudo", "-n", "true"],
            capture_output=True, timeout=3
        )
        return result.returncode == 0
    except FileNotFoundError:
        return False
    except Exception:
        return False


# ── 5. 網路能力 ─────────────────────────────────────────────────────────────

def probe_network(claw_ip: str):
    # Claw 主控端延遲
    latency_ms = -1
    out = run(f"ping -c 3 -W 2 {claw_ip} 2>/dev/null | grep rtt", timeout=10)
    if out:
        match = re.search(r'[\d.]+/[\d.]+/([\d.]+)', out)
        if match:
            latency_ms = int(float(match.group(1)))

    # 外網連線（測試 DNS）
    has_internet = False
    try:
        socket.setdefaulttimeout(3)
        socket.socket(socket.AF_INET, socket.SOCK_STREAM).connect(("8.8.8.8", 53))
        has_internet = True
    except Exception:
        pass

    return {
        "clawLatencyMs":  latency_ms,
        "hasInternet":    has_internet,
    }


# ── 6. TPM 狀態 ─────────────────────────────────────────────────────────────

def probe_tpm():
    # 硬體 TPM
    hw_tpm = os.path.exists("/dev/tpm0") or os.path.exists("/dev/tpmrm0")

    # swtpm（軟體模擬）
    import subprocess as sp
    sw_tpm = False
    try:
        r = sp.run(["ss", "-tlnp"], capture_output=True, text=True, timeout=3)
        sw_tpm = ":2321" in r.stdout
    except Exception:
        pass

    tpm_available = hw_tpm or sw_tpm

    # Persistent Handle
    handle_exists = False
    ek_fingerprint = ""
    if tpm_available:
        handles = run("tpm2_getcap handles-persistent 2>/dev/null", timeout=5)
        handle_exists = "0x81000001" in handles
        try:
            fp_path = "/opt/hiba/tpm/ek_fingerprint.txt"
            if os.path.exists(fp_path):
                with open(fp_path) as f:
                    ek_fingerprint = f.read().strip()
        except Exception:
            pass

    return {
        "available":     tpm_available,
        "hardwareTpm":   hw_tpm,
        "softwareTpm":   sw_tpm,
        "handleExists":  handle_exists,
        "ekFingerprint": ek_fingerprint,
    }


# ── 7. GPU 偵測 ─────────────────────────────────────────────────────────────

def probe_gpu():
    # VideoCore（RPi 內建 GPU）
    vc = run("vcgencmd version 2>/dev/null | head -1")
    if vc:
        mem = run("vcgencmd get_mem gpu 2>/dev/null | cut -d= -f2")
        return {"available": True, "model": "VideoCore (RPi)", "gpuMemory": mem}

    # NVIDIA（CUDA 環境）
    nvidia = run("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null | head -1")
    if nvidia:
        return {"available": True, "model": nvidia, "gpuMemory": ""}

    return {"available": False, "model": "none", "gpuMemory": ""}


# ── 8. 節點識別 ─────────────────────────────────────────────────────────────

def probe_identity():
    hostname = socket.gethostname()
    ip = run("hostname -I | awk '{print $1}'") or "unknown"

    # MAC（優先 eth0，fallback wlan0）
    mac = "unknown"
    for iface in ["eth0", "wlan0", "end0"]:
        path = f"/sys/class/net/{iface}/address"
        if os.path.exists(path):
            with open(path) as f:
                mac = f.read().strip()
            break

    arch = platform.machine()    # aarch64 / x86_64
    plat = platform.system().lower()  # linux

    return {
        "hostname": hostname,
        "ip":       ip,
        "mac":      mac,
        "arch":     arch,
        "platform": plat,
    }


# ── 9. 節點 Profile 分類 ────────────────────────────────────────────────────

def classify_profile(mem_free_mb: int, gpu_available: bool) -> str:
    """
    minimal  : memFree < 256 MB  → bash only
    standard : memFree < 3000 MB → bash + python3 + nodejs（RPi 4 預期落此）
    capable  : memFree ≥ 3000 MB 且有 GPU → LLM 推論可用
    """
    if mem_free_mb < 256:
        return "minimal"
    if mem_free_mb < 3000 or not gpu_available:
        return "standard"
    return "capable"


# ── 主程式 ──────────────────────────────────────────────────────────────────

def main():
    params = {}
    if len(sys.argv) > 1:
        try:
            params = json.loads(sys.argv[1])
        except json.JSONDecodeError:
            pass

    claw_ip = params.get("clawIp", "192.168.50.1")

    hw       = probe_hardware()
    runtimes = probe_runtimes()
    pkgmgrs  = probe_package_managers()
    has_sudo = probe_sudo()
    network  = probe_network(claw_ip)
    tpm      = probe_tpm()
    gpu      = probe_gpu()
    identity = probe_identity()

    node_profile = classify_profile(hw["memFreeMB"], gpu["available"])

    result = {
        "success": True,

        # ── 識別 ──────────────────────────────────────────
        **identity,

        # ── 硬體資源 ──────────────────────────────────────
        **hw,

        # ── 執行環境 ──────────────────────────────────────
        "runtimes":        runtimes,
        "packageManagers": pkgmgrs,
        "hasSudo":         has_sudo,

        # ── 網路 ──────────────────────────────────────────
        **network,

        # ── 硬體加速 ──────────────────────────────────────
        "tpm": tpm,
        "gpu": gpu,

        # ── 分類結果（A3 canInstall 使用）────────────────
        "nodeProfile": node_profile,

        # ── 元資料 ────────────────────────────────────────
        "probedAt":    datetime.now(timezone.utc).isoformat().replace("+00:00", "Z"),
        "renderHint":  "table",
    }

    print(json.dumps(result, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({
            "success": False,
            "error": str(e),
            "renderHint": "text"
        }), file=sys.stderr)
        sys.exit(1)