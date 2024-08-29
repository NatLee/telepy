
function fetchSettings() {
    const accessToken = localStorage.getItem('accessToken');

    fetch('/api/site/settings', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => response.json())
    .then(data => {
        populateSettingsTable(data);
    })
    .catch(error => console.error('Error fetching settings:', error));
}

function populateSettingsTable(settings) {
    const tableBody = document.getElementById('settingsTableBody');
    tableBody.innerHTML = ''; // Clear existing table content

    Object.keys(settings).forEach(key => {
        if (typeof settings[key] === 'boolean') { // Assuming setting values are boolean
            const row = tableBody.insertRow();
            const nameCell = row.insertCell(0);
            const toggleCell = row.insertCell(1);
            nameCell.textContent = key;

            // Create the label that will act as the toggle switch
            const switchLabel = document.createElement('label');
            switchLabel.classList.add('switch');

            const toggle = document.createElement('input');
            toggle.setAttribute('type', 'checkbox');
            toggle.checked = settings[key];
            toggle.addEventListener('change', () => updateSetting(key, toggle.checked));

            const sliderSpan = document.createElement('span');
            sliderSpan.classList.add('slider', 'round');

            switchLabel.appendChild(toggle);
            switchLabel.appendChild(sliderSpan);

            toggleCell.appendChild(switchLabel);
        }
    });
}

function updateSetting(name, value) {

    const accessToken = localStorage.getItem('accessToken');
    const payload = {};
    payload[name] = value;

    fetch('/api/site/settings', {
        method: 'POST',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
        body: JSON.stringify(payload),
    })
    .then(response => {
        if (!response.ok) {
            throw new Error(`HTTP error! ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        console.log('Setting updated:', data);
        // Optionally, refresh the settings or provide user feedback
    })
    .catch(error => console.error('Error updating setting:', error));
}

function settingsNotificationWebsocket() {
    var socket = notificationWebsocket();
    socket.onmessage = function (event) {
        const data = JSON.parse(event.data);
        console.log('Notification message:', data.message);
        createToastAlert(data.message.details, false);
    };
}

document.addEventListener('DOMContentLoaded', function() {
    settingsNotificationWebsocket();
    fetchSettings();
});