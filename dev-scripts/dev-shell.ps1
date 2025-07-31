# Start IPython shell in web container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Starting IPython shell in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME bash -c 'python manage.py shell'