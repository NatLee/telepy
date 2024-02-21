#!/bin/bash
docker exec -it telepy-web supervisorctl -c /etc/supervisor/conf.d/supervisord.conf