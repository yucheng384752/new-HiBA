# Runs v1c2 LoRA training as a genuinely OS-level independent process via
# Windows Task Scheduler -- NOT tied to any AI agent session (Claude Code or
# Codex's sandbox), after both hit environment walls documented in
# plan_LLM_訓練清單.md (§十四-§二十): Codex's sandbox denies filesystem access
# outside the repo working directory (interpreter, site-packages) AND denies
# writable temp directories entirely, even inside the working directory --
# not fixable by relocating files, since tempfile access itself is blocked.
#
# Uses the self-contained standalone Python + site-packages copy under
# .local-tools/ (verified working, same one built for the Codex attempts) so
# this doesn't depend on the Windows Store Python app-execution alias either
# (that alias is known to fail under non-interactive/service-style logon
# contexts -- the first blocker Codex hit).

$ErrorActionPreference = 'Stop'
$repoRoot = 'C:\Users\gslab\Desktop\files'
$hibaCore = Join-Path $repoRoot 'hiba-core'
Set-Location $hibaCore

$py = Join-Path $repoRoot '.local-tools\python313\python.exe'
$sitePackages = Join-Path $repoRoot '.local-tools\site-packages'
$launchLog = Join-Path $hibaCore 'training\v1c2_task_launch.log'
$trainLog = Join-Path $hibaCore 'training\pipeline_run_v1c2_task.log'
$gpuCsv = Join-Path $hibaCore 'training\gpu-watch-v1c2-task.csv'
$deathEventsCsv = Join-Path $hibaCore 'training\v1c2_task_death_events.csv'

function Log($msg) {
    "$(Get-Date -Format o) $msg" | Out-File $launchLog -Append -Encoding utf8
}

Log "=== v1c2 scheduled task starting ==="

# 1. Clean environment: stop Ollama, including its tray app (ollama app.exe
#    auto-restarts "ollama serve" if only the server is killed -- both must go).
Get-Process -Name 'ollama app' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-Process -Name 'ollama' -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Seconds 2
$ollamaLeft = Get-Process -Name 'ollama', 'ollama app' -ErrorAction SilentlyContinue
if ($ollamaLeft) { Log "WARNING: Ollama process still present after stop attempt: $($ollamaLeft.Id -join ',')" }
else { Log "Ollama confirmed stopped." }

# 2. Refuse to launch a second training process on top of an existing one
#    (past incident in this project: an accidental double-launch wasted GPU
#    resources on two concurrent training runs).
$existing = Get-CimInstance Win32_Process -Filter "Name LIKE '%python%'" |
    Where-Object { $_.CommandLine -match 'run_train\.py' }
if ($existing) {
    Log "ABORT: existing training process already running (PID $($existing.ProcessId -join ',')). Not launching a second one."
    exit 1
}

# 3. Start GPU telemetry logging as a detached background job, independent of
#    this script's own process lifetime (survives whether or not the parent
#    task process itself is still being watched by anyone).
Start-Job -Name 'v1c2-gpu-telemetry' -ScriptBlock {
    param($csvPath)
    nvidia-smi --query-gpu=timestamp,temperature.gpu,power.draw,clocks.sm,clocks.mem,memory.used,utilization.gpu --format=csv -l 5 | Out-File $csvPath -Encoding utf8
} -ArgumentList $gpuCsv | Out-Null
Start-Sleep -Seconds 6
if ((Test-Path $gpuCsv) -and (Get-Content $gpuCsv -ErrorAction SilentlyContinue).Count -gt 1) {
    Log "GPU telemetry confirmed capturing data at $gpuCsv"
} else {
    Log "WARNING: GPU telemetry file not yet showing data -- continuing anyway, but this monitoring may not be reliable."
}

# 4. Launch training and block until it exits (crash or completion).
$env:PYTHONPATH = $sitePackages
$env:PYTHONUTF8 = '1'
$env:PYTHONIOENCODING = 'utf-8'
$env:PYTHONUNBUFFERED = '1'
Log "Launching training: $py -u training/run_train.py training/train_config_v1c2.yaml"
& $py -u training/run_train.py training/train_config_v1c2.yaml *> $trainLog
$exitCode = $LASTEXITCODE
Log "Training process exited with code $exitCode"

# 5. Whether this was a crash or a genuine completion, capture whatever
#    diagnostic trail is available right now -- this is the whole point of
#    moving execution here: every prior attempt (§14.10, §十九) lost this
#    window because the monitoring itself died with (or before) the training
#    process. This step runs unconditionally, immediately after exit.
try {
    Get-WinEvent -FilterHashtable @{LogName = 'System'; StartTime = (Get-Date).AddHours(-3) } -ErrorAction SilentlyContinue |
        Where-Object { $_.LevelDisplayName -in @('Error', 'Critical') } |
        Select-Object TimeCreated, ProviderName, Id, LevelDisplayName, Message |
        Export-Csv $deathEventsCsv -NoTypeInformation -Encoding utf8
    Log "Captured System event log errors/criticals from the last 3 hours to $deathEventsCsv"
} catch {
    Log "Failed to capture Windows event log snapshot: $_"
}

Stop-Job -Name 'v1c2-gpu-telemetry' -ErrorAction SilentlyContinue | Out-Null
Receive-Job -Name 'v1c2-gpu-telemetry' -ErrorAction SilentlyContinue | Out-Null
Remove-Job -Name 'v1c2-gpu-telemetry' -ErrorAction SilentlyContinue | Out-Null

Log "=== v1c2 scheduled task finished (exit code $exitCode) ==="
