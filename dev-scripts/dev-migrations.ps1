# Reconcile the database schema in the backend container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Reconciling the database schema in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME telepy-server migrate
Write-ColorMessage $Colors.Green "Database schema is up to date."
