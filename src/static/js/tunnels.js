
globalThis.data = [];

function fetchAndDisplayReverseServerKeys() {
    const accessToken = localStorage.getItem('accessToken');

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
        });
    })
    .catch(error => {
        console.error('Error fetching tunnels data:', error);
    });
}

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
        const hostFriendlyName = data.hostFriendlyName;
        const key = data.key;
        const description = data.description;

        document.getElementById('tunnelHostFriendlyName').textContent = hostFriendlyName;
        document.getElementById('tunnelKeyTextArea').value = key;
        document.getElementById('tunnelDescriptionText').value = description;

        // Store the original values as data attributes
        document.getElementById('tunnelDetailsModal').dataset.originalDescription = description;

        // Disable the save button by default
        document.querySelector('#tunnelDetailsModal .btn-outline-success').disabled = true;

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
    document.getElementById('tunnelDescriptionText').value = '';
    document.querySelector('#tunnelDetailsModal .btn-outline-success').disabled = true;
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
    table.innerHTML = '';

    data.forEach(item => {
        const actionButtons = createActionButtons(item);
        const row = createTableRow(item, actionButtons);
        table.innerHTML += row;
    });
}

function createActionButtons(item) {
    const itemId = item.id;

    // Add `event.stopPropagation()` to avoid triggering the row click event
    return `
        <button class="btn btn-warning btn-sm me-2" onclick="event.stopPropagation(); window.open('/tunnels/terminal/${itemId}')">Console</button>
        <button class="btn btn-primary btn-sm me-2" onclick="event.stopPropagation(); openUserManagementModal('${itemId}')">Users</button>
        <button class="btn btn-info btn-sm me-2" onclick="event.stopPropagation(); fetchServerConfig(${itemId})">Config</button>
        <button class="btn btn-secondary btn-sm me-2" onclick="event.stopPropagation(); showServerScriptModal('${itemId}')">Script</button>
        <button class="btn btn-danger btn-sm me-2" onclick="event.stopPropagation(); confirmDelete('${itemId}')">Delete</button>
    `;
}

function createTableRow(item, actionButtons) {

    const itemId = item.id;
    const hostFriendlyName = item.host_friendly_name;
    const reversePort = item.reverse_port;

    return `
        <tr onclick="showTunnelDetails('${itemId}')">
            <td>${hostFriendlyName}</td>
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
            Swal.fire("Deleted!", "The key has been deleted.", "success");
            // Optionally, refresh the list of keys or remove the row from the table
        } else {
            Swal.fire("Error", "There was an error deleting the key.", "error");
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

    const saveButton = document.querySelector('#tunnelDetailsModal .btn-outline-success');
    if (originalDescription !== currentDescription) {
        saveButton.disabled = false;
    } else {
        saveButton.disabled = true;
    }
}


function openUserManagementModal(serverId) {
    $('#manageUsersModal').modal('show');

    const addUserButtonContainer = document.getElementById('addUserButtonContainer');
    addUserButtonContainer.innerHTML = ''; // Clear previous button if any

    const addUserButton = document.createElement('button');
    addUserButton.classList.add('btn', 'btn-outline-secondary');
    addUserButton.textContent = 'Add User';
    addUserButton.onclick = function() {
        addUser(serverId);
    };

    addUserButtonContainer.appendChild(addUserButton);

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
      userListDiv.innerHTML = ''; // Clear current list

      if (users.length === 0) {
        userListDiv.innerHTML = '<p class="text-muted">No users found.</p>';
      } else {
        const listGroup = document.createElement('ul');
        listGroup.className = 'list-group';

        users.forEach(user => {
          const listItem = document.createElement('li');
          listItem.className = 'list-group-item d-flex justify-content-between align-items-center';

          listItem.innerHTML = `
            <span>${user.username}</span>
            <button class="btn btn-danger btn-sm">Delete</button>
          `;

          const deleteUserBtn = listItem.querySelector('button');
          // Pass the serverId along with the userId to the deleteUser function
          deleteUserBtn.onclick = () => deleteUser(user.id, serverId);

          listGroup.appendChild(listItem);
        });

        userListDiv.appendChild(listGroup);
      }
    });
}

function addUser(serverId) {
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
        // Handle the error, possibly show a message to the user
      }
    });
}

function deleteUser(userId, serverId) { // Add serverId parameter
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
      }
    });
}

function tunnelNotificationWebsocket() {
    var socket = notificationWebsocket();
    socket.onmessage = function (event) {
        const data = JSON.parse(event.data);
        console.log('Notification message:', data.message);
        let action = data.message.action;
        createToastAlert(data.message.details, false);
        if (action === "UPDATED-TUNNELS") {
            fetchAndDisplayReverseServerKeys();
        }
        if (action === "UPDATE-TUNNEL-STATUS-DATA") {
            globalThis.data.forEach(item => {
                // If port not in message data, it means it's not active 
                const hostFriendlyName = item.host_friendly_name;
                const reversePort = item.reverse_port;

                if (!data.message.data.includes(reversePort)) {
                    updateStatus(false, hostFriendlyName);
                } else {
                    updateStatus(true, hostFriendlyName);
                }
            });
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

        if (!sshPort) {
            console.error('SSH port is empty');
            return;
        }

        if (!isValidPort(sshPort)) {
            console.error('Invalid SSH port:', sshPort);
            return;
        }

        // Fetch the SSH script
        const sshScriptData = await fetchSSHScript(`/tunnels/server/script/autossh/${serverId}/${sshPort}`);

        // If service script is not available, it means the user have not add usernames to this server
        let sshServiceScriptData = {};
        try {
            sshServiceScriptData = await fetchSSHScript(`/tunnels/server/script/autossh-service/${serverId}/${sshPort}`);
        } catch (error) {
            console.error('Error fetching SSH service script:', error);
            sshServiceScriptData = {
                script: 'No usernames added to this server yet.',
                language: 'bash'
            };
        }

        // Fetch the PowerShell script
        const powershellScriptData = await fetchSSHScript(`/tunnels/server/script/powershell/${serverId}/${sshPort}`);

        // Check if Prism is available and highlight the code
        if (Prism && Prism.highlight && sshScriptData.script && sshServiceScriptData.script && powershellScriptData.script) {
            document.getElementById('tunnelCommandSSH').innerHTML = Prism.highlight(sshScriptData.script, Prism.languages[sshScriptData.language], sshScriptData.language);
            document.getElementById('tunnelCommandSSHService').innerHTML = Prism.highlight(sshServiceScriptData.script, Prism.languages[sshServiceScriptData.language], sshServiceScriptData.language);

            document.getElementById('tunnelCommandSSHServiceSteps').innerHTML = Prism.highlight(
                "sudo systemctl daemon-reload\nsudo systemctl start autossh.service\nsudo systemctl enable autossh.service"
                , Prism.languages['bash'], 'bash'
            );

            document.getElementById('tunnelCommandPowershell').innerHTML = Prism.highlight(powershellScriptData.script, Prism.languages[powershellScriptData.language], powershellScriptData.language);
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
    // Re-fetch script content when SSH port changes and update the modal content
    document.getElementById('sshPort').onchange = async () => {
        // Close the old modal
        await updateServerScriptContent(serverId);
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


document.addEventListener('DOMContentLoaded', function() {
    fetchAndDisplayReverseServerKeys();
    tunnelNotificationWebsocket();
    validateSSHPortInputs();
});

