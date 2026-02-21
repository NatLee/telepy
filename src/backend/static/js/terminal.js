


// ============================
// WebSocket Connections
// ============================

function sendWebSocketMessage(action, payload) {
    if (window.socket.readyState !== WebSocket.OPEN) {
        console.error('Terminal WebSocket is not open');
        return;
    }
    window.socket.send(JSON.stringify({ action: action, payload: payload }));
}

function sendFileManagerMessage(action, payload) {
    if (!window.fileManagerSocket) {
        console.error('FileManager WebSocket not initialized');
        return;
    }
    
    if (window.fileManagerSocket.readyState !== WebSocket.OPEN) {
        console.warn(`FileManager WebSocket is not open (state: ${window.fileManagerSocket.readyState}). Queuing message...`);
        
        // Queue the message to be sent when connection opens
        if (!window.fileManagerMessageQueue) {
            window.fileManagerMessageQueue = [];
        }
        window.fileManagerMessageQueue.push({ action, payload });
        return;
    }
    
    window.fileManagerSocket.send(JSON.stringify({ action: action, payload: payload }));
}

function setupWebSocketConnection(serverID, username) {
    // Setup Terminal WebSocket
    setupTerminalWebSocket(serverID, username);
    // Setup File Manager WebSocket
    setupFileManagerWebSocket(serverID, username);
}

function setupTerminalWebSocket(serverID, username) {
    Terminal.applyAddon(fit);
    Terminal.applyAddon(fullscreen);

    const term = new Terminal({
        cursorBlink: true,
        fontSize: 14,
        fontFamily: 'Menlo, Monaco, "Courier New", monospace',
    });

    // Expose the terminal object to the window
    window.term = term;

    const ws_scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const accessToken = localStorage.getItem('accessToken');
    const ws_path = `${ws_scheme}://${window.location.host}/ws/terminal/`;
    
    // Token need to be encoded with base64
    const tokenInfo = `token.${btoa(accessToken)}`;
    const serverInfo = `server.${serverID}`;
    const usernameInfo = `username.${username}`;
    // Create a ticket as auth for subprotocols (avoid special characters like % or =)
    let ticket = sha256(`${serverID}.${username}`);
    ticket = `auth.${ticket}`;
    const socket = new WebSocket(ws_path, [tokenInfo, serverInfo, usernameInfo, ticket]);

    // Expose the socket object to the window
    window.socket = socket;

    term.open(document.getElementById('terminal'));
    term.fit();

    term.on('key', (key, ev) => {
        const isMac = navigator.platform.toUpperCase().indexOf('MAC') >= 0;
        const ctrlKey = isMac ? ev.metaKey : ev.ctrlKey;

        if (ctrlKey && key === 'c' && term.hasSelection()) {
            navigator.clipboard.writeText(term.getSelection());
        } else {
            sendWebSocketMessage("pty_input", { input: key });
        }
    });

    term.on('paste', (data) => {
        sendWebSocketMessage("pty_input", { input: data });
    });

    socket.onmessage = function(event) {
        term.write(event.data);
        // Scroll to the bottom of the terminal
        term.scrollToBottom();
    };

    socket.onopen = function() {
        console.log("Terminal WebSocket connection established");
        updateStatus('connected');
        term.focus();
    };

    socket.onclose = function(event) {
        console.log('Terminal WebSocket connection closed');
        updateStatus('disconnected');
        term.setOption('theme', {
            background: '#1e1e1e',
            foreground: '#707070',
        });
        disableSearch();
    };

    socket.onerror = function(event) {
        console.error(`Terminal WebSocket error observed: `, event);

        if (event instanceof ErrorEvent) {
            errorMessage = event.message;
        } else if (event && event.type === 'error' && typeof event.reason === 'string') {
            errorMessage = event.reason;
        }
    
        Swal.fire({
            icon: 'error',
            title: 'Terminal WebSocket Error',
            text: 'A WebSocket error has occurred. Check your permissions and network connection.',
        });
    };
}

