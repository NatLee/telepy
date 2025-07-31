# Common PowerShell functions for Telepy development scripts

# Color definitions
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