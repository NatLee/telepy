
function fetchAndDisplayReverseServerKeys() {
    // Retrieve the JWT from local storage
    const accessToken = localStorage.getItem('accessToken');

    fetch('/api/reverse/server/keys', {
        method: "GET",
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(data => {
        const table = document.getElementById('tunnelsTableBody');
        table.innerHTML = '';

        data.forEach(item => {
            const actionButtons = `
                <button class="btn btn-warning btn-sm me-3" onclick="window.open('/tunnels/shell/${item.hostname}')">Console</button>
            `;

            const row = `
            <tr>
                <td>${item.hostname}</td>
                <td>${item.reverse_port}</td>
                <td>${item.key.substring(0, 20) || '&lt;none&gt;'}...</td>
                <td>
                    <div class='d-flex'>
                        <div class="${item.hostname}-status status ml-2" id="${item.hostname}-status"></div>
                    </div>
                </td>
                <td>
                    <div class='d-flex' id="actions-${item.id}">
                        ${actionButtons}
                    </div>
                </td>
            </tr>`;
            table.innerHTML += row;
        });

        // Fetch the status after constructing the rows
        fetch('/api/reverse/server/status/ports', {
            method: "GET",
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${accessToken}`
            },
        })
        .then(response => response.json())
        .then(statusData => {
            // Define a function to update the status of the port
            function updateStatus(isConnected, hostname) {
                const statusElement = document.getElementById(`${hostname}-status`);
                if (statusElement) {
                    statusElement.classList.toggle('connected', isConnected);
                    statusElement.classList.toggle('disconnected', !isConnected);
                }
            }
            // Iterate through each item again to update their status
            data.forEach(item => {
                // Determine if the port is active based on the status data
                const isActive = statusData[item.reverse_port];
                // Call the updateStatus function with the isActive status and hostname
                updateStatus(isActive, item.hostname);
            });
        });
    })

    .catch(error => {
        console.error('Error fetching tunnels data or status:', error);
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
        if (action === "UPDATED-TUNNELS") {
            createToastAlert(data.message.details, false);
            fetchAndDisplayReverseServerKeys();
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

document.addEventListener('DOMContentLoaded', fetchAndDisplayReverseServerKeys);
document.addEventListener('DOMContentLoaded', notificationWebsocket);