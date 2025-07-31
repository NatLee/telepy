# Create Django superuser in web container

# Import common functions
. "$PSScriptRoot/common.ps1"

# Function to prompt for input with a default value
function Get-InputWithDefault {
    param(
        [string]$Prompt,
        [string]$Default
    )
    
    $input = Read-Host "$Prompt [$Default]"
    if ([string]::IsNullOrWhiteSpace($input)) {
        return $Default
    }
    return $input
}

# Get user input
$USERNAME = Get-InputWithDefault "Enter username" "admin"
$EMAIL = Get-InputWithDefault "Enter email" "admin@admin.com"
$PASSWORD = Get-InputWithDefault "Enter password" "1234"

# Create superuser
Write-ColorMessage $Colors.Blue "Creating superuser..."
docker exec -it $CONTAINER_WEB_NAME bash -c "DJANGO_SUPERUSER_PASSWORD='$PASSWORD' python manage.py createsuperuser --noinput --username '$USERNAME' --email '$EMAIL'"

Write-ColorMessage $Colors.Green "Superuser created successfully."