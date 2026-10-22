# Generate SSH keys for Telepy service

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Generating SSH keys for Telepy service..."

# Create directory structure if not exists
if (-not (Test-Path "./ssh/ssh_host_keys")) {
    New-Item -Path "./ssh/ssh_host_keys" -ItemType Directory -Force | Out-Null
}
if (-not (Test-Path "./ssh/backend_ssh_key")) {
    New-Item -Path "./ssh/backend_ssh_key" -ItemType Directory -Force | Out-Null
}

# Check if ssh-keygen is available
if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    Write-ColorMessage $Colors.Red "Error: ssh-keygen not found. Please install OpenSSH or Git for Windows."
    Write-ColorMessage $Colors.Yellow "You can install OpenSSH via: Add-WindowsCapability -Online -Name OpenSSH.Client"
    exit 1
}

try {
    # Host keys for the backend's SSH gateway (ed25519 for modern clients, RSA for old ones)
    Write-ColorMessage $Colors.Yellow "Generating SSH host keys..."
    
    # RSA key
    if (Test-Path "./ssh/ssh_host_keys/ssh_host_rsa_key") {
        Remove-Item "./ssh/ssh_host_keys/ssh_host_rsa_key*" -Force
    }
    & ssh-keygen -f "./ssh/ssh_host_keys/ssh_host_rsa_key" -t rsa -C "root@telepy-ssh" -N '""' -q 2>$null
    
    # ED25519 key
    if (Test-Path "./ssh/ssh_host_keys/ssh_host_ed25519_key") {
        Remove-Item "./ssh/ssh_host_keys/ssh_host_ed25519_key*" -Force
    }
    & ssh-keygen -f "./ssh/ssh_host_keys/ssh_host_ed25519_key" -t ed25519 -C "root@telepy-ssh" -N '""' -q 2>$null

    # Service key: the backend logs in to devices with it (devices add the public half to authorized_keys)
    Write-ColorMessage $Colors.Yellow "Generating backend SSH key..."
    if (Test-Path "./ssh/backend_ssh_key/id_rsa") {
        Remove-Item "./ssh/backend_ssh_key/id_rsa*" -Force
    }
    & ssh-keygen -f "./ssh/backend_ssh_key/id_rsa" -t rsa -C "root@telepy-web" -N '""' -q 2>$null

    Write-ColorMessage $Colors.Green "SSH keys generated successfully."
    
} catch {
    Write-ColorMessage $Colors.Red "Error generating SSH keys: $($_.Exception.Message)"
    exit 1
}