document.addEventListener('DOMContentLoaded', function() {
  fetchToken();
  validateInputs();
  autoFillHostFriendlyName();

  document.getElementById('createTunnelForm').addEventListener('submit', function(e) {
    e.preventDefault();
    createTunnel();
  });

  document.getElementById('tunnelVerifiedBtn').addEventListener('click', function() {
    showStep3();
  });

  document.getElementById('goToIndexBtn').addEventListener('click', function() {
    window.location.href = '/tunnels/index';
  });
});

function fetchToken() {
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
  const hostFriendlyName = document.getElementById('hostFriendlyName').value;
  const key = document.getElementById('key').value;
  const sshPort = document.getElementById('sshPort').value;
  const token = document.getElementById('token').value;

  if (!hostFriendlyName || !key || !isValidSSHKey(key) || !isValidPort(sshPort)) {
    Swal.fire({
      icon: 'error',
      title: 'Invalid Input',
      text: 'Please check your inputs and try again.',
      showConfirmButton: true,
    });
    return;
  }

  // Show loading indicator
  Swal.fire({
    title: 'Creating Tunnel...',
    text: 'Please wait',
    allowOutsideClick: false,
    showConfirmButton: false,
    willOpen: () => {
      Swal.showLoading();
    }
  });

  const accessToken = localStorage.getItem('accessToken');
  fetch('/api/reverse/create/key/' + token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      host_friendly_name: hostFriendlyName,
      key: key,
      ssh_port: sshPort
    })
  })
  .then(response => {
    return response.json().then(data => {
      if (!response.ok) {
        throw new Error(data.error || `HTTP error! status: ${response.status}`);
      }
      return data;
    });
  })
  .then(data => {
    if (data.port && data.reverse_port) {
      Swal.fire({
        icon: 'success',
        title: 'Tunnel Created Successfully',
        text: `Port: ${data.port}, Reverse Port: ${data.reverse_port}`,
        showConfirmButton: true,
      }).then((result) => {
        if (result.isConfirmed) {
          showStep2();
        }
      });
    } else {
      throw new Error('Failed to create tunnel - ' + (data.error || 'Unknown error'));
    }
  })
  .catch(error => {
    console.error('Error creating tunnel:', error);
    
    let errorMessage = 'An error occurred while creating the tunnel.';
    let detailedError = error.message;

    Swal.fire({
      icon: 'error',
      title: 'Failed to Create Tunnel',
      text: errorMessage,
      showConfirmButton: true,
      showCancelButton: true,
      confirmButtonText: 'View Details',
      cancelButtonText: 'Close'
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({
          icon: 'info',
          title: 'Error Details',
          text: detailedError,
          showConfirmButton: true
        });
      }
    });
  });
}

function showStep2() {
  document.getElementById('step1Section').style.display = 'none';
  document.getElementById('step2Section').style.display = 'block';
  fetchUserKeys();
  fetchServiceKeys();
}

function showStep3() {
  document.getElementById('step2Section').style.display = 'none';
  document.getElementById('step3Section').style.display = 'block';
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
    let keysHtml = '<ul>';
    data.forEach((key) => {
      keysHtml += `<li>${key.host_friendly_name} - <button type="button" class="btn btn-sm btn-primary" onclick="showKeyModal('${key.key}')">View Key</button></li>`;
    });
    keysHtml += '</ul>';
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
    let keysHtml = '<ul>';
    data.forEach((key) => {
      keysHtml += `<li>${key.service} - <button type="button" class="btn btn-sm btn-primary" onclick="showKeyModal('${key.key}')">View Key</button></li>`;
    });
    keysHtml += '</ul>';
    keysContainer.innerHTML = keysHtml;
  })
  .catch(error => {
    console.error('Error fetching service keys:', error);
  });
}

function showKeyModal(fullKey) {
  document.getElementById('modalKeyContent').value = fullKey;
  new bootstrap.Modal(document.getElementById('keyModal')).show();
}

function copyKeyToClipboard() {
  const keyText = document.getElementById('modalKeyContent').value;
  navigator.clipboard.writeText(keyText).then(() => {
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

function validateInputs() {
  const keyElement = document.getElementById('key');
  const sshPortElement = document.getElementById('sshPort');
  const hostFriendlyNameElement = document.getElementById('hostFriendlyName');

  keyElement.addEventListener('input', debounce(function() {
    keyElement.value = keyElement.value.trim();
    if (isValidSSHKey(keyElement.value)) {
      keyElement.classList.remove('is-invalid');
      keyElement.classList.add('is-valid');
      
      // Check for duplicate key
      if (keyElement.value && hostFriendlyNameElement.value) {
        checkDuplicateKey(keyElement.value, hostFriendlyNameElement.value);
      }
    } else {
      keyElement.classList.remove('is-valid');
      keyElement.classList.add('is-invalid');
    }
  }, 500));

  sshPortElement.addEventListener('input', function() {
    sshPortElement.value = sshPortElement.value.trim();
    if (isValidPort(sshPortElement.value)) {
      sshPortElement.classList.remove('is-invalid');
      sshPortElement.classList.add('is-valid');
    } else {
      sshPortElement.classList.remove('is-valid');
      sshPortElement.classList.add('is-invalid');
    }
  });

  hostFriendlyNameElement.addEventListener('input', debounce(function() {
    if (keyElement.value && hostFriendlyNameElement.value) {
      checkDuplicateKey(keyElement.value, hostFriendlyNameElement.value);
    }
  }, 500));
}

function checkDuplicateKey(key, hostFriendlyName) {
  const token = document.getElementById('token').value;
  const accessToken = localStorage.getItem('accessToken');

  fetch('/api/reverse/create/key/duplicate/' + token, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`
    },
    body: JSON.stringify({
      host_friendly_name: hostFriendlyName,
      key: key
    })
  })
  .then(async response => {
    const data = await response.json();
    if (!response.ok) {
      throw new Error(data.error || 'An unknown error occurred');
    }
    return data;
  })
  .then(data => {
    const keyElement = document.getElementById('key');
    const feedbackElement = document.getElementById('keyFeedback');
    if (data.host_friendly_name_exists || data.key_exists) {
      keyElement.classList.remove('is-valid');
      keyElement.classList.add('is-invalid');
      feedbackElement.textContent = data.message;
      feedbackElement.style.display = 'block';
    } else {
      keyElement.classList.remove('is-invalid');
      keyElement.classList.add('is-valid');
      feedbackElement.style.display = 'none';
    }
  })
  .catch(error => {
    const keyElement = document.getElementById('key');
    const feedbackElement = document.getElementById('keyFeedback');
    keyElement.classList.remove('is-valid');
    keyElement.classList.add('is-invalid');
    feedbackElement.textContent = error.message;
    feedbackElement.style.display = 'block';
    console.error('Error checking duplicate key:', error.message);
  });
}

// Debounce function to limit API calls
function debounce(func, wait) {
  let timeout;
  return function executedFunction(...args) {
    const later = () => {
      clearTimeout(timeout);
      func(...args);
    };
    clearTimeout(timeout);
    timeout = setTimeout(later, wait);
  };
}

function autoFillHostFriendlyName() {
  document.getElementById('key').addEventListener('input', function() {
    const key = document.getElementById('key').value;
    const hostFriendlyName = document.getElementById('hostFriendlyName').value;
    document.getElementById('hostFriendlyName').value = getHostFriendlyNameFromKey(key, hostFriendlyName);
  });
}

