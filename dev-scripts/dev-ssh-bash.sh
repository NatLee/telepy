#!/bin/bash
export $(cat ./.env)
docker exec -it telepy-ssh-${PROJECT_NAME} bash
