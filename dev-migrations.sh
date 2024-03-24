#!/bin/bash
docker exec -it telepy-web bash -c 'python manage.py makemigrations && python manage.py migrate'
