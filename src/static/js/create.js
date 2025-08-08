document.addEventListener('DOMContentLoaded', function() {
  fetchToken();
  validateInputs();
  autoFillHostFriendlyName();

  document.getElementById('createTunnelForm').addEventListener('submit', function(e) {
    e.preventDefault();
    createTunnel();
  });

  document.getElementById('goToIndexBtn').addEventListener('click', function() {
    window.location.href = '/tunnels/index';
  });
});

// ============================
// Globals moved from template
// ============================
let currentStep = 1;
const totalSteps = 5;
let currentTunnelId = null;
let embeddedTerm = null;
let embeddedSocket = null;
let tunnelConnectionSocket = null;

// Expose setter so other scripts can set tunnel id
window.setCurrentTunnelId = function(id) {
  currentTunnelId = id;
  try { sessionStorage.setItem('currentTunnelId', String(id)); } catch (_) {}
};

function getCurrentTunnelId() {
  if (currentTunnelId) return currentTunnelId;
  if (window.currentTunnelId) {
    currentTunnelId = window.currentTunnelId;
    return currentTunnelId;
  }
  try {
    const stored = sessionStorage.getItem('currentTunnelId');
    if (stored) {
      currentTunnelId = parseInt(stored, 10);
      return currentTunnelId;
    }
  } catch (_) {}
  return null;
}

function updateStepIndicator(step) {
  for (let i = 1; i <= totalSteps; i++) {
    const stepNumber = document.getElementById(`stepNumber${i}`);
    const stepLabel = document.getElementById(`stepLabel${i}`);
    const stepConnector = document.getElementById(`stepConnector${i}`);
    if (stepNumber && stepLabel) {
      stepNumber.className = 'step-number pending';
      stepLabel.className = 'step-label';
    }
    if (stepConnector) {
      stepConnector.className = 'step-connector';
    }
  }
  for (let i = 1; i < step; i++) {
    const stepNumber = document.getElementById(`stepNumber${i}`);
    const stepLabel = document.getElementById(`stepLabel${i}`);
    const stepConnector = document.getElementById(`stepConnector${i}`);
    if (stepNumber && stepLabel) {
      stepNumber.className = 'step-number completed';
      stepNumber.innerHTML = '<i class="fas fa-check"></i>';
      stepLabel.className = 'step-label completed';
    }
    if (stepConnector) {
      stepConnector.className = 'step-connector completed';
    }
  }
  const currentStepNumber = document.getElementById(`stepNumber${step}`);
  const currentStepLabel = document.getElementById(`stepLabel${step}`);
  if (currentStepNumber && currentStepLabel) {
    currentStepNumber.className = 'step-number active';
    currentStepNumber.innerHTML = String(step);
    currentStepLabel.className = 'step-label active';
  }
}

function showStep(step) {
  if (currentStep === 4 && step !== 4) {
    autoDisconnectWebSocket();
  }
  for (let i = 1; i <= totalSteps; i++) {
    const section = document.getElementById(`step${i}Section`);
    if (section) section.style.display = 'none';
  }
  const currentSection = document.getElementById(`step${step}Section`);
  if (currentSection) {
    currentSection.style.display = 'block';
    currentSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  currentStep = step;
  updateStepIndicator(step);
  if (step === 2) {
    try { fetchUserKeys(); } catch(_) {}
    try { fetchServiceKeys(); } catch(_) {}
  }
}

function autoDisconnectWebSocket() {
  if (embeddedSocket) {
    try { embeddedSocket.close(); } catch(_) {}
    embeddedSocket = null;
    if (embeddedTerm) {
      try { embeddedTerm.writeln('\x1b[33mAuto-disconnected when leaving Test Connection step.\x1b[0m'); } catch(_) {}
    }
  }
  if (tunnelConnectionSocket) {
    try { tunnelConnectionSocket.close(); } catch(_) {}
    tunnelConnectionSocket = null;
  }
}

function goToServerKeys() { showStep(2); }
function goToManageUsers() {
  showStep(3);
  setTimeout(() => { try { loadUserList(); } catch(_) {} }, 100);
}
function goToTestConnection() {
  showStep(4);
  setTimeout(() => {
    try { initializeStep4Configuration(); } catch(_) {}
    try { loadAllScripts(); } catch(_) {}
    try { initializeTunnelConnectionMonitoring(); } catch(_) {}
  }, 100);
}
function goToCompletion() {
  showStep(5);
  setTimeout(() => { try { loadTerminalConfig(); } catch(_) {} }, 100);
}

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
      // Set the global tunnel ID for use in subsequent steps
      window.currentTunnelId = data.id;
      
      // Also expose it globally for create.html functions
      if (typeof window.setCurrentTunnelId === 'function') {
        window.setCurrentTunnelId(data.id);
      } else {
        // Fallback: set it directly if the function doesn't exist yet
        window.currentTunnelId = data.id;
        sessionStorage.setItem('currentTunnelId', data.id);
      }
      
      console.log('Tunnel created successfully with ID:', data.id);
      console.log('Window.currentTunnelId set to:', window.currentTunnelId);
      console.log('SessionStorage currentTunnelId:', sessionStorage.getItem('currentTunnelId'));
      
      // Directly proceed to next step without showing success alert
      showStep2();
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
      cancelButtonText: 'Close',
      allowOutsideClick: true,
      allowEscapeKey: true
    }).then((result) => {
      if (result.isConfirmed) {
        Swal.fire({
          icon: 'info',
          title: 'Error Details',
          text: detailedError,
          showConfirmButton: true,
          allowOutsideClick: true,
          allowEscapeKey: true
        });
      }
    });
  });
}

