
function fetchToken() {
  // Retrieve the JWT from local storage
  const accessToken = localStorage.getItem('accessToken');
  fetch('/api/reverse/issue/token', {
      method: 'GET',
      headers: {
          'Accept': 'application/json',
          'Authorization': `Bearer ${accessToken}`
      },
  })
  .then(response => response.json())
  .then(data => {
      document.getElementById('token').value = data.token;
  })
  .catch(error => {
      console.error('Error fetching token:', error);
  });
}

function updateTunnelCommands(data) {
  // Update the tunnel command elements
  const sshPort = document.getElementById('sshPort').value;
  const tunnelCommandLinux = `autossh \\
-M 6769 \\
-o "ServerAliveInterval 15" \\
-o "ServerAliveCountMax 3" \\
-o "StrictHostKeyChecking=false" \\
-p ${data.port} \\
-NR '*:${data.reverse_port}:localhost:${sshPort}' \\
telepy@${window.location.hostname}`;

  document.getElementById('tunnelCommandLinux').innerHTML = Prism.highlight(tunnelCommandLinux, Prism.languages.bash, 'bash');

  const tunnelCommandWindows = `$continue = $true
echo "[+] Script started"
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
        # SSH command with proper options for keeping the connection alive
        $sshCommand = 'ssh -o "ServerAliveInterval 15" -o "ServerAliveCountMax 3" -o "StrictHostKeyChecking=false" -p ${data.port} -NR '*:${data.reverse_port}:localhost:${sshPort}' telepy@${window.location.hostname}'
        # Execute SSH command and wait for its completion before restarting
        Invoke-Expression $sshCommand
        
        Write-TimestampedMessage "SSH command exited. Restarting in 5 seconds..."
        Start-Sleep -Seconds 5
    }
} finally {
    # Allow the system to sleep again when exiting the loop
    Prevent-Sleep -Enable $false
    Write-TimestampedMessage "Script exited, sleep prevention disabled."
}
Write-Host "Press any key to continue..."
$Host.UI.RawUI.ReadKey("NoEcho,IncludeKeyDown")`;

  document.getElementById('tunnelCommandWindows').innerHTML = Prism.highlight(tunnelCommandWindows, Prism.languages.powershell, 'powershell');

  // Enable the copy buttons
  document.getElementById("linuxCopyTunnelCommandBtn").disabled = false;
  document.getElementById("windowsCopyTunnelCommandBtn").disabled = false;
}

function createTunnel() {

  const hostname = document.getElementById('hostname').value;
  const key = document.getElementById('key').value;

  // Validate hostname and key fields
  if (!hostname || !key) {
    Swal.fire({
        icon: 'error',
        title: 'Hostname & key are required.',
        showConfirmButton: false,
        timer: 2000
    })
    return;
  }

  if (!isValidSSHKey(key)) {
    Swal.fire({
        icon: 'error',
        title: 'Invalid SSH key.',
        showConfirmButton: false,
        timer: 2000
    })
    return;
  }

  const token = document.getElementById('token').value;
  const apiUrl = `${window.location.protocol}//${window.location.host}/api/reverse/create/key/${token}`;

  const accessToken = localStorage.getItem('accessToken');
  $.ajax({
    url: apiUrl,
    type: 'POST',
    contentType: 'application/json',
    headers: {
        'Authorization': `Bearer ${accessToken}`
    },
    data: JSON.stringify({
        hostname: hostname,
        key: key
    }),
    success: function(data) {
      if (!data.port || !data.reverse_port) {
        Swal.fire({
            icon: 'error',
            title: 'Failed to create tunnel. Please try again.',
            showConfirmButton: false,
            timer: 2000
        })
        return;
      }

      const linuxHintElement = document.getElementById('linuxConnectionHint');
      linuxHintElement.innerHTML = `Use the following AutoSSH command to create a reverse tunnel. Make sure <code>telepy@${window.location.hostname}</code> is accessible with the port of <code>${data.port}</code>. And the port used to reverse in SSH server is <code>${data.reverse_port}</code>.`;

      const windowsHintElement = document.getElementById('windowsConnectionHint');
      windowsHintElement.innerHTML = `Use the following script to create a reverse tunnel. Make sure <code>telepy@${window.location.hostname}</code> is accessible with the port of <code>${data.port}</code>. And the port used to reverse in SSH server is <code>${data.reverse_port}</code>.`;

      updateTunnelCommands(data);

    },
    error: function(error) {
      console.error('Error creating tunnel:', error);
      Swal.fire({
          icon: 'error',
          title: 'Failed to create tunnel. Please try again.',
          showConfirmButton: false,
          timer: 2000
      })
    }
  });
}

function copyCommandToClipboard(commandElementId) {
  const commandText = document.getElementById(commandElementId).innerText;
  navigator.clipboard.writeText(commandText).then(() => {
      Swal.fire({
          title: 'Success!',
          text: 'Command copied to clipboard.',
          icon: 'success',
          timer: 1500,
          showConfirmButton: false
      });
  }).catch(err => {
      console.error('Failed to copy: ', err);
      Swal.fire({
          title: 'Oops!',
          text: 'Unable to copy the command.',
          icon: 'error',
          showConfirmButton: true
      });
  });
}

function fetchUserKeys() {
  const accessToken = localStorage.getItem('accessToken');
  fetch('/api/reverse/user/keys', {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  })
  .then(response => response.json())
  .then(data => {
    const keysContainer = document.getElementById('userKeys');
    let keysHtml = '';
    data.forEach((key, index) => {
      // Button triggers the Bootstrap modal
      keysHtml += `<li>${key.hostname} - <button type="button" class="btn btn-primary" onclick="showKeyModal('${key.key}')">Full Key</button></li>`;
    });
    keysContainer.innerHTML = keysHtml;
  })
  .catch(error => {
    console.error('Error fetching user keys:', error);
  });
}

function fetchServiceKeys() {
  const accessToken = localStorage.getItem('accessToken');
  fetch('/api/reverse/service/keys', {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  })
  .then(response => response.json())
  .then(data => {
    const keysContainer = document.getElementById('serviceKeys');
    let keysHtml = '';
    data.forEach((key, index) => {
      // Button triggers the Bootstrap modal
      keysHtml += `<li>${key.service} - <button type="button" class="btn btn-primary" onclick="showKeyModal('${key.key}')">Full Key</button></li>`;
    });
    keysContainer.innerHTML = keysHtml;
  })
  .catch(error => {
    console.error('Error fetching service keys:', error);
  });
}

function showKeyModal(fullKey) {
  document.getElementById('modalKeyContent').innerText = fullKey;
  $('#keyModal').modal('show');
}

function copyKeyToClipboard() {
  const keyText = document.getElementById('modalKeyContent').value;
  navigator.clipboard.writeText(keyText).then(() => {
    // Show some feedback to the user after copying
    Swal.fire({
      icon: 'success',
      title: 'Key copied!',
      showConfirmButton: false,
      timer: 1000
    });
  }).catch(err => {
    console.error('Error copying text to clipboard', err);
  });
}

document.addEventListener('DOMContentLoaded', function() {
  fetchToken();
  fetchUserKeys();
  fetchServiceKeys();
});