function setupFileManagerWebSocket(serverID, username) {
    const ws_scheme = window.location.protocol === "https:" ? "wss" : "ws";
    const accessToken = localStorage.getItem('accessToken');
    const ws_path = `${ws_scheme}://${window.location.host}/ws/filemanager/`;
    
    // Token need to be encoded with base64
    const tokenInfo = `token.${btoa(accessToken)}`;
    const serverInfo = `server.${serverID}`;
    const usernameInfo = `username.${username}`;
    // Create a ticket as auth for subprotocols (avoid special characters like % or =)
    let ticket = sha256(`${serverID}.${username}`);
    ticket = `auth.${ticket}`;
    const fileManagerSocket = new WebSocket(ws_path, [tokenInfo, serverInfo, usernameInfo, ticket]);

    // Expose the file manager socket object to the window
    window.fileManagerSocket = fileManagerSocket;

    fileManagerSocket.onopen = function() {
        console.log("FileManager WebSocket connection established");
        
        // Process any queued messages
        if (window.fileManagerMessageQueue && window.fileManagerMessageQueue.length > 0) {
            console.log(`Sending ${window.fileManagerMessageQueue.length} queued messages`);
            window.fileManagerMessageQueue.forEach(({ action, payload }) => {
                fileManagerSocket.send(JSON.stringify({ action, payload }));
            });
            window.fileManagerMessageQueue = [];
        }
        
        // Enable file operations
        enableFileOperations();
    };

    fileManagerSocket.onmessage = function(event) {
        try {
            const data = JSON.parse(event.data);
            handleFileManagerMessage(data);
        } catch (error) {
            console.error('Error parsing FileManager message:', error);
        }
    };

    fileManagerSocket.onclose = function(event) {
        console.log('FileManager WebSocket connection closed');
        // Disable file operations
        disableFileOperations();
    };

    fileManagerSocket.onerror = function(event) {
        console.error(`FileManager WebSocket error observed: `, event);
        
        Swal.fire({
            icon: 'error',
            title: 'File Manager WebSocket Error',
            text: 'File management WebSocket connection failed. File browsing may not work properly.',
        });
    };
}

function updateStatus(status) {
    const statusElement = document.getElementById('status');
    statusElement.textContent = status;
    statusElement.className = 'badge ' + (status === 'connected' ? 'bg-success' : 'bg-danger');
}


// ============================
// Terminal Actions
// ============================

const resizeTerminal = debounce((cols, rows) => {
    const termElement = document.querySelector('.terminal');
    if (!termElement) return;

    const height = termElement.offsetHeight;
    const width = termElement.offsetWidth;

    sendWebSocketMessage("pty_resize", { 
        size: {
            rows: rows,
            cols: cols,
            height: height,
            width: width
        }
    });

}, 250); // 250ms 的延遲


function adjustTerminalHeight(viewportHeight) {
    const terminalWrapper = document.querySelector('.terminal-wrapper');
    const navbarHeight = document.querySelector('nav').offsetHeight;
    const searchBarHeight = document.querySelector('.input-group').offsetHeight;
    
    // 計算 terminal 可用的高度
    let availableHeight = viewportHeight - navbarHeight - searchBarHeight - 40; // 40px for margin
    
    // 設定 terminal wrapper 的高度
    terminalWrapper.style.height = `${availableHeight}px`;
    
    // 調整 terminal 大小
    if (window.term) {
        window.term.fit();
        const dimensions = window.term.proposeGeometry();
        if (dimensions) {
            resizeTerminal(dimensions.cols, dimensions.rows);
        }
    }
}

function handleTerminalResize() {
    const currentWindowHeight = window.innerHeight;
    adjustTerminalHeight(currentWindowHeight);
}


// ============================
// Shell Type
// ============================

function shellType() {
    console.log('Detecting shell type via WebSocket');
    
    // Use WebSocket to detect shell
    sendFileManagerMessage('shell_detect', {});
}

