
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

function showTunnelDetails(hostFriendlyName, key, description) {
    // Populate the modal with tunnel information
    document.getElementById('tunnelHostFriendlyName').textContent = hostFriendlyName;
    document.getElementById('tunnelKeyTextArea').value = key;

    if (description) {
        document.getElementById('tunnelDescriptionText').textContent = description;
    } else {
        document.getElementById('tunnelDescriptionText').textContent = 'No description provided.';
    }

    // Show the modal
    var tunnelDetailsModal = new bootstrap.Modal(document.getElementById('tunnelDetailsModal'));
    tunnelDetailsModal.show();
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

    return `
        <button class="btn btn-warning btn-sm me-2" onclick="window.open('/tunnels/terminal/${itemId}')">Console</button>
        <button class="btn btn-primary btn-sm me-2" onclick="openUserManagementModal('${itemId}')">Users</button>
        <button class="btn btn-info btn-sm me-2" onclick="fetchServerConfig(${itemId})">Config</button>
        <button class="btn btn-secondary btn-sm me-2" onclick="showServerScriptModal('${itemId}')">Script</button>
        <button class="btn btn-danger btn-sm me-2" onclick="confirmDelete('${itemId}')">Delete</button>
    `;
}

function createTableRow(item, actionButtons) {

    const itemId = item.id;
    const hostFriendlyName = item.host_friendly_name;
    const reversePort = item.reverse_port;
    const publicKey = item.key;
    const itemDescription = item.description;

    return `
        <tr onclick="showTunnelDetails('${hostFriendlyName}', '${publicKey}', '${itemDescription}')">
            <td>${hostFriendlyName}</td>
            <td>${reversePort}</td>
            <td>
                <div class='d-flex'>
                    <div class="${hostFriendlyName}-status status ml-2" id="${hostFriendlyName}-status"></div>
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
        const linuxScriptData = await fetchSSHScript(`/tunnels/server/script/autossh/${serverId}/${sshPort}`);
        const windowsScriptData = await fetchSSHScript(`/tunnels/server/script/windows/${serverId}/${sshPort}`);

        // Check if Prism is available and highlight the code
        if (Prism && Prism.highlight && linuxScriptData.script && windowsScriptData.script) {
            document.getElementById('tunnelCommandLinux').innerHTML = Prism.highlight(linuxScriptData.script, Prism.languages[linuxScriptData.language], linuxScriptData.language);
            document.getElementById('tunnelCommandWindows').innerHTML = Prism.highlight(windowsScriptData.script, Prism.languages[windowsScriptData.language], windowsScriptData.language);
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

