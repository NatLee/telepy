# 下載 IEEE 的 OUI 表（網卡廠商，公開資料）到 ./telepy-data/oui/oui.csv；重啟 backend 後生效。
# Download IEEE's public OUI registry into ./telepy-data/oui/oui.csv; restart the backend to load it.

. "$PSScriptRoot/common.ps1"

$Dest = "./telepy-data/oui"
$Url = "https://standards-oui.ieee.org/oui/oui.csv"
New-Item -ItemType Directory -Force -Path $Dest | Out-Null
$Tmp = Join-Path $Dest ".oui.csv.tmp"
Write-ColorMessage $Colors.Blue "Downloading the IEEE OUI registry into $Dest ..."
try {
    Invoke-WebRequest -UseBasicParsing -TimeoutSec 120 -Uri $Url -OutFile $Tmp
    if ((Get-Content $Tmp -TotalCount 1) -like "Registry,Assignment*") {
        Move-Item -Force $Tmp (Join-Path $Dest "oui.csv")
        $count = (Get-Content (Join-Path $Dest "oui.csv")).Count - 1
        Write-ColorMessage $Colors.Green "Done: $count vendors. Restart the backend to load them: docker compose restart backend"
        exit 0
    }
} catch { }
Remove-Item -Force -ErrorAction SilentlyContinue $Tmp
Write-ColorMessage $Colors.Red "Download failed: $Url"
exit 1