function updateShellType(type) {
    const shellElement = document.getElementById('shellType');
    shellElement.textContent = type;
    shellElement.className = 'badge ' + (type === 'powershell' ? 'bg-primary' : (type === 'unix' ? 'bg-info' : 'bg-warning'));
}

// ============================
// File Manager WebSocket Functions
// ============================

function handleFileManagerMessage(data) {
    const action = data.action;
    const responseData = data.data;

    switch (action) {
        case 'list_files':
            handleListFilesResponse(responseData);
            break;
        case 'shell_detect':
            handleShellDetectResponse(responseData);
            break;
        case 'upload_file':
            handleUploadFileResponse(responseData);
            break;
        case 'download_file':
            handleDownloadFileResponse(responseData);
            break;
        case 'error':
            handleFileManagerError(responseData);
            break;
        default:
            console.log('Unknown FileManager action:', action, responseData);
    }
}

function handleListFilesResponse(data) {
    if (data.status === 'success') {
        displayDropdown(data.files);
        updateSearchStatus('success');
    } else {
        updateSearchStatus('error', data.message || 'Failed to list files');
    }
}

function handleShellDetectResponse(data) {
    if (data.status === 'success') {
        console.log('Shell detected:', data.shell);
        updateShellType(data.shell);
        
        // Set initial path based on shell type
        const searchPathInput = document.getElementById('searchPath');
        if (data.shell === 'powershell') {
            searchPathInput.removeAttribute('readonly');
            searchPathInput.value = 'C:/';
        } else if (data.shell === 'unix') {
            searchPathInput.removeAttribute('readonly');
            searchPathInput.value = '~/';
        } else {
            searchPathInput.setAttribute('readonly', 'readonly');
        }
    } else {
        console.error('Failed to detect shell:', data.message);
        updateShellType('unknown');
    }
}

function handleUploadFileResponse(data) {
    if (data.status === 'success') {
        console.log('Upload URL received:', data.upload_url);
        
        // Check if we have a pending upload
        if (window.pendingUpload) {
            performFileUpload(data.upload_url, window.pendingUpload.file, window.pendingUpload.destinationPath);
            // Clear pending upload
            window.pendingUpload = null;
        }
    } else {
        console.error('Upload preparation failed:', data.message);
        // Clear pending upload on error
        window.pendingUpload = null;
    }
}

function performFileUpload(uploadUrl, file, destinationPath) {
    console.log(`Uploading file: ${file.name} to ${destinationPath}`);
    
    const formData = new FormData();
    formData.append('file', file, file.name);
    
    fetch(uploadUrl, {
        method: 'POST',
        headers: {
            "Authorization": `Bearer ${localStorage.getItem('accessToken')}`
        },
        body: formData,
    }).then(response => {
        if (!response.ok) {
            console.error('Upload failed:', response);
            Swal.fire({
                icon: 'error',
                title: 'Upload Failed',
                text: 'Failed to upload the file. Please try again.',
            });
            return;
        }
        console.log('Upload successful');
        Swal.fire({
            icon: 'success',
            title: 'Upload Successful',
            text: `File "${file.name}" uploaded successfully!`,
            timer: 2000,
            showConfirmButton: false
        });
        
        // Refresh the current directory to show the new file
        const currentPath = document.getElementById('searchPath').value;
        if (currentPath) {
            triggerSearch(currentPath);
        }
    }).catch(error => {
        console.error('Error uploading file:', error);
        Swal.fire({
            icon: 'error',
            title: 'Upload Error',
            text: 'An error occurred while uploading the file.',
        });
    });
}

function handleDownloadFileResponse(data) {
    if (data.status === 'success') {
        console.log('Download URL received:', data.download_url);
        
        // Create a temporary link and trigger download
        const downloadLink = document.createElement('a');
        downloadLink.href = data.download_url;
        downloadLink.style.display = 'none';
        document.body.appendChild(downloadLink);
        downloadLink.click();
        document.body.removeChild(downloadLink);
        
        console.log('Download initiated successfully');
    } else {
        console.error('Download preparation failed:', data.message);
        Swal.fire({
            icon: 'error',
            title: 'Download Failed',
            text: data.message || 'Failed to prepare download.',
        });
    }
}

