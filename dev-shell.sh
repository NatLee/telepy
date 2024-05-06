#!/bin/bash
export $(cat ./.env)
docker exec -it telepy-web-${PROJECT_NAME} bash -c 'python manage.py shell'