function showStep2() {
  // Use the showStep function from create.html
  if (typeof showStep === 'function') {
    showStep(2);
  } else {
    // Fallback to direct DOM manipulation
    document.getElementById('step1Section').style.display = 'none';
    document.getElementById('step2Section').style.display = 'block';
  }
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

// ============================
// Step 3: Manage Users
// ============================

function validateUsersAndProceed() {
  const tunnelId = getCurrentTunnelId();
  if (!tunnelId) {
    Swal.fire({ icon: 'error', title: 'No Tunnel Selected', text: 'Please create a tunnel first' });
    return;
  }
  const accessToken = localStorage.getItem('accessToken');
  fetch(`/api/reverse/server/${tunnelId}/usernames`, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}` }
  })
    .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
    .then(users => {
      if (!users || users.length === 0) {
        Swal.fire({ icon: 'warning', title: 'No Users Added', text: 'Please add at least one user before proceeding.' });
      } else {
        goToTestConnection();
      }
    })
    .catch(err => {
      console.error('validateUsersAndProceed error:', err);
      Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to check users. Please try again.' });
    });
}

function loadUserList() {
  const tunnelId = getCurrentTunnelId();
  if (!tunnelId) return;
  const accessToken = localStorage.getItem('accessToken');
  fetch(`/api/reverse/server/${tunnelId}/usernames`, {
    method: 'GET',
    headers: { 'Accept': 'application/json', 'Authorization': `Bearer ${accessToken}` }
  })
    .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
    .then(users => {
      const usersList = document.getElementById('usersList');
      if (!usersList) return;
      if (!users || users.length === 0) {
        usersList.innerHTML = '<p class="text-muted">No users added yet.</p>';
        return;
      }
      const items = users.map(u => (
        `<div class="list-group-item d-flex justify-content-between align-items-center">
          <span><i class=\"fas fa-user me-2\"></i>${u.username}</span>
          <button class=\"btn btn-danger btn-sm\" onclick=\"removeUserFromTunnel(${u.id})\"><i class=\"fas fa-trash\"></i></button>
        </div>`
      )).join('');
      usersList.innerHTML = `<div class="list-group">${items}</div>`;
    })
    .catch(err => {
      console.error('loadUserList error:', err);
      Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to load user list' });
    });
}

function addUserToCurrentTunnel() {
  const usernameInput = document.getElementById('newUsername');
  const username = (usernameInput?.value || '').trim();
  if (!username) {
    Swal.fire({ icon: 'warning', title: 'Username Required', text: 'Please enter a username' });
    return;
  }
  const tunnelId = getCurrentTunnelId();
  if (!tunnelId) {
    Swal.fire({ icon: 'error', title: 'No Tunnel Selected', text: 'Please create a tunnel first' });
    return;
  }
  const accessToken = localStorage.getItem('accessToken');
  fetch('/api/reverse/server/usernames', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${accessToken}` },
    body: JSON.stringify({ reverse_server: tunnelId, username })
  })
    .then(async r => { if (!r.ok) throw new Error(await r.text()); return r.json(); })
    .then(() => {
      if (usernameInput) usernameInput.value = '';
      loadUserList();
      Swal.fire({ icon: 'success', title: 'User Added', text: `User "${username}" has been added`, timer: 1200, showConfirmButton: false });
    })
    .catch(err => {
      console.error('addUserToCurrentTunnel error:', err);
      Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to add user' });
    });
}

