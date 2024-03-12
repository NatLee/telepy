
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

    return socket;

}
