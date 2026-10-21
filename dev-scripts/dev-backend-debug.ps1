# Recreate the backend container and follow its logs

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Recreating the backend container..."
docker compose up -d --force-recreate backend
Write-ColorMessage $Colors.Green "Following backend logs (Ctrl+C to stop)..."
docker compose logs -f backend
