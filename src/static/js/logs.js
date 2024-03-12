function refreshLogs() {
    const accessToken = localStorage.getItem('accessToken');
    fetch(
        '/api/log/ssh',
        {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`
            }
        })
        .then(response => response.json())
        .then(data => {
            const logEntries = data.split('\n');
            const logContentElement = document.getElementById('logContent');
            logContentElement.innerHTML = ''; // Clear existing logs

            logEntries.forEach(entry => {
                const timestamp = entry.split(' ', 2).join(' ');
                const messageParts = entry.split(' ').slice(2);
                const message = messageParts.join(' ');
                const highlightedMessage = highlightKeywords(message);

                const row = document.createElement('tr');
                row.innerHTML = `<td>${timestamp}</td><td>${highlightedMessage}</td>`;
                logContentElement.appendChild(row);
            });

            // Scroll to the latest log entry
            const tableContainer = document.querySelector('.table-responsive');
            tableContainer.scrollTop = tableContainer.scrollHeight;
        })
        .catch(error => {
            console.error('Error fetching logs:', error);
        });
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
