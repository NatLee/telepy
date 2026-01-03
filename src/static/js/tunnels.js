
globalThis.data = [];

function fetchAndDisplayReverseServerKeys() {
    const accessToken = localStorage.getItem('accessToken');
    const refreshBtn = document.getElementById('refresh');

    // Add loading state
    if (refreshBtn) refreshBtn.classList.add('btn-loading');

    fetch('/api/reverse/server/keys', {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(data => {
        displayReverseServerKeys(data);
        globalThis.data = data; // Store the data in a global variable

        // If no data, we are done
        if (data.length === 0) {
            if (refreshBtn) refreshBtn.classList.remove('btn-loading');
            return;
        }

        // Fetch the status after constructing the rows
        fetch('/api/reverse/server/status/ports', {
            method: "GET",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        })
        .then(response => response.json())
        .then(statusData => {
            // Iterate through each item again to update their status
            data.forEach(item => {
                const hostFriendlyName = item.host_friendly_name;
                const reversePort = item.reverse_port;

                // Determine if the port is active based on the status data
                const isActive = statusData[reversePort];
                // Call the updateStatus function with the isActive status and host friendly name
                updateStatus(isActive, hostFriendlyName);
            });
        })
        .catch(error => {
            console.error('Error fetching status data:', error);
        })
        .finally(() => {
            // Remove loading state when status fetch is done
            if (refreshBtn) refreshBtn.classList.remove('btn-loading');
        });
    })
    .catch(error => {
        console.error('Error fetching tunnels data:', error);
        // Remove loading state on error
        if (refreshBtn) refreshBtn.classList.remove('btn-loading');
    });
}

// Handle window resize to switch between table and cards
window.addEventListener('resize', debounce(function() {
    // Re-render content to properly switch between table and cards
    const currentData = globalThis.data || [];
    if (currentData.length > 0) {
        displayReverseServerKeysWithStatus(currentData);
    }
}, 250));

function showTunnelDetails(tunnelId) {
    // Populate the modal with tunnel information
    document.getElementById('tunnelId').textContent = tunnelId;

    // Use fetch to get the tunnel status
    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/reverse/server/keys/${tunnelId}`, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    }).then(response => {
        if (response.ok) {
            return response.json();
        } else {
            return response.json().then(err => {
                throw err;
            });
        }
    }).then(data => {
        const hostFriendlyName = data.host_friendly_name;
        const key = data.key;
        const description = data.description;
        const canEdit = data.can_edit;
        const canShare = data.can_share;
        const canDelete = data.can_delete;
        const isOwner = data.is_owner;

        document.getElementById('tunnelHostFriendlyName').textContent = hostFriendlyName;
        document.getElementById('tunnelKeyTextArea').value = key;
        document.getElementById('tunnelDescriptionText').value = description;

        // Store the original values as data attributes
        document.getElementById('tunnelDetailsModal').dataset.originalDescription = description;

        // Store permissions
        document.getElementById('tunnelDetailsModal').dataset.canEdit = canEdit;
        document.getElementById('tunnelDetailsModal').dataset.canShare = canShare;
        document.getElementById('tunnelDetailsModal').dataset.canDelete = canDelete;
        document.getElementById('tunnelDetailsModal').dataset.isOwner = isOwner;

        // Display permission level
        const permissionBadge = document.getElementById('tunnelPermissionBadge');
        const permissionDisplay = document.getElementById('tunnelPermissionDisplay');

        let permissionText = '';
        let badgeClass = '';

        if (isOwner) {
            permissionText = 'Owner';
            badgeClass = 'badge bg-success';
        } else if (canDelete) {
            permissionText = 'Admin';
            badgeClass = 'badge bg-warning';
        } else if (canShare) {
            permissionText = 'Editor';
            badgeClass = 'badge bg-info';
        } else if (canEdit) {
            permissionText = 'Viewer';
            badgeClass = 'badge bg-secondary';
        } else {
            permissionText = 'No Access';
            badgeClass = 'badge bg-danger';
        }

        permissionBadge.className = `badge ${badgeClass}`;
        permissionBadge.textContent = permissionText;

        // If user doesn't have edit permission, make description readonly and disable save button
        const descriptionTextarea = document.getElementById('tunnelDescriptionText');
        const saveButton = document.querySelector('#tunnelDetailsModal .btn-success');

        if (!canEdit) {
            descriptionTextarea.setAttribute('readonly', 'readonly');
            saveButton.disabled = true;
            saveButton.textContent = 'No Edit Permission';
        } else {
            descriptionTextarea.removeAttribute('readonly');
            saveButton.disabled = true; // Still disabled by default until changes are made
            saveButton.textContent = 'Save Description';
        }

        // Show the modal
        var tunnelDetailsModal = new bootstrap.Modal(document.getElementById('tunnelDetailsModal'));
        tunnelDetailsModal.show();
    }).catch(error => {
        console.error('Error fetching key details:', error);
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: error.toString(),
        });
    });
}

function resetTunnelDetailsModalState() {
    const descriptionTextarea = document.getElementById('tunnelDescriptionText');
    const saveButton = document.querySelector('#tunnelDetailsModal .btn-success');

    descriptionTextarea.value = '';
    saveButton.disabled = true;

    // Reset readonly state and button text
    descriptionTextarea.removeAttribute('readonly');
    saveButton.textContent = 'Save Description';
}

function copyTunnelPublicKeyToClipboard() {
    var tunnelKeyTextArea = document.getElementById('tunnelKeyTextArea');
    tunnelKeyTextArea.select(); // Select the text
    document.execCommand('copy'); // Execute copy command
    Swal.fire({
        icon: 'success',
        title: 'Success',
        text: 'Tunnel\'s public key has been copied to clipboard.',
        showConfirmButton: false,
        timer: 800
    })
}


function displayReverseServerKeys(data) {
    const table = document.getElementById('tunnelsTableBody');
    const cardsContainer = document.getElementById('tunnelsCardsContainer');

    // Clear both containers
    table.innerHTML = '';
    if (cardsContainer) {
        cardsContainer.innerHTML = '';
    }

    // Show friendly empty state if no data
    if (data.length === 0) {
        const emptyStateHtml = `
            <tr>
                <td colspan="4" class="text-center py-5">
                    <div class="d-flex flex-column align-items-center justify-content-center">
                        <div class="mb-3 p-3 bg-light rounded-circle" style="width: 80px; height: 80px; display: flex; align-items: center; justify-content: center;">
                            <i class="fas fa-network-wired text-muted fa-3x" aria-hidden="true"></i>
                        </div>
                        <h5 class="text-muted fw-bold">No Tunnels Found</h5>
                        <p class="text-muted mb-3">Create your first SSH tunnel to get started.</p>
                        <button class="btn btn-primary btn-sm" onclick="window.location.href='/tunnels/create'">
                            <i class="fas fa-plus me-2" aria-hidden="true"></i>New Tunnel
                        </button>
                    </div>
                </td>
            </tr>
        `;
        table.innerHTML = emptyStateHtml;

        if (cardsContainer) {
            cardsContainer.innerHTML = `
                <div class="text-center py-5">
                    <div class="mb-3 p-3 bg-light rounded-circle mx-auto" style="width: 80px; height: 80px; display: flex; align-items: center; justify-content: center;">
                        <i class="fas fa-network-wired text-muted fa-3x" aria-hidden="true"></i>
                    </div>
                    <h5 class="text-muted fw-bold">No Tunnels Found</h5>
                    <p class="text-muted mb-3">Create your first SSH tunnel to get started.</p>
                    <button class="btn btn-primary btn-sm" onclick="window.location.href='/tunnels/create'">
                        <i class="fas fa-plus me-2" aria-hidden="true"></i>New Tunnel
                    </button>
                </div>
            `;
        }
        return;
    }

    // Check if we should show cards (mobile) or table (desktop)
    const isMobile = window.innerWidth < 768;

    data.forEach(item => {
        const actionButtons = createActionButtons(item);

        if (isMobile) {
            // Create card for mobile
            const card = createTunnelCard(item, actionButtons);
            if (cardsContainer) {
                cardsContainer.innerHTML += card;
            } else {
                // Fallback: still use table but with card styling
                const row = createTableRow(item, actionButtons);
                table.innerHTML += row;
            }
        } else {
            // Create table row for desktop
            const row = createTableRow(item, actionButtons);
            table.innerHTML += row;
        }
    });

    // Use the new switch display mode function
    switchDisplayMode();
}

function createActionButtons(item) {
    const itemId = item.id;
    const canEdit = item.can_edit;
    const canShare = item.can_share;
    const canDelete = item.can_delete;

    // Create full desktop version (xl and above - all buttons with text)
    let xlButtons = `
        <div class="d-none d-xl-flex action-buttons-full">
            <button class="btn btn-warning btn-sm me-1 action-btn" onclick="event.stopPropagation(); window.open('/tunnels/terminal/${itemId}')" title="Open Console">Console</button>
            <button class="btn btn-primary btn-sm me-1 action-btn" onclick="event.stopPropagation(); openUserManagementModal('${itemId}')" title="Manage Users">Users</button>
    `;

    if (canDelete) {
        xlButtons += `<button class="btn btn-danger btn-sm me-1 action-btn" onclick="event.stopPropagation(); confirmDelete('${itemId}')" title="Delete Tunnel">Delete</button>`;
    }

    if (canShare) {
        xlButtons += `<button class="btn btn-success btn-sm me-1 action-btn" onclick="event.stopPropagation(); openShareModal('${itemId}')" title="Share Tunnel">Share</button>`;
    }

    xlButtons += `
            <button class="btn btn-info btn-sm me-1 action-btn" onclick="event.stopPropagation(); fetchServerConfig(${itemId})" title="Get Config">Config</button>
            <button class="btn btn-secondary btn-sm me-1 action-btn" onclick="event.stopPropagation(); showServerScriptModal('${itemId}')" title="Get Script">Script</button>
        </div>
    `;

    // Create scrollable desktop version (lg to xl - icons with horizontal scroll)
    let lgButtons = `
        <div class="d-none d-lg-flex d-xl-none action-buttons-scrollable">
            <div class="action-buttons-scroll-container">
                <button class="btn btn-warning btn-sm action-btn" onclick="event.stopPropagation(); window.open('/tunnels/terminal/${itemId}')" title="Open Console">
                    <i class="fas fa-terminal"></i>
                </button>
                <button class="btn btn-primary btn-sm action-btn" onclick="event.stopPropagation(); openUserManagementModal('${itemId}')" title="Manage Users">
                    <i class="fas fa-users"></i>
                </button>
    `;

    if (canDelete) {
        lgButtons += `<button class="btn btn-danger btn-sm action-btn" onclick="event.stopPropagation(); confirmDelete('${itemId}')" title="Delete Tunnel">
                <i class="fas fa-trash"></i>
            </button>`;
    }

    if (canShare) {
        lgButtons += `<button class="btn btn-success btn-sm action-btn" onclick="event.stopPropagation(); openShareModal('${itemId}')" title="Share Tunnel">
                <i class="fas fa-share"></i>
            </button>`;
    }

    lgButtons += `
                <button class="btn btn-info btn-sm action-btn" onclick="event.stopPropagation(); fetchServerConfig(${itemId})" title="Get Config">
                    <i class="fas fa-code"></i>
                </button>
                <button class="btn btn-secondary btn-sm action-btn" onclick="event.stopPropagation(); showServerScriptModal('${itemId}')" title="Get Script">
                    <i class="fas fa-file-code"></i>
                </button>
            </div>
        </div>
    `;

    // Create compact scrollable version (md to lg - icons with horizontal scroll)
    let mdButtons = `
        <div class="d-none d-md-flex d-lg-none action-buttons-scrollable">
            <div class="action-buttons-scroll-container">
                <button class="btn btn-warning btn-sm action-btn" onclick="event.stopPropagation(); window.open('/tunnels/terminal/${itemId}')" title="Open Console">
                    <i class="fas fa-terminal"></i>
                </button>
                <button class="btn btn-primary btn-sm action-btn" onclick="event.stopPropagation(); openUserManagementModal('${itemId}')" title="Manage Users">
                    <i class="fas fa-users"></i>
                </button>
    `;

    if (canDelete) {
        mdButtons += `<button class="btn btn-danger btn-sm action-btn" onclick="event.stopPropagation(); confirmDelete('${itemId}')" title="Delete Tunnel">
                <i class="fas fa-trash"></i>
            </button>`;
    }

    if (canShare) {
        mdButtons += `<button class="btn btn-success btn-sm action-btn" onclick="event.stopPropagation(); openShareModal('${itemId}')" title="Share Tunnel">
                <i class="fas fa-share"></i>
            </button>`;
    }

    mdButtons += `
                <button class="btn btn-info btn-sm action-btn" onclick="event.stopPropagation(); fetchServerConfig(${itemId})" title="Get Config">
                    <i class="fas fa-code"></i>
                </button>
                <button class="btn btn-secondary btn-sm action-btn" onclick="event.stopPropagation(); showServerScriptModal('${itemId}')" title="Get Script">
                    <i class="fas fa-file-code"></i>
                </button>
            </div>
        </div>
    `;

    // Create mobile version (all buttons visible, flex wrap)
    let mobileButtons = `
        <div class="d-md-none action-buttons-mobile">
            <div class="d-flex flex-wrap gap-1">
                <button class="btn btn-warning btn-sm action-btn" onclick="event.stopPropagation(); window.open('/tunnels/terminal/${itemId}')" title="Open Console">
                    <i class="fas fa-terminal"></i>
                </button>
                <button class="btn btn-primary btn-sm action-btn" onclick="event.stopPropagation(); openUserManagementModal('${itemId}')" title="Manage Users">
                    <i class="fas fa-users"></i>
                </button>
    `;

    if (canDelete) {
        mobileButtons += `<button class="btn btn-danger btn-sm action-btn" onclick="event.stopPropagation(); confirmDelete('${itemId}')" title="Delete Tunnel">
                <i class="fas fa-trash"></i>
            </button>`;
    }

    if (canShare) {
        mobileButtons += `<button class="btn btn-success btn-sm action-btn" onclick="event.stopPropagation(); openShareModal('${itemId}')" title="Share Tunnel">
                <i class="fas fa-share"></i>
            </button>`;
    }

    mobileButtons += `
                <button class="btn btn-info btn-sm action-btn" onclick="event.stopPropagation(); fetchServerConfig(${itemId})" title="Get Config">
                    <i class="fas fa-code"></i>
                </button>
                <button class="btn btn-secondary btn-sm action-btn" onclick="event.stopPropagation(); showServerScriptModal('${itemId}')" title="Get Script">
                    <i class="fas fa-file-code"></i>
                </button>
            </div>
        </div>
    `;

    // Combine all responsive versions
    return xlButtons + lgButtons + mdButtons + mobileButtons;
}

function createTableRow(item, actionButtons) {

    const itemId = item.id;
    const hostFriendlyName = item.host_friendly_name;
    const reversePort = item.reverse_port;
    const isOwner = item.is_owner;

    // Create ownership label next to hostname for shared tunnels
    const displayName = isOwner
        ? hostFriendlyName
        : `${hostFriendlyName} <span class="badge bg-light text-muted ms-1 border" style="font-size: 0.7em;">🏷️ Shared</span>`;

    return `
        <tr onclick="showTunnelDetails('${itemId}')">
            <td>${displayName}</td>
            <td>${reversePort}</td>
            <td>
                <div class='d-flex'>
                    <div class="${hostFriendlyName}-status tunnel-status ml-2" id="${hostFriendlyName}-status"></div>
                </div>
            </td>
            <td>
                <div class='d-flex' id="actions-${itemId}">
                    ${actionButtons}
                </div>
            </td>
        </tr>
    `;
}

function createTunnelCard(item, actionButtons) {
    const itemId = item.id;
    const hostFriendlyName = item.host_friendly_name;
    const reversePort = item.reverse_port;
    const isOwner = item.is_owner;

    // Create ownership label
    const ownershipLabel = isOwner ? '' : '<span class="badge bg-light text-muted border ms-2" style="font-size: 0.7em;">🏷️ Shared</span>';

    return `
        <div class="tunnel-card mb-3" onclick="showTunnelDetails('${itemId}')">
            <div class="card border-0 shadow-sm">
                <div class="card-body p-3">
                    <div class="d-flex justify-content-between align-items-start mb-2">
                        <div class="flex-grow-1">
                            <h6 class="card-title mb-1 d-flex align-items-center">
                                <i class="fas fa-server text-muted me-2"></i>
                                ${hostFriendlyName}${ownershipLabel}
                            </h6>
                            <p class="card-text small text-muted mb-2">
                                <i class="fas fa-ethernet text-muted me-1"></i>
                                Port: ${reversePort}
                            </p>
                        </div>
                        <div class="${hostFriendlyName}-status tunnel-status" id="${hostFriendlyName}-status"></div>
                    </div>

                    <div class="d-flex justify-content-between align-items-center">
                        <div id="actions-${itemId}" class="flex-grow-1">
                            ${actionButtons}
                        </div>
                    </div>
                </div>
            </div>
        </div>
    `;
}

function updateStatus(isConnected, hostFriendlyName) {
    const statusElement = document.getElementById(`${hostFriendlyName}-status`);
    if (statusElement) {
        statusElement.classList.toggle('connected', isConnected);
        statusElement.classList.toggle('disconnected', !isConnected);
    }
}

function fetchServerConfig(serverId) {
    const accessToken = localStorage.getItem('accessToken');

    fetch(`/tunnels/server/config/${serverId}`, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(data => {
        document.getElementById('configContent').value = data.config;
        new bootstrap.Modal(document.getElementById('configModal')).show();
    })
    .catch(error => {
        console.error('Error fetching server config:', error);
    });
}

function copyConfigToClipboard() {
    const configContent = document.getElementById('configContent');
    configContent.select();
    document.execCommand('copy');
    configContent.setSelectionRange(0, 0);

    // Using SweetAlert for feedback
    Swal.fire({
        icon: 'success',
        title: 'Config copied to clipboard',
        showConfirmButton: false,
        timer: 800
    });
}

function confirmDelete(serverId) {
    Swal.fire({
        title: "Are you sure?",
        text: "Do you really want to delete this key? This action cannot be undone.",
        icon: "warning",
        showCancelButton: true, // Show cancel button
        confirmButtonText: 'Yes, delete it!',
        cancelButtonText: 'No, cancel!',
        allowOutsideClick: false, // Prevent closing by clicking outside
        backdrop: `
        rgba(0,0,123,0.4)
        url("/api/__hidden_statics/images/rolling-cat.gif")
        left top
        no-repeat
      `
    })
    .then((result) => {
        if (result.isConfirmed) {
            Swal.fire({
                title: "Please confirm",
                text: "Please confirm once more that you want to delete this key.",
                icon: "warning",
                showCancelButton: true, // Show cancel button
                confirmButtonText: 'Yes!!!',
                cancelButtonText: 'No, cancel!',
                allowOutsideClick: false, // Prevent closing by clicking outside
                backdrop: `
                rgba(222, 55, 66,0.4)
                url("/api/__hidden_statics/images/nyan-cat.gif")
                left top
                no-repeat
              `
            })
            .then((resultAgain) => {
                if (resultAgain.isConfirmed) {
                    deleteKey(serverId);
                }
            });
        }
    });
}

function deleteKey(serverId) {
    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/reverse/server/keys/${serverId}`, {
        method: "DELETE",
        headers: {
            'Authorization': `Bearer ${accessToken}`,
        },
    })
    .then(response => {
        if (response.ok) {
            console.log('Tunnel deleted successfully, refreshing list...');
            Swal.fire("Deleted!", "The tunnel has been deleted.", "success");
            // Refresh the tunnel list immediately
            fetchAndDisplayReverseServerKeys();
        } else {
            console.log('Tunnel deletion failed:', response.status, response.statusText);
            Swal.fire("Error", "There was an error deleting the tunnel.", "error");
        }
    })
    .catch(error => {
        console.error('Error:', error);
        Swal.fire("Error", "There was an error deleting the key.", "error");
    });
}

function saveDescription() {
    const tunnelId = document.getElementById('tunnelId').textContent;
    const newDescription = document.getElementById('tunnelDescriptionText').value;

    const accessToken = localStorage.getItem('accessToken');

    fetch(`/api/reverse/server/keys/${tunnelId}`, {
        method: 'PATCH',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            description: newDescription
        })
    })
    .then(response => {
        if (response.ok) {
            return response.json();
        } else {
            return response.json().then(err => {
                throw err;
            });
        }
    })
    .then(data => {
        console.log('Success:', data);
        Swal.fire({
            icon: 'success',
            title: 'Success',
            text: 'Tunnel key information has been updated successfully.',
            showConfirmButton: false,
            timer: 1500
        });
    })
    .catch((error) => {
        console.error('Error:', error);
        let errorMessage = 'Failed to update key information';
        if (error.key) {
            errorMessage = `Public key error: ${error.key}`;
        } else if (error.host_friendly_name) {
            errorMessage = `Host name error: ${error.host_friendly_name}`;
        } else if (error.description) {
            errorMessage = `Description error: ${error.description}`;
        }
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: errorMessage,
        });
    });
}

