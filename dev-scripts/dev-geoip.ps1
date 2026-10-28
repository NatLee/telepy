# Download the DB-IP Lite country + ASN databases (CC BY 4.0) into ./telepy-data/geoip (/data/geoip in the
# container, the default GEOIP_DIR; a GEOIP_DIR elsewhere under /data moves it to the matching ./telepy-data
# folder). The backend reads them at startup; lookups never leave the server.

. "$PSScriptRoot/common.ps1"

$Dest = Get-DataHostDir "GEOIP_DIR" "/data/geoip"
if (-not $Dest) { exit 1 }
New-Item -Path $Dest -ItemType Directory -Force | Out-Null

function Get-DbipDatabase([string]$Kind) {
    $now = (Get-Date).ToUniversalTime()
    foreach ($month in @($now.ToString("yyyy-MM"), $now.AddMonths(-1).ToString("yyyy-MM"))) {
        $url = "https://download.db-ip.com/free/dbip-$Kind-lite-$month.mmdb.gz"
        $gz = Join-Path $Dest ".dbip-$Kind-lite.mmdb.gz"
        $tmp = Join-Path $Dest ".dbip-$Kind-lite.mmdb.tmp"
        try {
            Invoke-WebRequest -Uri $url -OutFile $gz -UseBasicParsing -ErrorAction Stop
            $in = [System.IO.File]::OpenRead($gz)
            $out = [System.IO.File]::Create($tmp)
            $gzip = New-Object System.IO.Compression.GzipStream($in, [System.IO.Compression.CompressionMode]::Decompress)
            $gzip.CopyTo($out)
            $gzip.Dispose(); $out.Dispose(); $in.Dispose()
            Move-Item -Force $tmp (Join-Path $Dest "dbip-$Kind-lite.mmdb")
            Remove-Item -Force $gz
            Write-ColorMessage $Colors.Green "  ${Kind}: $month"
            return $true
        } catch {
            Remove-Item -Force -ErrorAction SilentlyContinue $gz, $tmp
        }
    }
    Write-ColorMessage $Colors.Red "  ${Kind}: download failed"
    return $false
}

Write-ColorMessage $Colors.Blue "Downloading DB-IP Lite databases into $Dest ..."
$country = Get-DbipDatabase "country"
$asn = Get-DbipDatabase "asn"
$ok = $country -and $asn
if ($ok) {
    Write-ColorMessage $Colors.Green "Done. Restart the backend to load them: docker compose restart backend"
    Write-ColorMessage $Colors.Yellow "IP geolocation by DB-IP (https://db-ip.com), CC BY 4.0. Re-run monthly for fresh data."
} else {
    exit 1
}
