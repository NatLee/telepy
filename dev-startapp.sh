#!/bin/bash
export $(cat ./.env)
docker exec -it telepy-web bash -c "python manage.py startapp `echo $@`"

# check the folder is created
if [ ! -d "./backend/$@" ]; then
    echo "Folder not created"
    exit 1
fi
# if created, we need to make it editable
sudo chown -R $USER:$USER ./backend/$@
