#!/bin/bash
python manage.py makemigrations && python manage.py migrate
/usr/local/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
