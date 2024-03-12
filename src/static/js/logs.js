// Variable to store the fetched log entries
let fetchedLogEntries = [];

function refreshLogs() {
    fetchLogs();
    displayLogs();
}

function fetchLogs() {
    const accessToken = localStorage.getItem('accessToken');
    fetch('/api/log/ssh', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    })
    .then(response => response.json())
    .then(data => {
        fetchedLogEntries = data.split('\n');
        displayLogs(); // Initially display all logs
    })
    .catch(error => {
        console.error('Error fetching logs:', error);
    });
}

function displayLogs(filterKeyword = '') {
    const logContentElement = document.getElementById('logContent');
    logContentElement.innerHTML = ''; // Clear existing logs

    fetchedLogEntries.forEach(entry => {
        const timestamp = entry.split(' ', 2).join(' ');
        const messageParts = entry.split(' ').slice(2);
        const message = messageParts.join(' ').trim();
        const highlightedMessage = highlightKeywords(message);

        if (!filterKeyword || message.toLowerCase().startsWith(filterKeyword.toLowerCase())) {
            const row = document.createElement('tr');
            row.innerHTML = `<td>${timestamp}</td><td>${highlightedMessage}</td>`;
            logContentElement.appendChild(row);
        }
    });

    const tableContainer = document.querySelector('.table-responsive');
    tableContainer.scrollTop = tableContainer.scrollHeight;
}


function highlightKeywords(message) {
    const keywords = {
        "Accepted": '<span class="badge bg-success">Accepted</span>',
        "Invalid": '<span class="badge bg-danger">Invalid</span>',
        "Disconnected": '<span class="badge bg-warning">Disconnected</span>',
    };

    // Apply keyword highlighting
    Object.keys(keywords).forEach(key => {
        const regex = new RegExp(key, "g");
        message = message.replace(regex, keywords[key]);
    });

    // Highlight usernames
    const usernameDisconnectRegex = /\buser\s(\w+|\w+[\-\_\.]\w+)\b/g;
    message = message.replace(usernameDisconnectRegex, (match, username) => {
        return `user <span class="badge bg-info">${username}</span>`;
    });
    const usernameAcceptRegex = /\bpublickey for\s(\w+|\w+[\-\_\.]\w+)\b/g;
    message = message.replace(usernameAcceptRegex, (match, username) => {
        return `user <span class="badge bg-info">${username}</span>`;
    });

    return message;
}


function logNotificationWebsocket() {
    var socket = notificationWebsocket();
    socket.onmessage = function (event) {
        const data = JSON.parse(event.data);
        console.log('Notification message:', data.message);
        createToastAlert(data.message.details, false);
    };
}


document.addEventListener('DOMContentLoaded', function() {
    logNotificationWebsocket();
    refreshLogs();    
});
