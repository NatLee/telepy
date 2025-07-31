# Create new Django app in web container

param(
    [Parameter(Position=0, Mandatory=$true)]
    [string]$AppName
)

# Import common functions
. "$PSScriptRoot/common.ps1"

if ([string]::IsNullOrWhiteSpace($AppName)) {
    Write-ColorMessage $Colors.Red "Error: App name is required."
    Write-ColorMessage $Colors.Yellow "Usage: .\dev-startapp.ps1 <app_name>"
    exit 1
}

Write-ColorMessage $Colors.Blue "Creating new Django app '$AppName' in $CONTAINER_WEB_NAME..."
docker exec -it $CONTAINER_WEB_NAME bash -c "python manage.py startapp $AppName"

if (-not (Test-Path "./src/$AppName")) {
    Write-ColorMessage $Colors.Red "Error: App folder not created."
    exit 1
}

Write-ColorMessage $Colors.Yellow "Adjusting permissions for the new app folder..."

# On Windows, we don't need to change ownership like on Unix systems
# But we can ensure the folder is accessible
try {
    # Get current user
    $currentUser = [System.Security.Principal.WindowsIdentity]::GetCurrent().Name
    
    # Set permissions for current user (Windows equivalent of chmod)
    $acl = Get-Acl "./src/$AppName"
    $accessRule = New-Object System.Security.AccessControl.FileSystemAccessRule($currentUser, "FullControl", "ContainerInherit,ObjectInherit", "None", "Allow")
    $acl.SetAccessRule($accessRule)
    Set-Acl -Path "./src/$AppName" -AclObject $acl
    
    Write-ColorMessage $Colors.Green "Permissions set successfully."
} catch {
    Write-ColorMessage $Colors.Yellow "Warning: Could not set permissions, but app creation succeeded."
}

Write-ColorMessage $Colors.Green "New Django app '$AppName' created successfully."