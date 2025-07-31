# Telepy Management Script for Windows PowerShell
param(
    [Parameter(Position=0)]
    [string]$Command,
    
    [Parameter(ValueFromRemainingArguments=$true)]
    [string[]]$Arguments
)

# Load environment variables if .env exists
if (Test-Path ".env") {
    Get-Content ".env" | ForEach-Object {
        if ($_ -match "^([^#=]+)=(.*)$") {
            [System.Environment]::SetEnvironmentVariable($matches[1], $matches[2], "Process")
        }
    }
}

# Color definitions for Write-Host
$Colors = @{
    Red = "Red"
    Green = "Green"
    Yellow = "Yellow"
    Blue = "Blue"
    White = "White"
}

# Get environment variables
$PROJECT_NAME = $env:PROJECT_NAME
if (-not $PROJECT_NAME) { $PROJECT_NAME = "default" }

# Constant: container names for Telepy
$CONTAINER_WEB_NAME = "telepy-web-$PROJECT_NAME"
$CONTAINER_SSH_NAME = "telepy-ssh-$PROJECT_NAME"

# Function to print colored messages
function Write-ColorMessage {
    param(
        [string]$Color,
        [string]$Message
    )
    Write-Host $Message -ForegroundColor $Color
}

# Function to execute scripts
function Invoke-DevScript {
    param(
        [string]$ScriptName,
        [string[]]$ScriptArguments
    )
    
    $ps1Script = "./dev-scripts/$ScriptName.ps1"
    $batScript = "./dev-scripts/$ScriptName.bat"
    $shScript = "./dev-scripts/$ScriptName.sh"
    
    if (Test-Path $ps1Script) {
        & $ps1Script @ScriptArguments
    } elseif (Test-Path $batScript) {
        & cmd /c "$batScript $($ScriptArguments -join ' ')"
    } elseif (Test-Path $shScript) {
        if (Get-Command bash -ErrorAction SilentlyContinue) {
            & bash $shScript @ScriptArguments
        } else {
            Write-ColorMessage $Colors.Red "Error: Neither PowerShell script nor bash found for $ScriptName"
            exit 1
        }
    } else {
        Write-ColorMessage $Colors.Red "Error: Script $ScriptName not found."
        exit 1
    }
}

# Main script logic
switch ($Command) {
    "keygen" {
        Invoke-DevScript "dev-keygen" $Arguments
        break
    }
    "create-superuser" {
        Invoke-DevScript "dev-create-superuser" $Arguments
        break
    }
    "shell" {
        Write-ColorMessage $Colors.Yellow "Starting Web Server container shell..."
        Invoke-DevScript "dev-bash" $Arguments
        break
    }
    "ipython" {
        Invoke-DevScript "dev-shell" $Arguments
        break
    }
    "supervisorctl" {
        Invoke-DevScript "dev-supervisorctl" $Arguments
        break
    }
    "ssh-shell" {
        Write-ColorMessage $Colors.Yellow "Starting SSH container shell..."
        Invoke-DevScript "dev-ssh-bash" $Arguments
        break
    }
    "migration" {
        Invoke-DevScript "dev-migrations" $Arguments
        break
    }
    "backend-debug" {
        Invoke-DevScript "dev-backend-debug" $Arguments
        break
    }
    "collect-static" {
        Invoke-DevScript "dev-collect-statics" $Arguments
        break
    }
    "django-startapp" {
        Invoke-DevScript "dev-startapp" $Arguments
        break
    }
    default {
        Write-ColorMessage $Colors.Yellow "Usage: .\telepy.ps1 <sub-command> [args]"
        Write-ColorMessage $Colors.Blue "Sub-commands:"
        Write-ColorMessage $Colors.Blue "Backend Development:"
        Write-ColorMessage $Colors.Green "  keygen: Generate SSH keys for Telepy service."
        Write-ColorMessage $Colors.Green "  create-superuser: Create an admin account for Telepy management."
        Write-ColorMessage $Colors.Green "  shell: Create a shell to run arbitrary command."
        Write-ColorMessage $Colors.Green "  ipython: Create a shell to run ipython."
        Write-ColorMessage $Colors.Green "  supervisorctl: Attach to supervisor control shell."
        Write-ColorMessage $Colors.Green "  ssh-shell: Similar to 'shell', but for ssh container."
        Write-ColorMessage $Colors.Green "  migration: Run migration process."
        Write-ColorMessage $Colors.Green "  backend-debug: Recreate and attach to backend container."
        Write-ColorMessage $Colors.Green "  collect-static: Collect static files to increase rendering speed."
        Write-ColorMessage $Colors.Green "  django-startapp: Create a new Django app."
        break
    }
}