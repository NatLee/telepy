# Collect static files in web container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Collecting static files in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME bash -c "python manage.py collectstatic --noinput"
Write-ColorMessage $Colors.Green "Static files collected successfully."