function checkTunnelDetailsModalForChanges() {
    const modal = document.getElementById('tunnelDetailsModal');
    const originalDescription = modal.dataset.originalDescription;
    const currentDescription = document.getElementById('tunnelDescriptionText').value;
    const canEdit = modal.dataset.canEdit === 'true';

    const saveButton = document.querySelector('#tunnelDetailsModal .btn-success');

    // Only enable save button if user has edit permission and description has changed
    if (canEdit && originalDescription !== currentDescription) {
        saveButton.disabled = false;
    } else {
        saveButton.disabled = true;
    }
}


function openUserManagementModal(serverId) {
    $('#manageUsersModal').modal('show');

    const addUserButton = document.getElementById('addUserBtn');
    const usernameInput = document.getElementById('newUsername');

    if (!addUserButton || !usernameInput) {
        console.error('Required DOM elements not found in user management modal');
        return;
    }

    // Find the tunnel item to check permissions
    const tunnelItem = globalThis.data.find(item => item.id == serverId);
    // Check if user can edit this tunnel
    const canEdit = tunnelItem ? tunnelItem.can_edit : false;

    // Reset form
    usernameInput.value = '';
    addUserButton.disabled = true;

    // Disable add user functionality if no edit permission
    if (!canEdit) {
        addUserButton.disabled = true;
        addUserButton.textContent = 'No Edit Permission';
        usernameInput.disabled = true;
        usernameInput.placeholder = 'No edit permission to add users';
    } else {
        addUserButton.textContent = 'Add User';
        usernameInput.disabled = false;
        usernameInput.placeholder = 'Enter username';

        // Set click handler
        addUserButton.onclick = function() {
            addUser(serverId);
        };

        // Enable button when username is entered
        usernameInput.addEventListener('input', function() {
            if (addUserButton) {
                addUserButton.disabled = !this.value.trim();
            }
        });
    }

    fetchUserList(serverId);
}

