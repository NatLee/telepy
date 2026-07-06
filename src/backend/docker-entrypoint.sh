#!/bin/bash

# Set the correct permissions for the SSH config file
# (Docker Desktop mounts host files as 777, SSH rejects world-writable config)
chmod 600 /root/.ssh/config
chown root:root /root/.ssh/config

# Set the correct permissions for the SSH key
chmod 600 /root/.ssh/id_rsa

# Set scripts to executable
chmod +x /scripts/*.sh

# Backend root is under /src
cd /src

# Run collectstatic if not in debug mode
if [ "${DEBUG,,}" = "true" ]; then
    echo "Running in Debug mode"
else
    echo "Running in Production mode"
    # collectstatic 是冪等的：直接覆寫變動的檔案即可，不要先 `rm -rf`——rm 會在每次容器啟動時
    # 短暫清空 staticfiles，讓這段期間 admin / Swagger 的靜態資源 404（表現為部署後短時間破圖）。
    # collectstatic overwrites in place; dropping the `rm -rf` avoids an empty-staticfiles window on start.
    python manage.py collectstatic --noinput
fi

# 只跑 migrate，不再於「執行期」makemigrations。
# migration 檔應隨程式碼一起進版控（本 repo 各含 model 的 app 都已有 migrations）；在容器啟動時
# makemigrations 會依「當下 mount 的原始碼」即時生成未受版控的 migration，造成環境間 schema 漂移、
# 不可重現的部署，是正式環境反模式。若日後改了 model，請在本機 `makemigrations` 後把檔案 commit 進來。
# Run only migrate; never makemigrations at runtime (migrations are committed with the code).
python manage.py migrate --noinput

# Start services
/usr/local/bin/supervisord -c /etc/supervisor/conf.d/supervisord.conf
