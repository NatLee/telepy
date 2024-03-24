
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
        if (socket.readyState !== WebSocket.OPEN) {
            console.error('WebSocket is not open');
            return;
        }
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
        // Make the terms color darker to hint the user that the connection is closed
        term.setOption('theme', {
            background: '#1e1e1e',
            foreground: '#707070',
        });
    };

    socket.onerror = function(event) {
        console.error(`WebSocket error observed: `, event);
    
        // Extracting error message
        let errorMessage = "Unknown error";
        if (event instanceof ErrorEvent) {
            errorMessage = event.message;
        } else if (event && event.type === 'error' && typeof event.reason === 'string') {
            errorMessage = event.reason;
        }
    
        Swal.fire({
            icon: 'error',
            title: 'WebSocket Error',
            text: 'A WebSocket error has occurred. Check your permissions and network connection.',
        });
    };
}

function shellType() {
    const accessToken = localStorage.getItem('accessToken');
    fetch(`/api/sftp/shell/${serverID}/${window.username}`, {
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    }).then(
        response => response.json()
    ).then(
        data => {
            if (data.error) {
                console.error('Error fetching shell:', data.error);
                return;
            }
            console.log('Shell:', data.shell);
            if (data.shell === 'powershell') {
                // Remove readonly attribute from the search input for PowerShell
                document.getElementById('shellType').innerHTML = '<span style="background-color: lightblue;">' + getDisplayValue(data.shell) + '</span>';
                document.getElementById('searchPath').removeAttribute('readonly');
                // Give default path for PowerShell
                document.getElementById('searchPath').value = 'C:/';
            } else if(data.shell === 'unix') {
                // Remove readonly attribute from the search input for UNIX
                document.getElementById('shellType').innerHTML = '<span style="background-color: lightgray;">' + getDisplayValue(data.shell) + '</span>';
                document.getElementById('searchPath').removeAttribute('readonly');
                // Give default path for UNIX
                document.getElementById('searchPath').value = '~/';
            } else {
                // Add readonly attribute to the search input for unknown shell types
                document.getElementById('shellType').innerHTML = '<span style="background-color: indianred;">' + getDisplayValue(data.shell) + '</span>';
            }
        }
    ).catch(
        error => {
            console.error('Error fetching shell:', error);
            document.getElementById('shellType').innerHTML = '<span style="background-color: indianred;">N/A</span>';
        }
    );
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
let username = null;
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
    } else if (data.length === 1) {
        console.log('Only one username found:', data[0].username);
        // Single username found, setup WebSocket connection
        setupWebSocketConnection(serverID, data[0].username);
        // Set the username for the global scope
        window.username = data[0].username;
        // Fetch and display the shell type
        shellType();
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
            let username = result.value;
            if (username) {
                // Setup WebSocket connection with selected username
                setupWebSocketConnection(serverID, username);
                // Set the username for the global scope
                window.username = username;
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

function displayDropdown(files) {
    const dropdownMenu = document.getElementById('dropdownMenu');
    const searchPathInput = document.getElementById('searchPath');
    dropdownMenu.innerHTML = ''; // Clear previous results
    dropdownMenu.style.display = files.length > 0 ? 'block' : 'none';

    files.forEach(file => {
        const fileItem = document.createElement('div');
        fileItem.className = 'dropdown-item d-flex justify-content-between align-items-center';
        dropdownMenu.appendChild(fileItem);

        const fileInfo = document.createElement('a');
        const isDirectory = file.type === 'directory';
        fileInfo.href = '#';
        fileInfo.innerHTML = `
            <span class="${isDirectory ? 'fas fa-folder folder-icon' : 'fas fa-file file-icon'}"></span>
            ${file.name} <span class="badge badge-secondary">${file.size}</span>
        `;
        fileInfo.addEventListener('click', function(event) {
            event.preventDefault();
            dropdownMenu.style.display = 'none'; // Hide the dropdown menu

            if (isDirectory) {
                const newPath = appendToPath(searchPathInput.value, file.name);
                searchPathInput.value = newPath; // Update the search bar with the new path
                triggerSearch(newPath);
            } else {
                console.log(`Selected file: ${file.name}`);
                // Handle file selection for non-directory items here
            }
        });

        fileItem.appendChild(fileInfo);

        // Add upload button only for directories
        if (isDirectory) {
            const uploadBtn = document.createElement('button');
            uploadBtn.className = 'btn btn-sm btn-outline-secondary ms-2';
            uploadBtn.textContent = 'Upload';
            uploadBtn.addEventListener('click', function(event) {
                event.stopPropagation(); // Prevent the file info click event
                const destination = appendToPath(searchPathInput.value, file.name);
                console.log(`Uploading file to ${destination}`);

                // Open file input dialog
                let input = document.createElement('input');
                input.type = 'file';
                input.onchange = e => { 
                    let file = e.target.files[0]; // get the file
                    let formData = new FormData();
                    formData.append('file', file, file.name);
                    const destination_path = appendToPath(destination, file.name);
                    // Implement the upload functionality
                    fetch(`/api/sftp/upload/${serverID}/${window.username}?destination_path=${encodeURIComponent(destination_path)}`, {
                        method: 'POST',
                        headers: {
                            "Authorization": `Bearer ${localStorage.getItem('accessToken')}`
                        },
                        body: formData, // Send the form data
                    }).then(response => {
                        if (!response.ok) {
                            console.error('Upload failed:', response);
                            return;
                        }
                        console.log('Upload successful:', response);
                        // Optionally refresh or update the UI here
                    }).catch(error => console.error('Error uploading file:', error));
                }
                input.click(); // open dialog
            });
            fileItem.appendChild(uploadBtn);
        }

        // Add download button for both files and directories
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'btn btn-sm btn-outline-primary ms-2';
        downloadBtn.textContent = 'Download';
        downloadBtn.addEventListener('click', function(event) {
            event.stopPropagation(); // Prevent the file info click event
            const path = appendToPath(searchPathInput.value, file.name);
            const downloadPathURL = `/api/sftp/download/${serverID}/${window.username}?path=${encodeURIComponent(path)}`;
            console.log(`Downloading: ${downloadPathURL}`);
            // Implement the download functionality
            fetch(downloadPathURL, {
                headers: {
                    "Authorization": `Bearer ${localStorage.getItem('accessToken')}`
                }
            }).then(response => {
                if (!response.ok) {
                    console.error('Download failed:', response);
                    return;
                } else {
                    response.blob().then(blob => {
                        const url = window.URL.createObjectURL(blob);
                        const a = document.createElement('a');
                        a.href = url;
                        a.download = file.name;
                        document.body.appendChild(a);
                        a.click();
                        a.remove();
                    });
                }
            });
        });
        fileItem.appendChild(downloadBtn);

    });

    adjustDropdownPosition();
}

function appendToPath(currentPath, folderName) {
    return currentPath.endsWith('/') ? `${currentPath}${folderName}` : `${currentPath}/${folderName}`;
}

function triggerSearch(path) {
    const serverId = getPathSegments();
    const url = `/api/sftp/list/${serverId}/${window.username}?path=${encodeURIComponent(path)}`;

    fetch(url, {
        headers: {
            'Authorization': `Bearer ${localStorage.getItem('accessToken')}`
        }
    })
    .then(response => response.json())
    .then(data => {
        if (data.error) {
            // console.error('Error fetching path:', data.error);
            // Don't update the search input to the new path if there's an error
            return;
        }
        displayDropdown(data.files);
    })
    .catch(error => console.error('Error fetching path:', error));
}

function adjustDropdownPosition() {
    const dropdownMenu = document.getElementById('dropdownMenu');
    const searchInput = document.getElementById('searchPath');

    // Get the search input's position on the page
    const inputRect = searchInput.getBoundingClientRect();

    // Position dropdown directly below the search input
    dropdownMenu.style.top = `${inputRect.bottom + window.scrollY}px`; // Add window.scrollY to account for page scroll
    dropdownMenu.style.left = `${inputRect.left}px`;

    // Match dropdown's width with the search input's width
    dropdownMenu.style.width = `${inputRect.width}px`;
}

// Add event listener to the search input to listen for input events and trigger search
document.getElementById('searchPath').addEventListener('input', function(e) {
    const path = e.target.value;
    triggerSearch(path);
});

// Blur the search input when clicking outside of it
document.addEventListener('click', function(e) {
    if (!e.target.matches('#searchPath')) {
        document.getElementById('dropdownMenu').style.display = 'none';
    }
});

// Show the dropdown menu when clicking on the search input
document.getElementById('searchPath').addEventListener('click', function() {
    if (this.value) {
        triggerSearch(this.value);
    }
});

// Adjust dropdown position when the window is resized
window.addEventListener('resize', adjustDropdownPosition);

