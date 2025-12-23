
function fetchSettings() {
    const accessToken = localStorage.getItem('accessToken');

    // Check if token exists
    if (!accessToken) {
        console.error('No access token found, redirecting to login');
        window.location.href = '/login';
        return;
    }

    fetch('/api/site/settings', {
        method: 'GET',
        headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${accessToken}`
        },
    })
    .then(response => {
        if (!response.ok) {
            if (response.status === 401 || response.status === 403) {
                console.error('Authentication failed, redirecting to login');
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                window.location.href = '/login';
                return;
            }
            throw new Error(`HTTP error! Status: ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data) {
            populateSettingsTable(data);
        }
    })
    .catch(error => {
        console.error('Error fetching settings:', error);
        // Show error message in the table
        const tableBody = document.getElementById('settingsTableBody');
        tableBody.innerHTML = '';
        const row = tableBody.insertRow();
        const messageCell = row.insertCell(0);
        messageCell.colSpan = 2;
        messageCell.className = 'text-center text-danger p-4';
        messageCell.innerHTML = '<i class="fas fa-exclamation-triangle me-2"></i>Failed to load settings. Please try again later.';
    });
}

function populateSettingsTable(settings) {
    const tableBody = document.getElementById('settingsTableBody');
    const cardsContainer = document.getElementById('settingsCardsContainer');

    // Clear both containers
    tableBody.innerHTML = '';
    if (cardsContainer) {
        cardsContainer.innerHTML = '';
    }

    // Check if we should show cards (mobile) or table (desktop)
    const isMobile = window.innerWidth < 768;

    // Check if there are any settings to display
    if (Object.keys(settings).length === 0) {
        if (isMobile) {
            const card = `
                <div class="setting-card mb-3">
                    <div class="card border-0 shadow-sm">
                        <div class="card-body p-4 text-center">
                            <i class="fas fa-info-circle text-muted fa-2x mb-3"></i>
                            <p class="text-muted mb-0">No settings available for your user level.</p>
                        </div>
                    </div>
                </div>
            `;
            if (cardsContainer) {
                cardsContainer.innerHTML = card;
            }
        } else {
            const row = tableBody.insertRow();
            const messageCell = row.insertCell(0);
            messageCell.colSpan = 2;
            messageCell.className = 'text-center text-muted p-4';
            messageCell.innerHTML = '<i class="fas fa-info-circle me-2"></i>No settings available for your user level.';
        }
        return;
    }

    Object.keys(settings).forEach(key => {
        if (typeof settings[key] === 'boolean') { // Assuming setting values are boolean
            if (isMobile) {
                // Create card for mobile
                const card = `
                    <div class="setting-card mb-3">
                        <div class="card border-0 shadow-sm">
                            <div class="card-body p-3">
                                <div class="d-flex justify-content-between align-items-center">
                                    <div class="flex-grow-1">
                                        <h6 class="card-title mb-1">${formatSettingName(key)}</h6>
                                        <p class="card-text small text-muted mb-0">
                                            Toggle this setting on or off
                                        </p>
                                    </div>
                                    <label class="switch">
                                        <input type="checkbox" ${settings[key] ? 'checked' : ''} onchange="updateSetting('${key}', this.checked)">
                                        <span class="slider round"></span>
                                    </label>
                                </div>
                            </div>
                        </div>
                    </div>
                `;
                if (cardsContainer) {
                    cardsContainer.innerHTML += card;
                }
            } else {
                // Create table row for desktop
                const row = tableBody.insertRow();
                const nameCell = row.insertCell(0);
                const toggleCell = row.insertCell(1);
                nameCell.textContent = formatSettingName(key);

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
        }
    });

    // Show/hide appropriate containers
    const tableContainer = document.querySelector('.table-responsive');
    const cardsContainerWrapper = document.getElementById('settingsCardsWrapper');

    if (isMobile) {
        if (tableContainer) tableContainer.style.display = 'none';
        if (cardsContainerWrapper) cardsContainerWrapper.style.display = 'block';
    } else {
        if (tableContainer) tableContainer.style.display = 'block';
        if (cardsContainerWrapper) cardsContainerWrapper.style.display = 'none';
    }
}

function formatSettingName(key) {
    // Convert snake_case to Title Case
    return key.split('_').map(word => 
        word.charAt(0).toUpperCase() + word.slice(1)
    ).join(' ');
}

function updateSetting(name, value) {
    const accessToken = localStorage.getItem('accessToken');

    // Check if token exists
    if (!accessToken) {
        console.error('No access token found, redirecting to login');
        window.location.href = '/login';
        return;
    }

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
            if (response.status === 401 || response.status === 403) {
                console.error('Authentication failed, redirecting to login');
                localStorage.removeItem('accessToken');
                localStorage.removeItem('refreshToken');
                window.location.href = '/login';
                return;
            }
            throw new Error(`HTTP error! ${response.status}`);
        }
        return response.json();
    })
    .then(data => {
        if (data) {
            console.log('Setting updated:', data);
            // Show success feedback
            if (typeof Swal !== 'undefined') {
                Swal.fire({
                    icon: 'success',
                    title: 'Setting Updated',
                    text: 'Your setting has been saved successfully.',
                    showConfirmButton: false,
                    timer: 1500
                });
            }
        }
    })
    .catch(error => {
        console.error('Error updating setting:', error);
        // Show error feedback and revert the toggle
        if (typeof Swal !== 'undefined') {
            Swal.fire({
                icon: 'error',
                title: 'Update Failed',
                text: 'Failed to update setting. Please try again.',
                showConfirmButton: true,
            });
        }
        // Refresh settings to revert any UI changes
        setTimeout(() => fetchSettings(), 500);
    });
}

