
function fetchAndDisplayReverseServerKeys() {
    // Retrieve the JWT from local storage
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
        const table = document.getElementById('tunnelsTableBody');
        table.innerHTML = '';

        data.forEach(item => {
            const actionButtons = `
                <button class="btn btn-warning btn-sm me-2" onclick="window.open('/tunnels/terminal/${item.id}')">Console</button>
                <button class="btn btn-primary btn-sm me-2" onclick="openUserManagementModal('${item.id}')">Users</button>
                <button class="btn btn-info btn-sm me-2" onclick="fetchServerConfig(${item.id})">Config</button>
                <button class="btn btn-danger btn-sm me-2" onclick="confirmDelete('${item.id}')">Delete</button>
            `;

            const row = `
            <tr>
                <td>${item.hostname}</td>
                <td>${item.reverse_port}</td>
                <td>${item.key.substring(0, 20) || '&lt;none&gt;'}...</td>
                <td>
                    <div class='d-flex'>
                        <div class="${item.hostname}-status status ml-2" id="${item.hostname}-status"></div>
                    </div>
                </td>
                <td>
                    <div class='d-flex' id="actions-${item.id}">
                        ${actionButtons}
                    </div>
                </td>
            </tr>`;
            table.innerHTML += row;
        });

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
            // Define a function to update the status of the port
            function updateStatus(isConnected, hostname) {
                const statusElement = document.getElementById(`${hostname}-status`);
                if (statusElement) {
                    statusElement.classList.toggle('connected', isConnected);
                    statusElement.classList.toggle('disconnected', !isConnected);
                }
            }
            // Iterate through each item again to update their status
            data.forEach(item => {
                // Determine if the port is active based on the status data
                const isActive = statusData[item.reverse_port];
                // Call the updateStatus function with the isActive status and hostname
                updateStatus(isActive, item.hostname);
            });
        });
    })

    .catch(error => {
        console.error('Error fetching tunnels data or status:', error);
    });
}

function notificationWebsocket() {

    var ws_scheme = window.location.protocol == "https:" ? "wss" : "ws";
    var ws_path = ws_scheme + '://' + window.location.host + "/ws/notifications/";
    var socket = new WebSocket(ws_path);

    // Update the status of the WebSocket connection
    function updateWebSocketStatus(isConnected) {
        const statusElement = document.getElementById("websocket-status");
        if (statusElement) {
            statusElement.classList.toggle('connected', isConnected);
            statusElement.classList.toggle('disconnected', !isConnected);
        }
    }

    socket.onopen = function () {
        updateWebSocketStatus(true);
    };

    socket.onmessage = function (event) {
        const data = JSON.parse(event.data);
        console.log('Notification message:', data.message);
        let action = data.message.action;
        if (action === "UPDATED-TUNNELS") {
            createToastAlert(data.message.details, false);
            fetchAndDisplayReverseServerKeys();
        }

    };

    socket.onclose = function (e) {
        updateWebSocketStatus(false);
        console.error('Notification WebSocket closed unexpectedly:', e);

        // Reconnect after 3 seconds
        setTimeout(notificationWebsocket, 3000);
    };

    // Handle any errors that occur.
    socket.onerror = function (error) {
        updateWebSocketStatus(false);
        console.error('WebSocket Error:', error);
    };

}

function fetchServerConfig(serverId) {
    const accessToken = localStorage.getItem('accessToken');
    const hostname = window.location.hostname;

    fetch(`/tunnels/server/${hostname}/config/${serverId}`, {
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

document.addEventListener('DOMContentLoaded', fetchAndDisplayReverseServerKeys);
document.addEventListener('DOMContentLoaded', notificationWebsocket);