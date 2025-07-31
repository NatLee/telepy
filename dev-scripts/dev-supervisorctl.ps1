# Start Supervisor control shell in web container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Starting Supervisor control shell in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME supervisorctl -c /etc/supervisor/conf.d/supervisord.conf