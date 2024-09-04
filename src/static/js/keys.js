
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
            const itemId = item.id;
            const hostFriendlyName = item.host_friendly_name;

            const actionButtons = `
                <button class="btn btn-danger btn-sm me-3" onclick="deleteUserKey(event, ${itemId})">Delete</button>
            `;
    
            const row = `
            <tr onclick="showKeyDetails('${itemId}')">
                <td>${hostFriendlyName}</td>
                <td>
                    <div class='d-flex' id="actions-${itemId}">
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

function showKeyDetails(keyId) {
    // Populate the modal with key information
    document.getElementById('keyId').textContent = keyId;

    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/reverse/user/keys/${keyId}`, {
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

        document.getElementById('keyHostFriendlyName').textContent = hostFriendlyName;
        document.getElementById('keyTextArea').value = key;
        document.getElementById('keyDescriptionText').value = description;

        // Store the original values as data attributes
        document.getElementById('keyDetailsModal').dataset.originalDescription = description;

        // Disable the save button by default
        document.querySelector('#keyDetailsModal .btn-outline-success').disabled = true;

        // Show the modal
        var keyDetailsModal = new bootstrap.Modal(document.getElementById('keyDetailsModal'));
        keyDetailsModal.show();
    }).catch(error => {
        console.error('Error fetching key details:', error);
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: error.toString(),
        });
    });
}

function resetKeyDetailsModalState() {
    document.getElementById('keyDescriptionText').value = '';
    document.querySelector('#keyDetailsModal .btn-outline-success').disabled = true;
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
    const hostFriendlyName = document.getElementById('hostFriendlyName').value;
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
            host_friendly_name: hostFriendlyName, // `host_friendly_name` is the key name in the API
            key: publicKey, // key is the public key in the API
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
        const errorMsgPublicKey = error.key;
        const errorMsgHostFriendlyName = error.host_friendly_name;
        Swal.fire({
            icon: 'error',
            title: 'Oops...',
            text: errorMsgPublicKey || errorMsgHostFriendlyName || 'Failed to create user key', // Displaying the error message
        });
    });
}

function autoFillHostFriendlyName() {
    // Add a listener to SSH key input field, if user pastes a key and host friendly hasn't been filled, try to extract the host friendly name from the key
    document.getElementById('publicKey').addEventListener('input', function() {
      const key = document.getElementById('publicKey').value;
      const hostFriendlyName = document.getElementById('hostFriendlyName').value;
      document.getElementById('hostFriendlyName').value = getHostFriendlyNameFromKey(key, hostFriendlyName);
    });
}

function validateInputPublicKey() {
    $('[data-toggle="tooltip"]').tooltip({trigger: 'manual'}).tooltip('hide');
  
    document.getElementById('publicKey').addEventListener('input', function() {
      // Trim the input value
      const keyElement = document.getElementById('publicKey');
      keyElement.value = keyElement.value.trim();
      const publicKey = keyElement.value;
      if (isValidSSHKey(publicKey)) {
        $('#publicKey').tooltip('hide');
        document.getElementById('publicKey').classList.remove('is-invalid');
        document.getElementById('publicKey').classList.add('is-valid');
      } else {
        $('#publicKey').tooltip('show');
        document.getElementById('publicKey').classList.remove('is-valid');
        document.getElementById('publicKey').classList.add('is-invalid');
      }
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


function saveDescription() {
    const keyId = document.getElementById('keyId').textContent;
    const newDescription = document.getElementById('keyDescriptionText').value;

    const accessToken = localStorage.getItem('accessToken');

    fetch(`/api/reverse/user/keys/${keyId}`, {
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
            text: 'User key information has been updated successfully.',
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

function checkKeyDetailsModalForChanges() {
    const modal = document.getElementById('keyDetailsModal');
    const originalDescription = modal.dataset.originalDescription;
    const currentDescription = document.getElementById('keyDescriptionText').value;

    const saveButton = document.querySelector('#keyDetailsModal .btn-outline-success');
    if (originalDescription !== currentDescription) {
        saveButton.disabled = false;
    } else {
        saveButton.disabled = true;
    }
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


document.addEventListener('DOMContentLoaded', function() {
  fetchAndDisplayUserKeys();
  autoFillHostFriendlyName();
  validateInputPublicKey();
  keyNotificationWebsocket();
});
  