# Execute bash shell in SSH container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Starting SSH shell in $CONTAINER_SSH_NAME..."
docker exec -it $CONTAINER_SSH_NAME bash