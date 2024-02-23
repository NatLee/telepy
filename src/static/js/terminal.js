
function getDisplayValue(value, defaultValue = 'N/A') {
    return value ? value : defaultValue;
}

const showError = (error) => {
    Swal.fire({
        title: 'Error!',
        text: error.toString(),
        icon: 'error',
        confirmButtonText: 'OK'
    }).then((result) => {
        // Redirect to login page after user clicks 'OK'
        if (result.isConfirmed || result.isDismissed) {
            window.location.href = '/login';
        }
    });
};


function setupWebSocketConnection(serverID, username) {
    // Assuming Terminal and fit are properly imported and available
    Terminal.applyAddon(fit);

    const ws_scheme = window.location.protocol === "https:" ? "wss" : "ws";
    // Include the token in the query string of the WebSocket URL
    const accessToken = localStorage.getItem('accessToken');
    const ws_path = `${ws_scheme}://${window.location.host}/ws/terminal/?token=${accessToken}&server_id=${serverID}&username=${username}`;
    const socket = new WebSocket(ws_path);

    // Convert and send a message to the server
    function sendWebSocketMessage(action, payload) {
        socket.send(JSON.stringify({ action: action, payload: payload }));
    }

    const status = document.getElementById("status");
    const term = new Terminal({ cursorBlink: true });

    term.open(document.getElementById('terminal'));
    // Automatically fit the terminal to its container size
    term.fit();

    // Send key inputs and paste events to the server
    term.on('key', (key, ev) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? ev.metaKey : ev.ctrlKey;

        if (ctrlKey && key === 'c' && term.hasSelection()) {
            // Copy to clipboard
            navigator.clipboard.writeText(term.getSelection());
        } else {
            // Send other key inputs to the server
            sendWebSocketMessage("pty_input", { input: key });
        }
    });

    term.on('paste', (data) => {
        sendWebSocketMessage("pty_input", { input: data });
    });

    // Handle incoming WebSocket messages
    socket.onmessage = function(event) {
        // Assuming the server sends back plain text data; adjust if JSON
        term.write(event.data);
    };

    socket.onopen = function() {
        console.log("WebSocket connection established");
        status.innerHTML = '<span style="background-color: lightgreen;">connected</span>';
        // Send an initial message or perform an action upon connection
        // For instance, resizing the terminal or sending a welcome message
        term.focus();
    };

    socket.onclose = function(event) {
        console.log('Connection closed');
        status.innerHTML = '<span style="background-color: #ff8383;">disconnected</span>';
    };

    socket.onerror = function(error) {
        console.error(`WebSocket error observed: ${error}`);
    };
}

function getPathSegments() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
        console.error('Unexpected pathname format:', window.location.pathname);
        return null;
    }
    return segments[2];
}

const serverID = getPathSegments();

console.log(`Server ID:` + serverID);

const accessToken = localStorage.getItem('accessToken');

fetch(`/api/reverse/server/${serverID}/usernames`, {
    headers: {
        'Authorization': `Bearer ${accessToken}`
    }
})
.then(response => response.json())
.then(data => {
    if (data.length === 0) {
        // No usernames available, prompt the user to create one with Swal
        Swal.fire({
            title: 'Create Username',
            text: 'No usernames found for this server. Please enter a username to create:',
            input: 'text',
            showCancelButton: false,
            allowOutsideClick: false,
            inputValidator: (value) => {
                if (!value) {
                    return 'You need to write something!'
                }
            }
        }).then((result) => {
            if (result.value) {
                // POST request to create a new username
                fetch('/api/reverse/server/usernames', {
                    method: 'POST',
                    headers: {
                        'Authorization': `Bearer ${accessToken}`,
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ reverse_server: serverID, username: result.value })
                }).then(response => {
                    if(response.ok) {
                        setupWebSocketConnection(serverID, result.value);
                    } else {
                        Swal.fire({
                            title: 'Error!',
                            text: 'Failed to create username',
                            icon: 'error',
                            confirmButtonText: 'OK'
                        });
                    }
                });
            }
        });
    } else {
        // Enhanced username selection with delete option
        Swal.fire({
            title: 'Select or Delete a Username',
            text: 'Select a username or delete one.',
            input: 'select',
            inputOptions: data.reduce((acc, curr) => ({...acc, [curr.username]: curr.username}), {}),
            inputPlaceholder: 'Select a username',
            showCancelButton: true,
            confirmButtonText: 'Select',
            showDenyButton: true,
            denyButtonText: 'Delete',
            preConfirm: (username) => {
                return username; // For selection
            },
            preDeny: () => {
                return Swal.fire({
                    title: 'Delete Username',
                    text: 'Enter the username to delete:',
                    input: 'text',
                    showCancelButton: true,
                    confirmButtonText: 'Delete',
                    inputValidator: (value) => {
                        if (!value) {
                            return 'You need to enter a username!'
                        }
                    }
                }).then((deleteResult) => {
                    const usernameID = data.find((item) => item.username === deleteResult.value).id;
                    if (deleteResult.value) {
                        // DELETE request to remove a username
                        return fetch(`/api/reverse/server/usernames/${usernameID}`, {
                            method: 'DELETE',
                            headers: {
                                'Authorization': `Bearer ${accessToken}`,
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ username: deleteResult.value })
                        }).then(deleteResponse => {
                            if(deleteResponse.ok) {
                                Swal.fire('Deleted!', 'The username has been deleted.', 'success');
                            } else {
                                Swal.fire('Failed!', 'Could not delete the username.', 'error');
                            }
                            return 'deleted'; // Indicate delete action complete
                        });
                    }
                });
            }
        }).then((result) => {
            if (result.value) {
                // Setup WebSocket connection with selected username
                setupWebSocketConnection(serverID, result.value);
            } else if (result.dismiss === Swal.DismissReason.deny) {
                // Reload or refresh data after deletion
                // Consider calling a function here that refreshes the username list
            }
        });
    }
})
.catch(error => {
    Swal.fire({
        title: 'Error!',
        text: 'An error occurred',
        icon: 'error',
        confirmButtonText: 'OK'
    });
});