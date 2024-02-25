
function getDisplayValue(value, defaultValue = 'N/A') {
    return value ? value : defaultValue;
}

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
            } else {
                location.reload();
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
            confirmButtonText: 'Select',
            showDenyButton: true,
            denyButtonText: 'Delete',
            allowOutsideClick: false, // Prevent closing by clicking outside,
            backdrop: `
            rgba(20, 20, 20, 0.9)
            url("/api/__hidden_statics/images/nyan-cat.gif")
            left top
            no-repeat
          `,
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
                    allowOutsideClick: false,
                    inputValidator: (value) => {
                        if (!value) {
                            return 'You need to enter a username!'
                        }
                    },
                    willClose: () => {
                        // If user cancels the delete action, reload the page
                        location.reload();
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
                            location.reload();
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
                location.reload();
            } else {
                location.reload();
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

document.getElementById('checkServiceKeyBtn').addEventListener('click', function() {
    const accessToken = localStorage.getItem('accessToken');
    fetch('/api/reverse/service/keys', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
    })
    .then(response => response.json())
    .then(data => {
        if (data && data.length > 0) {
            const keyInfo = data[0]; // Assuming you want to show the first key for simplicity
            Swal.fire({
                title: 'Service Key',
                html: `
                  <p>Service: <strong>${keyInfo.service}</strong></p>
                  <p>Key</p>
                  <textarea id="serviceKeyText" readonly style="width: 100%; height: 180px; margin-top: 10px; background-color: #F0F0F0; border: 1px solid #ccc; box-shadow: inset 0 1px 1px rgba(0,0,0,.075); padding: 10px; border-radius: 4px;">${keyInfo.key}</textarea>
                `,
                showCancelButton: true,
                confirmButtonText: 'Copy Key',
                cancelButtonText: 'OK',
                preConfirm: () => {
                    const copyText = document.getElementById("serviceKeyText");
                    copyText.select();
                    document.execCommand("copy");
                    Swal.fire('Copied!', 'The key has been copied to clipboard.', 'success');
                },
                footer: '<button id="reloadButton" class="swal2-styled">Reload</button>'
            }).then((result) => {
                if (result.dismiss === Swal.DismissReason.cancel) {
                    Swal.close();
                }
            });

            // Add click event listener for the Reload button in the footer
            document.getElementById('reloadButton').addEventListener('click', function() {
                location.reload();
            });
        } else {
            Swal.fire('No Service Key Found', 'Please ensure you have a service key available.', 'info');
        }
    })
    .catch(error => {
        console.error('Error fetching service keys:', error);
        Swal.fire('Error', 'Failed to fetch service keys.', 'error');
    });
});

