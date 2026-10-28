# Common PowerShell functions for Telepy development scripts

# Color definitions
$Colors = @{
    Red = "Red"
    Green = "Green"
    Yellow = "Yellow"
    Blue = "Blue"
    White = "White"
}

# Get environment variables
$PROJECT_NAME = $env:PROJECT_NAME
if (-not $PROJECT_NAME) { $PROJECT_NAME = "main" }  # same default as .env.example / docker-compose.yml

# Constant: container names for Telepy
$CONTAINER_WEB_NAME = "telepy-web-$PROJECT_NAME"

# Function to print colored messages
function Write-ColorMessage {
    param(
        [string]$Color,
        [string]$Message
    )
    Write-Host $Message -ForegroundColor $Color
}

# 後端在 /data 底下的路徑對應的主機資料夾（compose 把 ./telepy-data 掛在 /data）；變數沒設 = 預設值。
# Host folder for a backend path under /data (compose mounts ./telepy-data there); an unset variable = the default.
function Get-DataHostDir([string]$Name, [string]$Default) {
    $path = [System.Environment]::GetEnvironmentVariable($Name)
    if (-not $path -or -not $path.Trim()) { $path = $Default }
    $path = $path.Trim()
    if ($path -eq "/data" -or $path.StartsWith("/data/")) { return "./telepy-data" + $path.Substring(5) }
    Write-ColorMessage $Colors.Red "$Name=$path is not under /data (the folder compose mounts from ./telepy-data). Put the files there yourself, or unset $Name."
    return $null
}