function handleFileManagerError(data) {
    console.error('FileManager error:', data.message);
    updateSearchStatus('error', data.message);
}

function enableFileOperations() {
    console.log('File operations enabled via WebSocket');
    // Enable search input if shell detection is successful
    // This will be handled by shell_detect response
    
    // Now that FileManager WebSocket is connected, trigger shell detection
    shellType();
}

function disableFileOperations() {
    console.log('File operations disabled - WebSocket disconnected');
    disableSearch();
}

// ============================
// SFTP File Management (Updated to use WebSocket)
// ============================

function displayDropdown(files) {
    const dropdownMenu = document.getElementById('dropdownMenu');
    const searchPathInput = document.getElementById('searchPath');
    dropdownMenu.innerHTML = ''; // Clear previous results
    dropdownMenu.style.display = files.length > 0 ? 'block' : 'none';

    files.forEach(file => {
        const fileItem = document.createElement('div');
        fileItem.className = 'dropdown-item d-flex justify-content-between align-items-center';
        dropdownMenu.appendChild(fileItem);

        const fileInfo = createFileInfo(file, searchPathInput);
        fileItem.appendChild(fileInfo);

        const buttonContainer = document.createElement('div');
        buttonContainer.className = 'd-flex';
        fileItem.appendChild(buttonContainer);

        if (file.type === 'directory') {
            const uploadBtn = createButton('Upload', 'btn-outline-secondary', () => handleUpload(file, searchPathInput.value));
            buttonContainer.appendChild(uploadBtn);
        }

        const downloadBtn = createButton('Download', 'btn-outline-primary', () => handleDownload(file, searchPathInput.value));
        buttonContainer.appendChild(downloadBtn);
    });
}

function createFileInfo(file, searchPathInput) {
    const fileInfo = document.createElement('a');
    const isDirectory = file.type === 'directory';
    fileInfo.href = '#';
    fileInfo.className = 'd-flex align-items-center';
    fileInfo.innerHTML = `
        <span class="${isDirectory ? 'fas fa-folder folder-icon' : 'fas fa-file file-icon'} me-2"></span>
        <span>${file.name}</span>
        <span class="badge bg-secondary ms-2">${file.size}</span>
    `;
    fileInfo.addEventListener('click', (event) => {
        event.preventDefault();
        document.getElementById('dropdownMenu').style.display = 'none';
        if (isDirectory) {
            const newPath = appendToPath(searchPathInput.value, file.name);
            searchPathInput.value = newPath;
            triggerSearch(newPath);
        } else {
            console.log(`Selected file: ${file.name}`);
        }
    });
    return fileInfo;
}

function createButton(text, className, onClick) {
    const button = document.createElement('button');
    button.className = `btn btn-sm ${className} ms-2`;
    button.textContent = text;
    button.addEventListener('click', (event) => {
        event.stopPropagation();
        onClick();
    });
    return button;
}

function handleUpload(file, currentPath) {
    const destination = appendToPath(currentPath, file.name);
    console.log(`Preparing upload to ${destination}`);

    const input = document.createElement('input');
    input.type = 'file';
    input.onchange = (e) => {
        const selectedFile = e.target.files[0];
        if (!selectedFile) return;
        
        const destinationPath = appendToPath(destination, selectedFile.name);
        
        // Get upload URL via WebSocket first
        sendFileManagerMessage('upload_file', { destination_path: destinationPath });
        
        // Store the file for upload after we get the URL
        window.pendingUpload = {
            file: selectedFile,
            destinationPath: destinationPath
        };
    }
    input.click();
}

function handleDownload(file, currentPath) {
    const path = appendToPath(currentPath, file.name);
    console.log(`Requesting download for: ${path}`);

    // Use WebSocket to get download URL
    sendFileManagerMessage('download_file', { path: path });
}

