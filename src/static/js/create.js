
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

      const sshPort = document.getElementById('sshPort').value;

      const tunnelCommand = `autossh \\
  -M 6769 \\
  -o "ServerAliveInterval 15" \\
  -o "ServerAliveCountMax 3" \\
  -p ${data.port} \\
  -NR '*:${data.reverse_port}:localhost:${sshPort}' \\
  telepy@${window.location.hostname}`;

      document.getElementById('tunnelCommand').textContent = tunnelCommand;
      document.getElementById("copyTunnelCommandBtn").disabled = false;
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


function copyToClipboard() {
  const curlCommand = document.getElementById('tunnelCommand').textContent;
  navigator.clipboard.writeText(curlCommand)
      .then(() => {
          Swal.fire({
              icon: 'success',
              title: 'Command copied!',
              showConfirmButton: false,
              timer: 1000
          })
      })
      .catch(error => {
          console.error('Error copying text: ', error);
      });
}

document.addEventListener('DOMContentLoaded', function() {
  fetchToken();
});
