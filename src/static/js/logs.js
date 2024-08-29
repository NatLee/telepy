let fetchedLogEntries = [];


function refreshLogs() {
    const accessToken = localStorage.getItem('accessToken');
    fetch('/api/log/ssh', {
        method: 'GET',
        headers: {
            'Authorization': `Bearer ${accessToken}`
        }
    })
    .then(response => response.text())
    .then(data => {
        fetchedLogEntries = parseLogData(data);
        displayLogs(fetchedLogEntries);
    })
    .catch(error => {
        console.error('Error fetching logs:', error);
    });
}

function parseLogData(data) {
    // 移除開頭和結尾的引號，然後按換行符分割
    const lines = data.replace(/^"|"$/g, '').split('\\n');
    return lines.filter(line => line.trim() !== '').map(line => {
        const [timestamp, ...messageParts] = line.split(' ');
        return {
            timestamp: timestamp,
            message: messageParts.join(' ')
        };
    });
}

function displayLogs(logs) {
    const logContentElement = document.getElementById('logContent');
    logContentElement.innerHTML = '';

    logs.forEach(log => {
        const row = document.createElement('tr');
        row.innerHTML = `
            <td>${log.timestamp}</td>
            <td>${highlightKeywords(log.message)}</td>
        `;
        logContentElement.appendChild(row);
    });

    const tableBodyContainer = document.querySelector('.table-body-container');
    tableBodyContainer.scrollTop = tableBodyContainer.scrollHeight;
}


function highlightKeywords(message) {
    const keywords = {
        "Server listening": '<span class="badge bg-success">Server listening</span>',
        "Connection closed": '<span class="badge bg-warning">Connection closed</span>',
        "Received signal": '<span class="badge bg-danger">Received signal</span>',
        "KEX Identification": '<span class="badge bg-info">KEX Identification</span>',
        "Accepted publickey": '<span class="badge bg-primary">Accepted publickey</span>',
        "connect_to": '<span class="badge bg-secondary">connect_to</span>'
    };

    Object.keys(keywords).forEach(key => {
        const regex = new RegExp(key, "gi");
        message = message.replace(regex, keywords[key]);
    });

    return message;
}


function filterLogs() {
    const searchTerm = document.getElementById('searchInput').value.toLowerCase();
    const filteredLogs = fetchedLogEntries.filter(log => 
        log.timestamp.toLowerCase().includes(searchTerm) || 
        log.message.toLowerCase().includes(searchTerm)
    );
    displayLogs(filteredLogs);
}

function adjustTableHeight() {
    const windowHeight = window.innerHeight;
    const tableContainer = document.querySelector('.table-container');
    const tableTop = tableContainer.getBoundingClientRect().top;
    const desiredHeight = windowHeight - tableTop - 20; // 20px 為底部間距
    tableContainer.style.height = `${desiredHeight}px`;
}

window.addEventListener('load', adjustTableHeight);
window.addEventListener('resize', adjustTableHeight);

document.addEventListener('DOMContentLoaded', function() {
    refreshLogs();
});
