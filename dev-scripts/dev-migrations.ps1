# Run database migrations in web container

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Running database migrations in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME bash -c 'python manage.py makemigrations && python manage.py migrate'
Write-ColorMessage $Colors.Green "Database migrations completed."