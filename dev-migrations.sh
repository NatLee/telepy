#!/bin/bash
docker exec -it telepy-web-${PROJECT_NAME} bash -c 'python manage.py makemigrations && python manage.py migrate'
