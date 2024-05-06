#!/bin/bash
docker exec -it telepy-web-${PROJECT_NAME} supervisorctl -c /etc/supervisor/conf.d/supervisord.conf