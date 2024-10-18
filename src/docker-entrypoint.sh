#!/bin/bash

# Set the correct permissions for the SSH config file
chown -R root:root /root/.ssh/config

# Set the correct permissions for the SSH key
chmod 600 /root/.ssh/id_rsa

# Set scripts to executable
chmod +x /scripts/*.sh

# Run collectstatic if not in debug mode
if [ "${DEBUG,,}" = "true" ]; then
    echo "Running in Debug mode"
else
    echo "Running in Production mode"
    # Remove old static files in folder and create a new one
    rm -rf /src/staticfiles/* && python manage.py collectstatic --noinput
fi

# Migrate the database
python manage.py makemigrations && python manage.py migrate

# Start services
/usr/local/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
