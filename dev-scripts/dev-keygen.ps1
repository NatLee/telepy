# Generate SSH keys for Telepy service

# Import common functions
. "$PSScriptRoot/common.ps1"

Write-ColorMessage $Colors.Blue "Generating SSH keys for Telepy service..."

# Create directory structure if not exists
if (-not (Test-Path "./ssh/root_ssh_key")) {
    New-Item -Path "./ssh/root_ssh_key" -ItemType Directory -Force | Out-Null
}
if (-not (Test-Path "./ssh/ssh_host_keys")) {
    New-Item -Path "./ssh/ssh_host_keys" -ItemType Directory -Force | Out-Null
}
if (-not (Test-Path "./ssh/backend_ssh_key")) {
    New-Item -Path "./ssh/backend_ssh_key" -ItemType Directory -Force | Out-Null
}

# Create placeholder for authorized keys
if (Test-Path "./ssh/root_ssh_key/authorized_keys") {
    Remove-Item "./ssh/root_ssh_key/authorized_keys" -Force
}
New-Item -Path "./ssh/root_ssh_key/authorized_keys" -ItemType File -Force | Out-Null

# Check if ssh-keygen is available
if (-not (Get-Command ssh-keygen -ErrorAction SilentlyContinue)) {
    Write-ColorMessage $Colors.Red "Error: ssh-keygen not found. Please install OpenSSH or Git for Windows."
    Write-ColorMessage $Colors.Yellow "You can install OpenSSH via: Add-WindowsCapability -Online -Name OpenSSH.Client"
    exit 1
}

try {
    # Generate keys for outside server
    Write-ColorMessage $Colors.Yellow "Generating SSH host keys..."
    
    # DSA key
    if (Test-Path "./ssh/ssh_host_keys/ssh_host_dsa_key") {
        Remove-Item "./ssh/ssh_host_keys/ssh_host_dsa_key*" -Force
    }
    & ssh-keygen -f "./ssh/ssh_host_keys/ssh_host_dsa_key" -t dsa -C "root@telepy-ssh" -N '""' -q 2>$null
    
    # RSA key
    if (Test-Path "./ssh/ssh_host_keys/ssh_host_rsa_key") {
        Remove-Item "./ssh/ssh_host_keys/ssh_host_rsa_key*" -Force
    }
    & ssh-keygen -f "./ssh/ssh_host_keys/ssh_host_rsa_key" -t rsa -C "root@telepy-ssh" -N '""' -q 2>$null
    
    # ECDSA key
    if (Test-Path "./ssh/ssh_host_keys/ssh_host_ecdsa_key") {
        Remove-Item "./ssh/ssh_host_keys/ssh_host_ecdsa_key*" -Force
    }
    & ssh-keygen -f "./ssh/ssh_host_keys/ssh_host_ecdsa_key" -t ecdsa -C "root@telepy-ssh" -N '""' -q 2>$null
    
    # ED25519 key
    if (Test-Path "./ssh/ssh_host_keys/ssh_host_ed25519_key") {
        Remove-Item "./ssh/ssh_host_keys/ssh_host_ed25519_key*" -Force
    }
    & ssh-keygen -f "./ssh/ssh_host_keys/ssh_host_ed25519_key" -t ed25519 -C "root@telepy-ssh" -N '""' -q 2>$null

    # Generate keys for backend
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