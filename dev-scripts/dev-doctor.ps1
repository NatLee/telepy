# 主機端健康檢查：.env、容器、對外的網頁與 gateway 埠，再跑後端容器裡的 `telepy-server doctor`。
# Host-side health check: .env, containers, the published web and gateway ports, then the in-container doctor.

. "$PSScriptRoot/common.ps1"

$script:Failed = $false
function Ok($m)   { Write-Host "  ✓ $m" -ForegroundColor Green }
function Warn($m) { Write-Host "  ! $m" -ForegroundColor Yellow }
function Fail($m) { Write-Host "  ✗ $m" -ForegroundColor Red; $script:Failed = $true }

Write-ColorMessage $Colors.Blue "Host"
if (Test-Path .env) { Ok ".env found" } else { Fail ".env is missing (copy .env.example)" }
foreach ($var in "PROJECT_NAME", "WEB_SERVER_PORT", "REVERSE_SERVER_SSH_PORT", "SERVER_DOMAIN") {
    $v = [Environment]::GetEnvironmentVariable($var)
    if ($v) { Ok "$var=$v" } else { Fail "$var is empty in .env" }
}
if (-not $env:SECRET_KEY) { Warn "SECRET_KEY is empty: the legacy default signs login tokens" } else { Ok "SECRET_KEY is set" }
if (-not $env:INTERNAL_API_TOKEN) { Warn "INTERNAL_API_TOKEN is empty" } else { Ok "INTERNAL_API_TOKEN is set" }
foreach ($f in "ssh/ssh_host_keys/ssh_host_ed25519_key", "ssh/backend_ssh_key/id_rsa", "ssh/backend_ssh_key/id_rsa.pub") {
    if (Test-Path $f) { Ok $f } else { Fail "$f is missing (run ./telepy.ps1 keygen)" }
}

Write-ColorMessage $Colors.Blue "Containers"
docker info *> $null
if ($LASTEXITCODE -ne 0) {
    Fail "cannot talk to Docker"
} else {
    $rows = docker compose ps --format '{{.Service}} {{.State}} {{.Health}}' 2>$null
    foreach ($svc in "traefik", "frontend", "backend", "kasm-browser", "guacd") {
        $row = $rows | Where-Object { ($_ -split ' ')[0] -eq $svc } | Select-Object -First 1
        if (-not $row) {
            if ($svc -eq "guacd") { Warn "guacd is not running (remote desktop will not work)" } else { Fail "$svc is not running" }
        } elseif ($row -match "running") { Ok "$svc running" } else { Fail $row }
    }
}

Write-ColorMessage $Colors.Blue "Network"
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 5 "http://localhost:$($env:WEB_SERVER_PORT)/api/auth/setup-status" | Out-Null
    Ok "web UI and API answer on :$($env:WEB_SERVER_PORT)"
} catch { Fail "nothing answers on http://localhost:$($env:WEB_SERVER_PORT)/api/auth/setup-status" }
$tcp = Test-NetConnection -ComputerName localhost -Port $env:REVERSE_SERVER_SSH_PORT -WarningAction SilentlyContinue
if ($tcp.TcpTestSucceeded) { Ok "SSH gateway port :$($env:REVERSE_SERVER_SSH_PORT) is open" } else { Fail "the SSH gateway port :$($env:REVERSE_SERVER_SSH_PORT) is closed" }

Write-ColorMessage $Colors.Blue "Backend (inside $CONTAINER_WEB_NAME)"
docker exec $CONTAINER_WEB_NAME telepy-server doctor
if ($LASTEXITCODE -eq 1) { $script:Failed = $true }
elseif ($LASTEXITCODE -ne 0) { Fail "could not run telepy-server doctor (exit $LASTEXITCODE); rebuild the backend image if it is older than this script" }

Write-Host ""
if ($script:Failed) { Write-ColorMessage $Colors.Red "Something needs fixing (✗ above)."; exit 1 }
Write-ColorMessage $Colors.Green "Nothing is broken. Warnings (!) are worth a look."