function settingsNotificationWebsocket() {
    try {
        var socket = notificationWebsocket();
        socket.onmessage = function (event) {
            const data = JSON.parse(event.data);
            console.log('Notification message:', data.message);
            if (typeof createToastAlert === 'function') {
                createToastAlert(data.message.details, false);
            }
        };
    } catch (error) {
        console.warn('WebSocket connection failed:', error);
        // Don't redirect, just log the error - WebSocket is not critical for settings page
    }
}

async function updatePageContentBasedOnPermissions() {
    const accessToken = localStorage.getItem('accessToken');
    
    if (!accessToken) {
        return;
    }

    try {
        const response = await fetch('/api/auth/user/profile', {
            method: 'GET',
            headers: {
                'Authorization': `Bearer ${accessToken}`,
                'Content-Type': 'application/json'
            }
        });

        if (response.ok) {
            const userData = await response.json();
            
            // Update page content based on user permissions
            const pageTitle = document.getElementById('pageTitle');
            const pageDescription = document.getElementById('pageDescription');
            const sectionTitle = document.getElementById('sectionTitle');
            const sectionDescription = document.getElementById('sectionDescription');
            const cardTitle = document.getElementById('cardTitle');
            
            if (userData.is_superuser) {
                // Administrator view
                pageTitle.textContent = 'Administrator Settings';
                pageDescription.textContent = 'Configure server settings and preferences';
                sectionTitle.textContent = 'System Configuration';
                sectionDescription.textContent = 'Manage server settings and configuration options. Changes will be applied immediately and affect the entire system.';
                cardTitle.textContent = 'System Settings';
            } else {
                // Regular user view
                pageTitle.textContent = 'Settings';
                pageDescription.textContent = 'Configure preferences';
                sectionTitle.textContent = 'User Settings';
                sectionDescription.textContent = 'Manage your user preferences and settings. Changes will be applied to your account only.';
                cardTitle.textContent = 'User Settings';
            }
        }
    } catch (error) {
        console.error('Error checking user permissions for page content:', error);
    }
}

document.addEventListener('DOMContentLoaded', async function() {
    // Verify user authentication first
    try {
        await verifyAccessToken();
    } catch (error) {
        console.error('Authentication verification failed:', error);
        return; // verifyAccessToken will handle the redirect
    }

    // Check if user is authenticated before loading settings
    const accessToken = localStorage.getItem('accessToken');
    
    if (!accessToken) {
        console.error('No access token found, redirecting to login');
        window.location.href = '/login';
        return;
    }

    // Update page content based on user permissions
    await updatePageContentBasedOnPermissions();

    // Initialize websocket and fetch settings
    settingsNotificationWebsocket();
    fetchSettings();
});

// Add resize listener to handle responsive display
window.addEventListener('resize', function() {
    // Re-fetch data to refresh display mode based on screen size
    fetchSettings();
});