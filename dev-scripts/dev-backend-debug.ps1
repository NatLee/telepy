# Debug backend by restarting Django development server

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Starting backend debug process..."

# Check if supervisor is running Django
$supervisorStatus = docker exec $CONTAINER_WEB_NAME bash -c "supervisorctl -c /etc/supervisor/conf.d/supervisord.conf status django"

if ($supervisorStatus -match "RUNNING") {
    Write-ColorMessage $Colors.Yellow "Supervisor is running Django, stopping it..."
    docker exec $CONTAINER_WEB_NAME bash -c "supervisorctl -c /etc/supervisor/conf.d/supervisord.conf stop django"
} else {
    Write-ColorMessage $Colors.Yellow "Supervisor is not running Django, checking for manually started Django..."
    $djangoPid = docker exec $CONTAINER_WEB_NAME bash -c "ps aux | grep 'python manage.py runserver' | grep -v grep | awk '{print `$2}'"
    
    if (-not [string]::IsNullOrWhiteSpace($djangoPid)) {
        Write-ColorMessage $Colors.Yellow "Found manually started Django (PID: $djangoPid), stopping it..."
        docker exec $CONTAINER_WEB_NAME bash -c "kill $djangoPid"
    } else {
        Write-ColorMessage $Colors.Yellow "No running Django instance found."
    }
}

Write-ColorMessage $Colors.Blue "Waiting for Django to stop completely..."
Start-Sleep -Seconds 5

Write-ColorMessage $Colors.Green "Starting new Django instance..."
docker exec -it $CONTAINER_WEB_NAME bash -c "python manage.py runserver 0.0.0.0:8000"