function fetchUserList(serverId) {
    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/reverse/server/${serverId}/usernames`, {
      method: 'GET',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      }
    })
    .then(response => response.json())
    .then(users => {
      const userListDiv = document.getElementById('userList');
      if (!userListDiv) {
        console.error('userList element not found');
        return;
      }

      userListDiv.innerHTML = ''; // Clear current list

      // Find the tunnel item to check permissions
      const tunnelItem = globalThis.data.find(item => item.id == serverId);
      const canEdit = tunnelItem ? tunnelItem.can_edit : false;

      if (users.length === 0) {
        userListDiv.innerHTML = '<p class="text-muted">No users found.</p>';
      } else {
        const listGroup = document.createElement('ul');
        listGroup.className = 'list-group';

        users.forEach(user => {
          const listItem = document.createElement('li');
          listItem.className = 'list-group-item d-flex justify-content-between align-items-center';

          if (canEdit) {
            // Show delete button if user has edit permission
            listItem.innerHTML = `
              <span>${user.username}</span>
              <button class="btn btn-danger btn-sm">Delete</button>
            `;

            const deleteUserBtn = listItem.querySelector('button');
            // Pass the serverId along with the userId to the deleteUser function
            deleteUserBtn.onclick = () => deleteUser(user.id, serverId);
          } else {
            // Show username only if no edit permission
            listItem.innerHTML = `
              <span>${user.username}</span>
              <span class="text-muted small">Read-only access</span>
            `;
          }

          listGroup.appendChild(listItem);
        });

        userListDiv.appendChild(listGroup);
      }
    });
}

function addUser(serverId) {
    // Double-check permissions before attempting to add user
    const tunnelItem = globalThis.data.find(item => item.id == serverId);
    const canEdit = tunnelItem ? tunnelItem.can_edit : false;

    if (!canEdit) {
        Swal.fire({
            icon: 'error',
            title: 'Permission Denied',
            text: 'You do not have permission to add users to this tunnel.',
        });
        return;
    }

    const accessToken = localStorage.getItem('accessToken');
    const username = document.getElementById('newUsername').value;
    fetch(`/api/reverse/server/usernames`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${accessToken}`
      },
      body: JSON.stringify({
        reverse_server: serverId,
        username: username
      })
    })
    .then(response => {
      if (response.ok) {
        fetchUserList(serverId); // Refresh user list
        // clear the input field
        document.getElementById('newUsername').value = '';
      } else {
        response.json().then(data => {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: data.error || 'Failed to add user.',
            });
        });
      }
    })
    .catch(error => {
        console.error('Error adding user:', error);
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: 'Failed to add user.',
        });
    });
}

