
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
                <button class="btn btn-danger btn-sm me-3" onclick="deleteUserKey(event, ${item.id})">Delete</button>
            `;

            const row = `
            <tr onclick="showKeyDetails('${item.hostname}', '${item.key}', ${item.description})">
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

function showKeyDetails(hostname, key, description) {
    // Populate the modal with key information
    document.getElementById('keyHostname').textContent = `Hostname: ${hostname}`;
    document.getElementById('keyTextArea').value = key;
    if (description) {
        document.getElementById('keyDescriptionText').textContent = `Description: ${description}`;
    } else {
        document.getElementById('keyDescriptionText').textContent = 'No description provided.';
    }

    // Show the modal
    var keyDetailsModal = new bootstrap.Modal(document.getElementById('keyDetailsModal'));
    keyDetailsModal.show();
}

function copyKeyToClipboard() {
    var keyTextArea = document.getElementById('keyTextArea');
    keyTextArea.select(); // Select the text
    document.execCommand('copy'); // Execute copy command
    Swal.fire({
        icon: 'success',
        title: 'Success',
        text: 'Key has been copied to clipboard.',
        showConfirmButton: false,
        timer: 800
    })
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
            // Instead of throwing an error immediately, parse the response and throw it
            return response.json().then(err => {
                throw err;
            });
        }
    })
    .then(data => {
        console.log('Success:', data);
        $('#createKeyModal').modal('hide');
        Swal.fire("Success", "Key has been successfully added.", "success");
    })
    .catch((error) => {
        // Now error will be the JSON error response from the server
        console.error('Error:', error);
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: error.key || 'Failed to create user key', // Displaying the error message
        });
    });
}


function deleteUserKey(event, keyId) {
    event.stopPropagation(); // Stop the event from bubbling up

    const accessToken = localStorage.getItem('accessToken');

    fetch(`/api/reverse/user/keys/${keyId}`, {
        method: "DELETE",
        headers: {
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => {
        if (response.ok) {
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

function keyNotificationWebsocket() {
    var socket = notificationWebsocket();
    socket.onmessage = function (event) {
        const data = JSON.parse(event.data);
        console.log('Notification message:', data.message);
        let action = data.message.action;
        createToastAlert(data.message.details, false);
        if (action === "CREATED-USER-KEYS" || action === "DELETED-USER-KEYS") {
            fetchAndDisplayUserKeys();
        }
    };
}

document.addEventListener('DOMContentLoaded', fetchAndDisplayUserKeys);
document.addEventListener('DOMContentLoaded', keyNotificationWebsocket);