// ============================
// Search and Status
// ============================

function appendToPath(currentPath, folderName) {
    return currentPath.endsWith('/') ? `${currentPath}${folderName}` : `${currentPath}/${folderName}`;
}

function initializeSearchStatus() {
    const searchStatusBtn = document.getElementById('searchStatusBtn');
    searchStatusBtn.setAttribute('data-bs-toggle', 'tooltip');
    searchStatusBtn.setAttribute('data-bs-placement', 'top');
    updateSearchStatus('neutral');
}

function updateSearchStatus(status, errorMessage = '') {
    const searchStatusBtn = document.getElementById('searchStatusBtn');
    const icon = searchStatusBtn.querySelector('i');

    switch (status) {
        case 'success':
            icon.className = 'fas fa-circle text-success';
            searchStatusBtn.setAttribute('data-bs-original-title', 'Search successful');
            break;
        case 'error':
            icon.className = 'fas fa-circle text-danger';
            searchStatusBtn.setAttribute('data-bs-original-title', `Error: ${errorMessage}`);
            break;
        case 'neutral':
        default:
            icon.className = 'fas fa-circle text-secondary';
            searchStatusBtn.setAttribute('data-bs-original-title', 'No search performed yet');
            break;
    }

    // 使用防抖函數來更新 tooltip
    debouncedUpdateTooltip();
}

function triggerSearch(path) {
    console.log(`Searching path via WebSocket: ${path}`);
    updateSearchStatus('neutral');

    // Use WebSocket to list files
    sendFileManagerMessage('list_files', { path: path });
}

function disableSearch() {
    // CLose dropdown menu
    document.getElementById('dropdownMenu').style.display = 'none';
    // Make searchPath more darker
    document.getElementById('searchPath').style.backgroundColor = '#333';
    // Disable search input
    document.getElementById('searchPath').setAttribute('readonly', 'readonly');
    // Remove all of `searchPath` event listener
    let searchPath = document.getElementById('searchPath');
    let searchPathClone = searchPath.cloneNode(true);
    searchPath.parentNode.replaceChild(searchPathClone, searchPath);
    // Disable refresh button
    document.getElementById('refreshBtn').setAttribute('disabled', 'disabled');
    document.getElementById('searchStatusBtn').setAttribute('disabled', 'disabled');
    updateSearchStatus('neutral');
}

// ============================
// Service Key Check
// ============================

function setupServiceKeyCheck() {
    const checkServiceKeyBtn = document.getElementById('checkServiceKeyBtn');
    if (!checkServiceKeyBtn) return;

    checkServiceKeyBtn.addEventListener('click', handleServiceKeyCheck);
}

async function handleServiceKeyCheck() {
    try {
        const keyInfo = await fetchServiceKey();
        if (keyInfo) {
            showServiceKeyModal(keyInfo);
        } else {
            showNoKeyFoundMessage();
        }
    } catch (error) {
        handleServiceKeyError(error);
    }
}

async function fetchServiceKey() {
    const accessToken = localStorage.getItem('accessToken');
    const response = await fetch('/api/reverse/service/keys', {
        headers: {
            'Authorization': `Bearer ${accessToken}`,
            'Content-Type': 'application/json',
        },
    });
    const data = await response.json();
    return data && data.length > 0 ? data[0] : null;
}

function showServiceKeyModal(keyInfo) {
    const modalElement = document.getElementById('serviceKeyModal');
    const modal = new bootstrap.Modal(modalElement);
    
    const serviceElement = modalElement.querySelector('#serviceKeyService');
    const textareaElement = modalElement.querySelector('#serviceKeyTextarea');
    const copyButton = modalElement.querySelector('#copyServiceKey');
    const reloadButton = modalElement.querySelector('#reloadButton');

    serviceElement.textContent = keyInfo.service;
    textareaElement.value = keyInfo.key;

    copyButton.addEventListener('click', copyServiceKey);
    reloadButton.addEventListener('click', () => location.reload());

    modal.show();
}

