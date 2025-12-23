
function notificationWebsocket() {

    var ws_scheme = window.location.protocol == "https:" ? "wss" : "ws";
    var ws_path = ws_scheme + '://' + window.location.host + "/ws/notifications/";
    console.log('Notification WebSocket path:', ws_path);

    // Get JWT token
    const accessToken = localStorage.getItem('accessToken');

    // Token need to be encoded with base64
    const tokenInfo = `token.${btoa(accessToken)}`;

    // Create a ticket as auth for subprotocols (avoid special characters like % or =)
    // For notification, we use a simple identifier since there's no server/username context
    let ticket = sha256(`notification.${Date.now()}`);
    ticket = `auth.${ticket}`;
    console.log('Ticket for notification:', ticket);

    const subprotocols = [tokenInfo, ticket];

    const notificationSocket = new WebSocket(ws_path, subprotocols);

    // Expose the socket object to the window
    window.notificationSocket = notificationSocket;

    // Update the status of the WebSocket connection
    function updateWebSocketStatus(isConnected) {
        const statusElement = document.getElementById("websocket-status");
        if (statusElement) {
            statusElement.classList.toggle('connected', isConnected);
            statusElement.classList.toggle('disconnected', !isConnected);
        }
    }

    notificationSocket.onopen = function () {
        console.log('Notification WebSocket connected successfully');
        updateWebSocketStatus(true);
    };

    notificationSocket.onclose = function (e) {
        console.log('Notification WebSocket closed:', e.code, e.reason);
        updateWebSocketStatus(false);
        console.error('Notification WebSocket closed unexpectedly:', e);

        // Reconnect after 3 seconds
        setTimeout(notificationWebsocket, 3000);
    };

    // Handle any errors that occur.
    notificationSocket.onerror = function (error) {
        console.error('Notification WebSocket Error:', error);
        updateWebSocketStatus(false);
    };

    notificationSocket.onmessage = function(event) {
        console.log('Raw notification message received:', event.data);
    };

    return notificationSocket;

}

