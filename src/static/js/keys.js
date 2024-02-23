
function fetchAndDisplayUserKeys() {
    const accessToken = localStorage.getItem('accessToken');

    fetch('/api/reverse/user/keys', {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => {
        if (response.ok) {
            return response.json();
        } else {
            throw new Error('Failed to fetch user keys: ' + response.statusText);
        }
    })
    .then(data => {
        const table = document.getElementById('userTableBody');
        table.innerHTML = '';

        data.forEach(item => {
            const actionButtons = `
                <button class="btn btn-danger btn-sm me-3" onclick="deleteUserKey(${item.id})">Delete</button>
            `;

            const row = `
            <tr>
                <td>${item.hostname}</td>
                <td>${item.key.substring(0, 20) || '&lt;none&gt;'}...</td>
                <td>
                    <div class='d-flex' id="actions-${item.id}">
                        ${actionButtons}
                    </div>
                </td>
            </tr>`;
            table.innerHTML += row;
        });
    })
    .catch(error => {
        console.error('Error fetching user keys data:', error);
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: error.toString(),
        });
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
        if (action === "CREATED-USER-KEYS" || action === "DELETED-USER-KEYS") {
            createToastAlert(data.message.details, false);
            fetchAndDisplayUserKeys();
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

function createKeys() {
    $('#createKeyModal').modal('show');
}

function submitNewKey() {
    const hostname = document.getElementById('hostname').value;
    const publicKey = document.getElementById('publicKey').value;
    const description = document.getElementById('description').value;

    if (!isValidSSHKey(publicKey)) {
        Swal.fire("Error", "Invalid SSH key format.", "error");
        return;
    }

    const accessToken = localStorage.getItem('accessToken');
    fetch('/api/reverse/user/keys', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify({
            hostname: hostname,
            key: publicKey,
            description: description
        })
    })
    .then(response => {
        if (response.ok) {
            return response.json();
        } else {
            throw new Error('Failed to submit the key: ' + response.statusText);
        }
    })
    .then(data => {
        console.log('Success:', data);
        $('#createKeyModal').modal('hide');
        Swal.fire("Success", "Key has been successfully added.", "success");
    })
    .catch((error) => {
        console.error('Error:', error);
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: error.toString(),
        });
    });
}

function deleteUserKey(keyId) {
    const accessToken = localStorage.getItem('accessToken');

    fetch(`/api/reverse/user/keys/${keyId}`, {
        method: "DELETE",
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => {
        if (response.ok) {
            // Refresh the list or remove the row from the table
            fetchAndDisplayUserKeys(); // Refresh the keys list to reflect the deletion
        } else {
            throw new Error('Failed to delete user key: ' + response.statusText);
        }
    })
    .catch(error => {
        console.error('Error deleting user key:', error);
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: error.toString(),
        });
    });
}

document.addEventListener('DOMContentLoaded', fetchAndDisplayUserKeys);
document.addEventListener('DOMContentLoaded', notificationWebsocket);