function deleteUser(userId, serverId) { // Add serverId parameter
    // Double-check permissions before attempting to delete user
    const tunnelItem = globalThis.data.find(item => item.id == serverId);
    const canEdit = tunnelItem ? tunnelItem.can_edit : false;

    if (!canEdit) {
        Swal.fire({
            icon: 'error',
            title: 'Permission Denied',
            text: 'You do not have permission to delete users from this tunnel.',
        });
        return;
    }

    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/reverse/server/usernames/${userId}`, {
        method: 'DELETE',
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    })
    .then(response => {
      if (response.ok) {
        fetchUserList(serverId); // Refresh user list using serverId
      } else {
        response.json().then(data => {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: data.error || 'Failed to delete user.',
            });
        });
      }
    })
    .catch(error => {
        console.error('Error deleting user:', error);
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: 'Failed to delete user.',
        });
    });
}

function tunnelNotificationWebsocket() {
    var socket = notificationWebsocket();
    if (!socket) {
        console.error('Failed to create notification WebSocket');
        return;
    }

    socket.onmessage = function (event) {
        const data = JSON.parse(event.data);
        console.log('Notification message:', data.message);
        let action = data.message.action;

        // Handle different notification types
        if (action === "UPDATED-TUNNELS") {
            console.log('Received UPDATED-TUNNELS notification:', data.message);
            createToastAlert(data.message.details || "Tunnels updated", false);
            fetchAndDisplayReverseServerKeys();
        } else if (action === "TUNNEL-SHARED") {
            console.log('Received TUNNEL-SHARED notification:', data.message);
            createToastAlert(data.message.details, false, 'success');
            // Refresh tunnel list to show any changes
            fetchAndDisplayReverseServerKeys();
        } else if (action === "TUNNEL-UNSHARED") {
            createToastAlert(data.message.details, false, 'warning');
            // Refresh tunnel list to reflect access changes
            fetchAndDisplayReverseServerKeys();
        } else if (action === "TUNNEL-PERMISSION-UPDATED") {
            createToastAlert(data.message.details, false, 'info');
            // Refresh tunnel list to reflect permission changes
            fetchAndDisplayReverseServerKeys();
        } else if (action === "UPDATE-TUNNEL-STATUS") {
            // Update status for specific tunnel based on port
            const port = data.message.port;
            const status = data.message.status;
            const isConnected = status === 'connected';

            // Find tunnel with this port and update its status
            if (globalThis.data) {
                const tunnel = globalThis.data.find(item => item.reverse_port === port);
                if (tunnel) {
                    updateStatus(isConnected, tunnel.host_friendly_name);
                    console.log(`Updated status for tunnel ${tunnel.host_friendly_name} (port ${port}): ${status}`);

                    // Show toast notification for status change
                    const statusText = isConnected ? 'online' : 'offline';
                    const iconType = isConnected ? 'success' : 'warning';
                    createToastAlert(`Tunnel "${tunnel.host_friendly_name}" is now ${statusText}`, false, iconType);
                }
            }
        } else if (action === "UPDATE-TUNNEL-STATUS-DATA") {
            // Update status for all tunnels based on activated ports
            const activatedPorts = data.message.data || [];

            if (globalThis.data) {
                globalThis.data.forEach(item => {
                    const hostFriendlyName = item.host_friendly_name;
                    const reversePort = item.reverse_port;

                    // Check if port is in activated ports list
                    const isConnected = activatedPorts.includes(reversePort);
                    updateStatus(isConnected, hostFriendlyName);
                });
                console.log('Updated status for all tunnels based on activated ports:', activatedPorts);

                // Show a summary toast notification
                const onlineCount = activatedPorts.length;
                const totalCount = globalThis.data.length;
                const offlineCount = totalCount - onlineCount;

                if (onlineCount > 0 && offlineCount > 0) {
                    createToastAlert(`Tunnel status updated: ${onlineCount} online, ${offlineCount} offline`, false, 'info');
                } else if (onlineCount === totalCount) {
                    createToastAlert(`All ${totalCount} tunnels are online`, false, 'success');
                } else if (offlineCount === totalCount) {
                    createToastAlert(`All ${totalCount} tunnels are offline`, false, 'warning');
                }
            }
        } else {
            // For unknown actions, just show a general toast
            createToastAlert(data.message.details || "Notification received", false);
        }
    };
}

async function fetchSSHScript(url) {
    const accessToken = localStorage.getItem('accessToken');
    const response = await fetch(url, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    });

    if (!response.ok) {
        throw new Error('Network response was not ok');
    }

    const data = await response.json();
    return data;
}

async function updateServerScriptContent(serverId) {
    try {
        const sshPort = document.getElementById('sshPort').value;
        const sshKeyPath = document.getElementById('sshKeyPathTunnels').value.trim();

        if (!sshPort) {
            console.error('SSH port is empty');
            return;
        }

        if (!isValidPort(sshPort)) {
            console.error('Invalid SSH port:', sshPort);
            return;
        }

        // Build URLs with optional key path parameter
        let sshUrl = `/tunnels/server/script/ssh/${serverId}/${sshPort}`;
        let autosshUrl = `/tunnels/server/script/autossh/${serverId}/${sshPort}`;
        let autosshServiceUrl = `/tunnels/server/script/autossh-service/${serverId}/${sshPort}`;
        let powershellUrl = `/tunnels/server/script/powershell/${serverId}/${sshPort}`;
        
        if (sshKeyPath) {
            const keyPathParam = `?key_path=${encodeURIComponent(sshKeyPath)}`;
            sshUrl += keyPathParam;
            autosshUrl += keyPathParam;
            autosshServiceUrl += keyPathParam;
            powershellUrl += keyPathParam;
        }

        // Fetch the SSH Simple script
        const sshSimpleScriptData = await fetchSSHScript(sshUrl);

        // Fetch the AutoSSH script
        const autosshScriptData = await fetchSSHScript(autosshUrl);

        // If service script is not available, it means the user have not add usernames to this server
        let sshServiceScriptData = {};
        try {
            sshServiceScriptData = await fetchSSHScript(autosshServiceUrl);
        } catch (error) {
            console.error('Error fetching SSH service script:', error);
            sshServiceScriptData = {
                script: 'No usernames added to this server yet.',
                language: 'bash'
            };
        }

        // Fetch the PowerShell script
        const powershellScriptData = await fetchSSHScript(powershellUrl);

        // Fetch Docker scripts
        let dockerRunUrl = `/tunnels/server/script/docker-run/${serverId}/${sshPort}`;
        let dockerComposeUrl = `/tunnels/server/script/docker-compose/${serverId}/${sshPort}`;
        
        if (sshKeyPath) {
            const keyPathParam = `?key_path=${encodeURIComponent(sshKeyPath)}`;
            dockerRunUrl += keyPathParam;
            dockerComposeUrl += keyPathParam;
        }
        
        const dockerRunScriptData = await fetchSSHScript(dockerRunUrl);
        const dockerComposeScriptData = await fetchSSHScript(dockerComposeUrl);

        // Check if Prism is available and highlight the code
        if (Prism && Prism.highlight) {
            // Highlight basic scripts
            if (sshSimpleScriptData.script) {
                try {
                    document.getElementById('tunnelCommandSSHSimple').innerHTML = Prism.highlight(sshSimpleScriptData.script, Prism.languages[sshSimpleScriptData.language], sshSimpleScriptData.language);
                } catch (error) {
                    console.error('Error highlighting SSH Simple script:', error);
                    document.getElementById('tunnelCommandSSHSimple').textContent = sshSimpleScriptData.script;
                }
            }
            if (autosshScriptData.script) {
                try {
                    document.getElementById('tunnelCommandAutoSSH').innerHTML = Prism.highlight(autosshScriptData.script, Prism.languages[autosshScriptData.language], autosshScriptData.language);
                } catch (error) {
                    console.error('Error highlighting AutoSSH script:', error);
                    document.getElementById('tunnelCommandAutoSSH').textContent = autosshScriptData.script;
                }
            }
            if (sshServiceScriptData.script) {
                try {
                    document.getElementById('tunnelCommandSSHService').innerHTML = Prism.highlight(sshServiceScriptData.script, Prism.languages[sshServiceScriptData.language], sshServiceScriptData.language);
                } catch (error) {
                    console.error('Error highlighting SSH Service script:', error);
                    document.getElementById('tunnelCommandSSHService').textContent = sshServiceScriptData.script;
                }
            }

            try {
                document.getElementById('tunnelCommandSSHServiceSteps').innerHTML = Prism.highlight(
                    "sudo systemctl daemon-reload\nsudo systemctl start autossh.service\nsudo systemctl enable autossh.service"
                    , Prism.languages['bash'], 'bash'
                );
            } catch (error) {
                console.error('Error highlighting SSH Service Steps:', error);
                document.getElementById('tunnelCommandSSHServiceSteps').textContent = "sudo systemctl daemon-reload\nsudo systemctl start autossh.service\nsudo systemctl enable autossh.service";
            }

            if (powershellScriptData.script) {
                try {
                    document.getElementById('tunnelCommandPowershell').innerHTML = Prism.highlight(powershellScriptData.script, Prism.languages[powershellScriptData.language], powershellScriptData.language);
                } catch (error) {
                    console.error('Error highlighting PowerShell script:', error);
                    document.getElementById('tunnelCommandPowershell').textContent = powershellScriptData.script;
                }
            }
            
            // Highlight Docker scripts
            if (dockerRunScriptData.script) {
                console.log('Highlighting Docker Run script with language:', dockerRunScriptData.language);
                try {
                    document.getElementById('tunnelCommandDockerRun').innerHTML = Prism.highlight(dockerRunScriptData.script, Prism.languages[dockerRunScriptData.language], dockerRunScriptData.language);
                } catch (error) {
                    console.error('Error highlighting Docker Run script:', error);
                    // Fallback to plain text
                    document.getElementById('tunnelCommandDockerRun').textContent = dockerRunScriptData.script;
                }
            }
            if (dockerComposeScriptData.script) {
                console.log('Highlighting Docker Compose script with language:', dockerComposeScriptData.language);
                console.log('Available Prism languages:', Object.keys(Prism.languages));
                console.log('Docker Compose script content:', dockerComposeScriptData.script);
                
                // Check if yaml language is available, fallback to bash if not
                const language = Prism.languages[dockerComposeScriptData.language] ? dockerComposeScriptData.language : 'bash';
                console.log('Using language for highlighting:', language);
                
                try {
                    document.getElementById('tunnelCommandDockerCompose').innerHTML = Prism.highlight(dockerComposeScriptData.script, Prism.languages[language], language);
                } catch (error) {
                    console.error('Error highlighting Docker Compose script:', error);
                    // Fallback to plain text
                    document.getElementById('tunnelCommandDockerCompose').textContent = dockerComposeScriptData.script;
                }
            }
        }

    } catch (error) {
        console.error('Error updating server script content:', error);
    }
}

function showServerScriptModal(serverId) {
    updateServerScriptContent(serverId);
    // Show the modal after updating its content
    const modal = new bootstrap.Modal(document.getElementById('serverScriptModal'));
    modal.show();
    
    // Re-fetch script content when SSH port or key path changes and update the modal content
    const sshPortElement = document.getElementById('sshPort');
    const sshKeyPathElement = document.getElementById('sshKeyPathTunnels');
    
    // Remove existing event listeners to prevent duplicates
    if (sshPortElement._sshPortChangeHandler) {
        sshPortElement.removeEventListener('change', sshPortElement._sshPortChangeHandler);
    }
    if (sshKeyPathElement._sshKeyPathInputHandler) {
        sshKeyPathElement.removeEventListener('input', sshKeyPathElement._sshKeyPathInputHandler);
    }
    
    // Create new event handlers
    sshPortElement._sshPortChangeHandler = async () => {
        await updateServerScriptContent(serverId);
    };
    
    sshKeyPathElement._sshKeyPathInputHandler = debounce(async () => {
        await updateServerScriptContent(serverId);
    }, 500);
    
    // Add new event listeners
    sshPortElement.addEventListener('change', sshPortElement._sshPortChangeHandler);
    sshKeyPathElement.addEventListener('input', sshKeyPathElement._sshKeyPathInputHandler);
}

// Debounce function for input events
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

function validateSSHPortInputs() {
    $('[data-toggle="tooltip"]').tooltip({trigger: 'manual'}).tooltip('hide');
  
    document.getElementById('sshPort').addEventListener('input', function() {
      // Trim the input value
      const sshPortElement = document.getElementById('sshPort');
      sshPortElement.value = sshPortElement.value.trim();
      const sshPort = sshPortElement.value;
      if (isValidPort(sshPort)) {
        $('#sshPort').tooltip('hide');
        document.getElementById('sshPort').classList.remove('is-invalid');
        document.getElementById('sshPort').classList.add('is-valid');
      } else {
        $('#sshPort').tooltip('show');
        document.getElementById('sshPort').classList.remove('is-valid');
        document.getElementById('sshPort').classList.add('is-invalid');
      }
    });
  }


// ========================================
// Tunnel Sharing Functions
// ========================================

let currentSharingTunnelId = null;

function openShareModal(tunnelId) {
    currentSharingTunnelId = tunnelId;
    $('#shareTunnelModal').modal('show');

    // Check if current user can set admin permissions
    fetch(`/api/reverse/server/keys/${tunnelId}`, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        },
    })
    .then(response => response.json())
    .then(tunnelData => {
        const canSetAdmin = tunnelData.can_share || false;
        const permissionSelect = document.getElementById('permissionSelect');

        // Clear existing options
        permissionSelect.innerHTML = '';

        // Add available options based on user permissions
        const options = [
            {value: 'view', label: 'Read-only'},
            {value: 'edit', label: 'Can Edit'}
        ];

        if (canSetAdmin) {
            options.push({value: 'admin', label: 'Admin'});
        }

        options.forEach(option => {
            const optionElement = document.createElement('option');
            optionElement.value = option.value;
            optionElement.textContent = option.label;
            permissionSelect.appendChild(optionElement);
        });

        // Reset form
        document.getElementById('shareUserSelect').value = '';
        permissionSelect.value = 'view';
        document.getElementById('shareButton').disabled = true;

        // Enable share button when user is selected
        const userSelect = document.getElementById('shareUserSelect');
        const shareButton = document.getElementById('shareButton');

        userSelect.addEventListener('change', function() {
            shareButton.disabled = !this.value;
        });

        // Load shared users and available users
        loadSharedUsers(tunnelId);
        loadAvailableUsers(tunnelId);
    })
    .catch(error => {
        console.error('Error checking permissions:', error);
        // Fallback to basic options
        const permissionSelect = document.getElementById('permissionSelect');
        permissionSelect.innerHTML = `
            <option value="view">Read-only</option>
            <option value="edit" selected>Can Edit</option>
        `;

        document.getElementById('shareUserSelect').value = '';
        document.getElementById('shareButton').disabled = true;

        // Load shared users and available users
        loadSharedUsers(tunnelId);
        loadAvailableUsers(tunnelId);
    });

    // Enable share button when user is selected
    const userSelect = document.getElementById('shareUserSelect');
    const shareButton = document.getElementById('shareButton');

    userSelect.addEventListener('change', function() {
        shareButton.disabled = !this.value;
    });

    // Load shared users and available users
    loadSharedUsers(tunnelId);
    loadAvailableUsers(tunnelId);
}

function loadSharedUsers(tunnelId) {
    const accessToken = localStorage.getItem('accessToken');

    // First check if user can manage sharing for this tunnel
    fetch(`/api/reverse/server/keys/${tunnelId}`, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(tunnelData => {
        const canManageSharing = tunnelData.can_share || false;

        // Now load shared users
        return fetch(`/tunnels/shared-users/${tunnelId}`, {
            method: "GET",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        })
        .then(response => response.json())
        .then(data => ({ data, canManageSharing }));
    })
    .then(({ data, canManageSharing }) => {
        const sharedUsersList = document.getElementById('sharedUsersList');
        if (!sharedUsersList) {
            console.error('sharedUsersList element not found');
            return;
        }

        if (data.users && data.users.length > 0) {
            let html = '<div class="list-group">';
            data.users.forEach(user => {
                // Determine permission level and display
                const permissionBadge = user.permission_type === 'admin'
                    ? '<span class="badge bg-danger"><i class="fas fa-crown me-1"></i>Admin</span>'
                    : user.permission_type === 'edit'
                    ? '<span class="badge bg-success"><i class="fas fa-edit me-1"></i>Can Edit</span>'
                    : '<span class="badge bg-secondary"><i class="fas fa-eye me-1"></i>Read-only</span>';

                let permissionControl = '';
                if (canManageSharing) {
                    // Create permission select dropdown
                    const options = [
                        {value: 'view', label: 'Read-only', selected: user.permission_type === 'view'},
                        {value: 'edit', label: 'Can Edit', selected: user.permission_type === 'edit'},
                        {value: 'admin', label: 'Admin', selected: user.permission_type === 'admin'}
                    ];

                    const optionHtml = options.map(opt =>
                        `<option value="${opt.value}" ${opt.selected ? 'selected' : ''}>${opt.label}</option>`
                    ).join('');

                    permissionControl = `
                        <select class="form-select form-select-sm" style="width: 120px;"
                                onchange="updateSharingPermission('${user.id}', this.value, this)">
                            ${optionHtml}
                        </select>
                    `;
                } else {
                    // Show current permission as read-only
                    permissionControl = `<span class="text-muted small">${permissionBadge}</span>`;
                }

                html += `
                    <div class="list-group-item">
                        <div class="d-flex justify-content-between align-items-start">
                            <div class="flex-grow-1">
                                <div class="d-flex align-items-center mb-2">
                                    <strong class="me-2">${user.username}</strong>
                                    ${permissionBadge}
                                </div>
                                ${user.email ? `<small class="text-muted">${user.email}</small>` : ''}
                            </div>
                            <div class="d-flex align-items-center gap-2">
                                ${permissionControl}
                                ${canManageSharing ? `<button class="btn btn-outline-danger btn-sm" onclick="unshareTunnel('${user.id}')">
                                    <i class="fas fa-times"></i>
                                </button>` : ''}
                            </div>
                        </div>
                    </div>
                `;
            });
            html += '</div>';
            sharedUsersList.innerHTML = html;
        } else {
            sharedUsersList.innerHTML = '<p class="text-muted">Not shared with anyone yet.</p>';
        }
    })
    .catch(error => {
        console.error('Error loading shared users:', error);
        const sharedUsersList = document.getElementById('sharedUsersList');
        if (sharedUsersList) {
            sharedUsersList.innerHTML = '<p class="text-danger">Error loading shared users.</p>';
        }
    });
}

function loadAvailableUsers(tunnelId) {
    const accessToken = localStorage.getItem('accessToken');

    fetch(`/tunnels/available-users/${tunnelId}`, {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(data => {
        const userSelect = document.getElementById('shareUserSelect');
        if (!userSelect) {
            console.error('shareUserSelect element not found');
            return;
        }

        userSelect.innerHTML = '<option value="">Select a user...</option>';

        if (data.users && data.users.length > 0) {
            data.users.forEach(user => {
                const option = document.createElement('option');
                option.value = user.id;
                option.textContent = `${user.username}${user.email ? ` (${user.email})` : ''}`;
                userSelect.appendChild(option);
            });
        } else {
            userSelect.innerHTML = '<option value="" disabled>No users available</option>';
        }
    })
    .catch(error => {
        console.error('Error loading available users:', error);
        const userSelect = document.getElementById('shareUserSelect');
        if (userSelect) {
            userSelect.innerHTML = '<option value="" disabled>Error loading users</option>';
        }
    });
}

function shareTunnel() {
    const userId = document.getElementById('shareUserSelect').value;
    const permissionType = document.getElementById('permissionSelect').value;

    if (!userId) {
        Swal.fire({
            icon: 'warning',
            title: 'No User Selected',
            text: 'Please select a user to share with.',
        });
        return;
    }

    const accessToken = localStorage.getItem('accessToken');

    fetch(`/tunnels/share/${currentSharingTunnelId}`, {
        method: "POST",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            shared_with_user_id: parseInt(userId),
            permission_type: permissionType
        })
    })
    .then(response => {
        const isOk = response.ok;
        return response.json().then(data => ({ data, isOk, response }));
    })
    .then(({ data, isOk }) => {
        if (isOk) {
            Swal.fire({
                icon: 'success',
                title: 'Success',
                text: 'Tunnel shared successfully!',
                showConfirmButton: false,
                timer: 1500
            });

            // Refresh the shared users list and available users
            loadSharedUsers(currentSharingTunnelId);
            loadAvailableUsers(currentSharingTunnelId);

            // Clear the form and disable button
            document.getElementById('shareUserSelect').value = '';
            document.getElementById('permissionSelect').value = 'view';
            document.getElementById('shareButton').disabled = true;
        } else {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: data.error || 'Failed to share tunnel.',
            });
        }
    })
    .catch(error => {
        console.error('Error sharing tunnel:', error);
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: 'Failed to share tunnel.',
        });
    });
}

function updateSharingPermission(userId, permissionType, selectElement) {
    const accessToken = localStorage.getItem('accessToken');

    fetch(`/tunnels/update-permission/${currentSharingTunnelId}/${userId}`, {
        method: "PATCH",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            permission_type: permissionType
        })
    })
    .then(response => {
        const isOk = response.ok;
        return response.json().then(data => ({ data, isOk, response }));
    })
    .then(({ data, isOk }) => {
        if (isOk) {
            // Refresh the shared users list to show updated permissions
            loadSharedUsers(currentSharingTunnelId);
        } else {
            Swal.fire({
                icon: 'error',
                title: 'Error',
                text: data.error || 'Failed to update permission.',
            });
            // Revert the select value
            if (selectElement) {
                // Revert to previous value - this would need more complex state management
                loadSharedUsers(currentSharingTunnelId);
            }
        }
    })
    .catch(error => {
        console.error('Error updating sharing permission:', error);
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: 'Failed to update permission.',
        });
        // Revert the select value
        if (selectElement) {
            loadSharedUsers(currentSharingTunnelId);
        }
    });
}

function unshareTunnel(userId) {
    const accessToken = localStorage.getItem('accessToken');

    fetch(`/tunnels/unshare/${currentSharingTunnelId}/${userId}`, {
        method: "DELETE",
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    })
    .then(response => {
        if (response.ok) {
            Swal.fire({
                icon: 'success',
                title: 'Success',
                text: 'Tunnel unshared successfully!',
                showConfirmButton: false,
                timer: 1500
            });

            // Refresh the shared users list and available users
            loadSharedUsers(currentSharingTunnelId);
            loadAvailableUsers(currentSharingTunnelId);
        } else {
            return response.json().then(data => {
                Swal.fire({
                    icon: 'error',
                    title: 'Error',
                    text: data.error || 'Failed to unshare tunnel.',
                });
            });
        }
    })
    .catch(error => {
        console.error('Error unsharing tunnel:', error);
        Swal.fire({
            icon: 'error',
            title: 'Error',
            text: 'Failed to unshare tunnel.',
        });
    });
}

document.addEventListener('DOMContentLoaded', function() {
    fetchAndDisplayReverseServerKeys();
    tunnelNotificationWebsocket();
    validateSSHPortInputs();
});

// Function to switch display mode without re-rendering DOM
function switchDisplayMode() {
    const isMobile = window.innerWidth < 768;
    const tableContainer = document.querySelector('.table-responsive');
    const cardsContainerWrapper = document.getElementById('tunnelsCardsWrapper');

    if (isMobile) {
        if (tableContainer) tableContainer.style.display = 'none';
        if (cardsContainerWrapper) cardsContainerWrapper.style.display = 'block';
    } else {
        if (tableContainer) tableContainer.style.display = 'block';
        if (cardsContainerWrapper) cardsContainerWrapper.style.display = 'none';
    }

    // Switch action button visibility based on screen size
    switchActionButtonVisibility();
}

// Function to switch action button visibility without re-rendering
function switchActionButtonVisibility() {
    const isXLarge = window.innerWidth >= 1400; // xl breakpoint - increased for better button display
    const isLarge = window.innerWidth >= 992 && window.innerWidth < 1400; // lg to xl
    const isMedium = window.innerWidth >= 768 && window.innerWidth < 992; // md to lg
    const isSmall = window.innerWidth < 768; // sm and below

    // Get all action button containers
    const fullButtons = document.querySelectorAll('.action-buttons-full');
    const scrollableLgButtons = document.querySelectorAll('.d-none.d-lg-flex.d-xl-none.action-buttons-scrollable');
    const scrollableMdButtons = document.querySelectorAll('.d-none.d-md-flex.d-lg-none.action-buttons-scrollable');
    const mobileButtons = document.querySelectorAll('.action-buttons-mobile');

    fullButtons.forEach(btn => {
        btn.style.display = isXLarge ? 'flex' : 'none';
    });

    // Show scrollable buttons for large screens (992px to 1399px)
    scrollableLgButtons.forEach(btn => {
        btn.style.display = isLarge ? 'block' : 'none';
    });

    // Show scrollable buttons for medium screens (768px to 991px)
    scrollableMdButtons.forEach(btn => {
        btn.style.display = isMedium ? 'block' : 'none';
    });

    mobileButtons.forEach(btn => {
        btn.style.display = isSmall ? 'block' : 'none';
    });
}

// Function to display reverse server keys and immediately fetch status
function displayReverseServerKeysWithStatus(data) {
    displayReverseServerKeys(data);
    // Immediately fetch and update status after re-rendering
    fetchStatusAndUpdate();
}

// Function to fetch status data and update existing tunnels
function fetchStatusAndUpdate() {
    const accessToken = localStorage.getItem('accessToken');
    if (!accessToken) return;

    fetch('/api/reverse/server/status/ports', {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(statusData => {
        // Update status for existing tunnels
        if (globalThis.data) {
            globalThis.data.forEach(item => {
                const hostFriendlyName = item.host_friendly_name;
                const reversePort = item.reverse_port;

                // Determine if the port is active based on the status data
                const isActive = statusData[reversePort] || false;
                updateStatus(isActive, hostFriendlyName);
            });
        }
    })
    .catch(error => {
        console.error('Error fetching status data:', error);
    });
}

// Debounce function to limit how often resize events trigger
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
