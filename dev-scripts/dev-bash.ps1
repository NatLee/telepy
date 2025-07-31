# Execute bash shell in web container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Executing command in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME bash