function copyServiceKey() {
    const copyText = document.getElementById("serviceKeyTextarea");
    copyText.select();
    document.execCommand("copy");
    showToast('Copied!', 'The key has been copied to clipboard.');
}

function showNoKeyFoundMessage() {
    showToast('No Service Key Found', 'Please ensure you have a service key available.', 'info');
}

function handleServiceKeyError(error) {
    console.error('Error fetching service keys:', error);
    showToast('Error', 'Failed to fetch service keys.', 'error');
}

function showToast(title, message, type = 'success') {
    // 這裡可以實現一個簡單的 toast 通知
    console.log(`${type.toUpperCase()}: ${title} - ${message}`);
    // 如果需要，可以使用 Bootstrap 的 Toast 組件或其他輕量級的通知庫
}

// ============================
// Username and Connection
// ============================

function initializeUsernameAndConnection() {
    return new Promise((resolve, reject) => {
        const accessToken = localStorage.getItem('accessToken');
        const serverID = getPathSegments();
        console.log(`Server ID:` + serverID);

        // First fetch tunnel data to check permissions
        fetch('/api/reverse/server/keys', {
            method: "GET",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        })
        .then(response => response.json())
        .then(tunnelData => {
            // Store tunnel data globally for permission checks
            window.tunnelData = tunnelData;

            // Now fetch usernames
            return fetch(`/api/reverse/server/${serverID}/usernames`, {
                headers: {
                    'Authorization': `Bearer ${accessToken}`
                }
            });
        })
        .then(response => response.json())
        .then(data => {
            if (data.length === 0) {
                Swal.fire({
                    title: 'No Usernames Available',
                    text: 'No usernames have been configured for this server. Please contact the tunnel owner to add usernames, or ask them to grant you edit permissions.',
                    icon: 'warning',
                    confirmButtonText: 'OK'
                }).then(() => {
                    // Redirect back to tunnels page
                    window.location.href = '/tunnels/index';
                });
                reject('No usernames available for this server');
                return;
            }

            if (data.length === 1) {
                console.log('Only one username found:', data[0].username);
                resolve({ serverID, username: data[0].username });
                return;
            }

            // Check if user has edit permission for this tunnel
            const tunnelData = window.tunnelData || [];
            const tunnelItem = tunnelData.find(item => item.id == serverID);
            const canEdit = tunnelItem ? tunnelItem.can_edit : false;

            if (canEdit) {
                // User has edit permission, show delete option
                Swal.fire({
                    title: 'Select or Delete a Username',
                    text: 'Select a username or delete one.',
                    input: 'select',
                    inputOptions: data.reduce((acc, curr) => ({...acc, [curr.username]: curr.username}), {}),
                    inputPlaceholder: 'Select a username',
                    confirmButtonText: 'Select',
                    showDenyButton: true,
                    denyButtonText: 'Delete',
                    allowOutsideClick: false,
                    backdrop: `
                        rgba(20, 20, 20, 0.9)
                        url("/api/__hidden_statics/images/nyan-cat.gif")
                        left top
                        no-repeat
                    `,
                    preConfirm: (username) => {
                        return username;
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
                                    return 'You need to enter a username!';
                                }
                            },
                            willClose: () => {
                                location.reload();
                            }
                        }).then((deleteResult) => {
                            if (deleteResult.value) {
                                const usernameID = data.find((item) => item.username === deleteResult.value).id;
                                return fetch(`/api/reverse/server/usernames/${usernameID}`, {
                                    method: 'DELETE',
                                    headers: {
                                        'Authorization': `Bearer ${accessToken}`,
                                        'Content-Type': 'application/json',
                                    },
                                    body: JSON.stringify({ username: deleteResult.value })
                                }).then(deleteResponse => {
                                    if (deleteResponse.ok) {
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
                        resolve({ serverID, username });
                    } else if (result.dismiss === Swal.DismissReason.deny) {
                        location.reload();
                    } else {
                        location.reload();
                    }
                });
            } else {
                // User doesn't have edit permission, only show selection
                Swal.fire({
                    title: 'Select a Username',
                    text: 'Select a username to connect with.',
                    input: 'select',
                    inputOptions: data.reduce((acc, curr) => ({...acc, [curr.username]: curr.username}), {}),
                    inputPlaceholder: 'Select a username',
                    confirmButtonText: 'Connect',
                    allowOutsideClick: false,
                    backdrop: `
                        rgba(20, 20, 20, 0.9)
                        url("/api/__hidden_statics/images/nyan-cat.gif")
                        left top
                        no-repeat
                    `,
                    preConfirm: (username) => {
                        return username;
                    }
                }).then((result) => {
                    let username = result.value;
                    if (username) {
                        resolve({ serverID, username });
                    } else {
                        location.reload();
                    }
                });
            }
        })
        .catch(error => {
            Swal.fire({
                title: 'Error!',
                text: 'An error occurred while fetching data',
                icon: 'error',
                confirmButtonText: 'OK'
            });
            window.location.href = '/tunnels/index';
            reject(error);
        });
    });
}

// ============================
// Utility Functions
// ============================

function getDisplayValue(value, defaultValue = 'N/A') {
    return value ? value : defaultValue;
}

function getPathSegments() {
    const segments = window.location.pathname.split('/').filter(Boolean);
    if (segments.length < 2) {
        console.error('Unexpected pathname format:', window.location.pathname);
        return null;
    }
    return segments[2];
}

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


// ============================
// Main
// ============================

let searchStatusTooltip;
let updateTooltipTimeout;

// 使用防抖函數來更新 tooltip
const debouncedUpdateTooltip = debounce(() => {
    const searchStatusBtn = document.getElementById('searchStatusBtn');
    if (searchStatusTooltip) {
        searchStatusTooltip.dispose();
    }
    searchStatusTooltip = new bootstrap.Tooltip(searchStatusBtn);
}, 100); // 100ms 防抖


// 添加事件監聽器來處理 tooltip 的顯示
document.getElementById('searchStatusBtn').addEventListener('show.bs.tooltip', () => {
    if (updateTooltipTimeout) {
        clearTimeout(updateTooltipTimeout);
    }
});

// 添加事件監聽器來處理 tooltip 的隱藏
document.getElementById('searchStatusBtn').addEventListener('hidden.bs.tooltip', () => {
    if (searchStatusTooltip) {
        searchStatusTooltip.dispose();
        searchStatusTooltip = null;
    }
});

// 使用防抖函數來觸發搜索 (Updated to use WebSocket)
const debouncedTriggerSearch = debounce((path) => {
    console.log(`Debounced search path via WebSocket: ${path}`);
    updateSearchStatus('neutral');

    // Use WebSocket to list files
    sendFileManagerMessage('list_files', { path: path });
}, 700); // 700ms 防抖


// Add event listener to the search input to listen for input events and trigger search
document.getElementById('searchPath').addEventListener('input', function(e) {
    const path = e.target.value;
    debouncedTriggerSearch(path);
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

// Add event listener to the refresh button to trigger search
document.getElementById('refreshBtn').addEventListener('click', function() {
    const currentPath = document.getElementById('searchPath').value;
    if (currentPath) {
        triggerSearch(currentPath);
    }
});

// 監聽視窗大小變化
window.addEventListener('resize', debounce(handleTerminalResize, 250));

document.addEventListener('DOMContentLoaded', function() {
    setupServiceKeyCheck();
    initializeUsernameAndConnection()
        .then(({ serverID, username }) => {
            setupWebSocketConnection(serverID, username);
            window.username = username;
            window.serverID = serverID;

            handleTerminalResize();
            initializeSearchStatus();
            // shellType() will be called automatically when FileManager WebSocket connects

        })
        .catch(error => {
            console.error('Failed to initialize:', error);
        });
});
