# PowerShell script

echo "[+] SSH Script start"

### Configuration

# The {server_domain} is a placeholder for template rendering.
$sshUserHost = "telepy@${server_domain}"    

# The {reverse_port} and ${ssh_port} are placeholders for template rendering.
$sshRemoteForward = "*:${reverse_port}:localhost:${ssh_port}"

# The {reverse_server_ssh_port} is a placeholder for template rendering.
$reverseServerSSHPort = "${reverse_server_ssh_port}"

$sshOptions = "${key_option}-o ServerAliveInterval=15 -o ServerAliveCountMax=3 -o StrictHostKeyChecking=no"
$sshCommand = "ssh $sshOptions -p $reverseServerSSHPort -NR $sshRemoteForward $sshUserHost"

# Add-Type for PowerManagement to prevent sleep
Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class PowerManagement {
    [DllImport("kernel32.dll", CharSet = CharSet.Auto, SetLastError = true)]
    public static extern uint SetThreadExecutionState(uint esFlags);
    public const uint ES_CONTINUOUS = 0x80000000;
    public const uint ES_SYSTEM_REQUIRED = 0x00000001;
    public const uint ES_DISPLAY_REQUIRED = 0x00000002;
}
"@

# Function to write messages with timestamp
function Write-TimestampedMessage {
    param([string]$Message)
    $timestamp = Get-Date -Format "yyyy-MM-dd HH:mm:ss"
    echo "[$timestamp] $Message"
}

# Function to enable or disable sleep prevention
function Prevent-Sleep {
    param([bool]$Enable)
    if ($Enable) {
        [PowerManagement]::SetThreadExecutionState([PowerManagement]::ES_CONTINUOUS -bor [PowerManagement]::ES_SYSTEM_REQUIRED -bor [PowerManagement]::ES_DISPLAY_REQUIRED)
        Write-TimestampedMessage "Sleep prevention activated."
    } else {
        [PowerManagement]::SetThreadExecutionState([PowerManagement]::ES_CONTINUOUS)
        Write-TimestampedMessage "Sleep prevention deactivated."
    }
}

# Prevent sleep initially
Prevent-Sleep -Enable $true

try {
    while ($true) {
        Write-TimestampedMessage "Starting SSH Reverse Tunnel."
        try {
            Invoke-Expression $sshCommand
        } catch {
            Write-TimestampedMessage "Error executing SSH command: $_"
        }
        Write-TimestampedMessage "SSH command exited. Restarting in 5 seconds..."
        Start-Sleep -Seconds 5
    }
} finally {
    Prevent-Sleep -Enable $false
    Write-TimestampedMessage "Sleep prevention disabled."
    echo "[+] Script end"
    Write-Host "Press any key to continue..."
    $Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")
}