function removeUserFromTunnel(userId) {
  Swal.fire({
    title: 'Remove User?',
    text: 'Are you sure you want to remove this user?',
    icon: 'warning',
    showCancelButton: true,
    confirmButtonText: 'Yes, remove',
    cancelButtonText: 'Cancel'
  }).then(result => {
    if (!result.isConfirmed) return;
    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/reverse/server/usernames/${userId}`, {
      method: 'DELETE',
      headers: { 'Authorization': `Bearer ${accessToken}` }
    })
      .then(async r => { if (!r.ok) throw new Error(await r.text()); })
      .then(() => {
        loadUserList();
        Swal.fire({ icon: 'success', title: 'User Removed', timer: 1000, showConfirmButton: false });
      })
      .catch(err => {
        console.error('removeUserFromTunnel error:', err);
        Swal.fire({ icon: 'error', title: 'Error', text: 'Failed to remove user' });
      });
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

// Add event listeners for new buttons
document.addEventListener('DOMContentLoaded', function() {
  // Prevent duplicate bindings
  const alreadyBound = document.body.dataset.createBindings === '1';
  if (alreadyBound) return;
  document.body.dataset.createBindings = '1';

  // Keys added button → go to Manage Users
  const keysAddedBtn = document.getElementById('keysAddedBtn');
  if (keysAddedBtn && !keysAddedBtn.dataset.bound) {
    keysAddedBtn.dataset.bound = '1';
    keysAddedBtn.addEventListener('click', goToManageUsers);
  }

  // Skip service key → confirm then redirect to index
  const skipServiceKeyBtn = document.getElementById('skipServiceKeyBtn');
  if (skipServiceKeyBtn && !skipServiceKeyBtn.dataset.bound) {
    skipServiceKeyBtn.dataset.bound = '1';
    skipServiceKeyBtn.addEventListener('click', function() {
      Swal.fire({
        title: 'Skip Service Key?',
        text: 'Web terminal functionality will be disabled. You can add service keys later from the Keys management page.',
        icon: 'warning',
        showCancelButton: true,
        confirmButtonColor: '#d97706',
        cancelButtonColor: '#6b7280',
        confirmButtonText: 'Yes, Skip Service Key',
        cancelButtonText: 'Cancel'
      }).then((result) => {
        if (result.isConfirmed) {
          window.location.href = '/tunnels/index';
        }
      });
    });
  }

  // Users configured → validate users then proceed
  const usersConfiguredBtn = document.getElementById('usersConfiguredBtn');
  if (usersConfiguredBtn && !usersConfiguredBtn.dataset.bound) {
    usersConfiguredBtn.dataset.bound = '1';
    usersConfiguredBtn.addEventListener('click', validateUsersAndProceed);
  }

  // Next step button for Step 4
  const nextStepBtn = document.getElementById('nextStepBtn');
  if (nextStepBtn && !nextStepBtn.dataset.bound) {
    nextStepBtn.dataset.bound = '1';
    nextStepBtn.addEventListener('click', goToCompletion);
  }

  // Add user button
  const addUserToListBtn = document.getElementById('addUserToListBtn');
  if (addUserToListBtn && !addUserToListBtn.dataset.bound) {
    addUserToListBtn.dataset.bound = '1';
    addUserToListBtn.addEventListener('click', addUserToCurrentTunnel);
  }

  // Terminal buttons
  const connectTerminalBtn = document.getElementById('connectTerminalBtn');
  if (connectTerminalBtn && !connectTerminalBtn.dataset.bound) {
    connectTerminalBtn.dataset.bound = '1';
    connectTerminalBtn.addEventListener('click', connectEmbeddedTerminal);
  }
  const disconnectTerminalBtn = document.getElementById('disconnectTerminalBtn');
  if (disconnectTerminalBtn && !disconnectTerminalBtn.dataset.bound) {
    disconnectTerminalBtn.dataset.bound = '1';
    disconnectTerminalBtn.addEventListener('click', disconnectEmbeddedTerminal);
  }
  const clearTerminalBtn = document.getElementById('clearTerminalBtn');
  if (clearTerminalBtn && !clearTerminalBtn.dataset.bound) {
    clearTerminalBtn.dataset.bound = '1';
    clearTerminalBtn.addEventListener('click', clearEmbeddedTerminal);
  }

  // Initialize step indicator
  try { updateStepIndicator(1); } catch(_) {}

  // Cleanup websocket on unload
  window.addEventListener('beforeunload', function() {
    if (embeddedSocket) {
      try { embeddedSocket.close(); } catch(_) {}
    }
    if (tunnelConnectionSocket) {
      try { tunnelConnectionSocket.close(); } catch(_) {}
    }
  });
});

// Ensure our implementations override any inline ones after page fully loads
window.addEventListener('load', function() {
  try {
    window.updateStepIndicator = updateStepIndicator;
    window.showStep = showStep;
    window.fetchUserKeys = fetchUserKeys;
    window.fetchServiceKeys = fetchServiceKeys;
    window.showKeyModal = showKeyModal;
    window.autoDisconnectWebSocket = autoDisconnectWebSocket;
    window.goToServerKeys = goToServerKeys;
    window.goToManageUsers = goToManageUsers;
    window.goToTestConnection = goToTestConnection;
    window.goToCompletion = goToCompletion;
    window.validateUsersAndProceed = validateUsersAndProceed;
    window.loadUserList = loadUserList;
    window.addUserToCurrentTunnel = addUserToCurrentTunnel;
    window.removeUserFromTunnel = removeUserFromTunnel;
    window.initializeStep4Configuration = initializeStep4Configuration;
    window.loadAllScripts = loadAllScripts;
    window.loadSshScript = loadSshScript;
    window.loadAutosshScript = loadAutosshScript;
    window.copySshScript = copySshScript;
    window.copyAutosshScript = copyAutosshScript;
    window.initializeTunnelConnectionMonitoring = initializeTunnelConnectionMonitoring;
    window.updateConnectionStatus = updateConnectionStatus;
    window.loadTerminalConfig = loadTerminalConfig;
    window.copyTerminalConfig = copyTerminalConfig;
    window.copyKeyToClipboard = copyKeyToClipboard;
  } catch (_) {}
});


// Enhanced script loading function
function loadAllScripts() {
  loadSshScript();
  loadAutosshScript();
}

// Update existing loadAutosshScript function to use the new API
function loadAutosshScript() {
  const tunnelId = getCurrentTunnelId();
  const sshPort = document.getElementById('step4SshPort').value;
  const keyPath = document.getElementById('sshKeyPath').value;
  
  const accessToken = localStorage.getItem('accessToken');
  let url = `/tunnels/server/script/autossh/${tunnelId}/${sshPort}`;
  if (keyPath) {
    url += `?key_path=${encodeURIComponent(keyPath)}`;
  }
  
  fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  })
  .then(response => response.json())
  .then(data => {
    document.getElementById('autosshScript').textContent = data.script;
    if (Prism && Prism.highlight) {
      Prism.highlightElement(document.getElementById('autosshScript'));
    }
  })
  .catch(error => {
    console.error('Error loading AutoSSH script:', error);
    document.getElementById('autosshScript').textContent = 'Error loading script';
  });
}

// Update existing loadSshScript function
function loadSshScript() {
  const tunnelId = getCurrentTunnelId();
  const sshPort = document.getElementById('step4SshPort').value;
  const keyPath = document.getElementById('sshKeyPath').value;
  
  const accessToken = localStorage.getItem('accessToken');
  let url = `/tunnels/server/script/ssh/${tunnelId}/${sshPort}`;
  if (keyPath) {
    url += `?key_path=${encodeURIComponent(keyPath)}`;
  }
  
  fetch(url, {
    method: 'GET',
    headers: {
      'Accept': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
  })
  .then(response => response.json())
  .then(data => {
    document.getElementById('sshScript').textContent = data.script;
    if (Prism && Prism.highlight) {
      Prism.highlightElement(document.getElementById('sshScript'));
    }
  })
  .catch(error => {
    console.error('Error loading SSH script:', error);
    document.getElementById('sshScript').textContent = 'Error loading script';
  });
}

// Add event listeners for script configuration changes
document.addEventListener('DOMContentLoaded', function() {
  const sshPortInput = document.getElementById('step4SshPort');
  const keyPathInput = document.getElementById('sshKeyPath');
  
  if (sshPortInput) {
    sshPortInput.addEventListener('input', debounce(loadAllScripts, 500));
  }
  
  if (keyPathInput) {
    keyPathInput.addEventListener('input', debounce(loadAllScripts, 500));
  }
});

// ============================
// Tunnel Connection Monitoring
// ============================

function initializeTunnelConnectionMonitoring() {
  const tunnelId = getCurrentTunnelId();
  if (!tunnelId) {
    console.error('No tunnel ID available for connection monitoring');
    return;
  }

  // Initialize connection status
  updateConnectionStatus('disconnected', 'Waiting for Connection...', 
    'Run the script on your target server to establish the tunnel connection.');

  // Setup WebSocket connection
  setupTunnelConnectionWebSocket(tunnelId);
}

function setupTunnelConnectionWebSocket(tunnelId) {
  if (tunnelConnectionSocket) {
    tunnelConnectionSocket.close();
  }

  const ws_scheme = window.location.protocol === "https:" ? "wss" : "ws";
  const ws_path = `${ws_scheme}://${window.location.host}/ws/tunnel_connection/${tunnelId}/`;
  const accessToken = localStorage.getItem('accessToken') || '';

  // Subprotocols: token.<base64(jwt)>, tunnel.<id>, auth.<ticket>
  const tokenInfo = `token.${btoa(accessToken)}`;
  const tunnelInfo = `tunnel.${tunnelId}`;
  let ticket = sha256(`${tunnelId}.connection`);
  ticket = `auth.${ticket}`;

  tunnelConnectionSocket = new WebSocket(ws_path, [tokenInfo, tunnelInfo, ticket]);

  tunnelConnectionSocket.onopen = function() {
    console.log('Tunnel connection WebSocket connected');
    updateConnectionStatus('connecting', 'Checking Connection...', 
      'Monitoring tunnel connection status...');
  };

  tunnelConnectionSocket.onmessage = function(event) {
    try {
      const data = JSON.parse(event.data);
      console.log('Tunnel connection message:', data);
      
      if (data.type === 'connection_status') {
        const isConnected = data.is_connected;
        
        if (isConnected) {
          updateConnectionStatus('connected', 'Connection Successful!', 
            `Tunnel "${data.host_friendly_name}" is now connected via port ${data.reverse_port}.`);
        } else {
          updateConnectionStatus('disconnected', 'Waiting for Connection...', 
            'Run the script on your target server to establish the tunnel connection.');
        }
      } else if (data.type === 'error') {
        console.error('Tunnel connection error:', data.message);
        updateConnectionStatus('disconnected', 'Connection Check Failed', 
          'Unable to verify connection status. Please check manually.');
      }
    } catch (error) {
      console.error('Error parsing tunnel connection message:', error);
    }
  };

  tunnelConnectionSocket.onclose = function(event) {
    console.log('Tunnel connection WebSocket closed:', event);
    
    // Only show disconnect status if we're still on step 4
    if (currentStep === 4) {
      updateConnectionStatus('disconnected', 'Connection Monitoring Stopped', 
        'WebSocket connection closed. Status updates are no longer available.');
    }
    
    // Auto-reconnect after 3 seconds if still on step 4
    if (currentStep === 4) {
      setTimeout(() => {
        if (currentStep === 4 && !tunnelConnectionSocket) {
          console.log('Attempting to reconnect tunnel connection WebSocket...');
          setupTunnelConnectionWebSocket(tunnelId);
        }
      }, 3000);
    }
  };

  tunnelConnectionSocket.onerror = function(error) {
    console.error('Tunnel connection WebSocket error:', error);
    updateConnectionStatus('disconnected', 'Connection Monitor Error', 
      'Unable to monitor connection status. Please check your configuration.');
  };
}

function updateConnectionStatus(status, title, message) {
  const badgeElement = document.getElementById('connectionStatusBadge');
  const titleElement = document.getElementById('connectionStatusText');
  const detailElement = document.getElementById('connectionStatusDetail');
  
  if (!badgeElement || !titleElement || !detailElement) {
    console.warn('Connection status elements not found');
    return;
  }

  // Update badge status
  badgeElement.className = `tunnel-status ${status}`;
  
  // Update text content
  titleElement.textContent = title;
  detailElement.textContent = message;
  
  // Update text colors based on status
  titleElement.className = 'fw-bold mb-2';
  switch (status) {
    case 'connected':
      titleElement.classList.add('text-success');
      break;
    case 'connecting':
      titleElement.classList.add('text-warning');
      break;
    case 'disconnected':
    default:
      titleElement.classList.add('text-muted');
      break;
  }
}

