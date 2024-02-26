#!/bin/bash

# Set the correct permissions for the SSH config file
chown -R root:root /root/.ssh/config

# Set the correct permissions for the SSH key
chmod 600 /root/.ssh/id_rsa

# Migrate the database
python manage.py makemigrations && python manage.py migrate

# Start services
/usr/local/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
