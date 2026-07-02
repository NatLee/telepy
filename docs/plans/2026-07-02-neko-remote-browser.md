# Neko 遠端瀏覽器遷移 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `remote-browser` 功能的傳輸與執行層,從 `selenium/standalone-chromium` + x11vnc + noVNC,換成 m1k1o/**Neko**(WebRTC 串流)+ **neko-rooms**(每個 target 一個獨立容器),在保留現有 SSH `-D` SOCKS proxy 的前提下,取得更順的畫面、原生分頁與真正的 per-target 隔離。

**Architecture:** 後端維持「一個 session = 一條 `ssh -D` SOCKS proxy」,但把「開一顆 Chrome」從 Selenium 改成呼叫 neko-rooms REST API 動態建立/銷毀一個 neko 房間;每個房間跑我們自訂的 `telepy-neko-chromium` image(把 `--proxy-server` 改成由環境變數注入),房間容器掛在既有的 `telepy-network`,透過 `$HOSTNAME:<proxy_port>` 連回後端的 SSH SOCKS。房間網頁與 WebRTC 訊令走 **neko-rooms 內建 reverse proxy**(`TRAEFIK_ENABLED=false` 時 neko-rooms 會以 `m1k1o.neko_rooms.proxy.*` label 自行反代 `/neko/<room>/` 到房間容器,含 WebSocket 與「房間啟動中」等待頁);Traefik 只需在 file provider(`dynamic.yml`)加一條 `PathPrefix(/neko)` → `neko-rooms:8080` 的 router,一比一取代原本的 `selenium-novnc` router。WebRTC 媒體走 mux 模式的單一 UDP/TCP 埠段(由房間容器直接發佈到 host,與 Traefik 無關)。前端只是把 iframe 從 noVNC 換成房間 URL。

**Tech Stack:** Django 5 / DRF、Python `requests`、Docker Compose、Traefik v3(僅 file provider,不需 docker provider)、m1k1o/neko(v3, chromium image)、m1k1o/neko-rooms(rooms API + 內建 proxy)、Next.js(iframe)。

---

## 背景與現況(實作前必讀)

現有實作(要被取代或改寫的部分):

- `src/backend/authorized_keys/remote_browser_service.py` — 目前:`ssh -D` + 呼叫 `selenium-standalone:4444` 建 session + CDP 注入 stealth JS + `ACTIVE_SESSIONS` 記憶體登記 + 背景 GC thread。
- `src/backend/authorized_keys/browse_views.py` — `RemoteBrowserStartView / StopView / PingView`(權限檢查後呼叫 service)。**權限與 URL 路徑保持不變;views 直接把 service 回傳值 pass-through 成 JSON,因此本檔完全不需修改。**
- `src/configs/traefik/dynamic.yml` — `selenium-novnc` router 把 `/novnc` 導到 `selenium-standalone:7900`。
- `docker-compose.yml` — `selenium-standalone` service。
- `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` — 用 iframe 載 `vnc_url`。

保持不變、務必別動的既有行為:

- SSH `-D` 這段(`ssh -N -q -D 0.0.0.0:<port> -p <reverse_port> <user>@reverse`)照舊 —— `reverse` 這個 host 由既有網路設定解析,已在正式環境運作,**本計畫原封保留**。
- `browse_views.py` 的權限判斷(`TunnelPermissionManager.check_access` / `TunnelPermissionService.get_allowed_usernames`)與三條 URL(`/start`、`/stop`、`/ping`)。
- 前端的 heartbeat ping / beforeunload 清理邏輯。

## 關鍵架構決策(為什麼這樣做)

1. **為什麼要自訂 image 注入 proxy?** neko chromium image 的啟動指令寫死在 `/etc/neko/supervisord/chromium.conf`,沒有「額外 flags」環境變數;而 neko-rooms 的 `BrowserPolicy` 只支援 extensions / devtools / persistent_data,**不含 proxy**。所以最可靠的做法是做一顆薄薄的自訂 image,把 chromium 指令改成「當 `PROXY_SERVER` 有值時才加上 `--proxy-server`」,再用 neko-rooms 的 `envs` 逐房間注入。這條路不依賴 mounts/whitelist/storage,最穩、最好測。

2. **為什麼用 neko-rooms 而不是後端自刻 Docker spawner?** 已依你的選擇採用 neko-rooms:它把「建/刪/列房間、房間路由(內建 proxy)、埠配置、idle 等待頁」都做好了,後端只要呼叫 REST API。後端仍保有自己的 `ACTIVE_SESSIONS` 生命週期與權限層,neko-rooms 只當「容器工廠」。

3. **WebRTC 網路成本(無法迴避,已知)。** WebRTC 媒體走 UDP,不能穿過 Traefik 的 HTTP entrypoint。採 **mux 模式**:每個房間只需 epr 埠段裡的「一個 UDP + 一個 TCP」(源碼確認:mux 時 `portsNeeded=1`,UDP/TCP 同號,`max_connections` 被忽略)。因此要在 host 上發佈一段 epr 埠(預設 59000–59999,本計畫收斂成可控範圍)並設 `NEKO_ROOMS_NAT1TO1` 為伺服器對外可達 IP(留空時 viper 解析為空 slice,neko 自行偵測,安全)。房間的 HTTP/訊令(wss)由 neko-rooms 內建 proxy 反代(見決策 6)。

4. **stealth JS 可以整段拿掉。** Neko 跑的是「真人瀏覽器」,沒有 `navigator.webdriver`、沒有 automation extension,反偵測體質天生就比 Selenium 好。原本的 CDP 注入不再需要。

5. **neko-rooms API 只走內網。** 後端以 `http://neko-rooms:8080/api/rooms` 直接呼叫,neko-rooms 不對外開埠;對外只透過 Traefik 的 `PathPrefix(/neko)` router 曝露房間 proxy 路徑 —— `/api/*` 由 Traefik 導去 Django backend,neko-rooms 自己的 `/api` 與 admin SPA 皆不可從外部觸及(源碼確認:其 HTTP server 以 `/*` fallback 服務房間 proxy,`/api` 與靜態檔是另外的路由)。

6. **為什麼用 neko-rooms 內建 proxy 而不是 Traefik docker provider?** neko-rooms 在 `TRAEFIK_DOMAIN` 為空或 `*` 時,產生的 router rule 是 ``PathPrefix(...) && HostRegexp(`{host:.+}`)`` —— 這是 Traefik **v2** 的具名群組語法,本專案用的 **v3**(v3.7.6)無法解析,房間會直接 404。改用內建 proxy 模式(`NEKO_ROOMS_TRAEFIK_ENABLED=false`)後:(a) 完全繞開 v2/v3 語法問題;(b) Traefik 不需啟用 docker provider、不需掛 `docker.sock`(只有 neko-rooms 需要);(c) `traefik.yml` 完全不用動;(d) 免費獲得 neko-rooms 的「房間啟動中」等待頁(`wait_enabled` 預設 true)。Go 的 `httputil.ReverseProxy` 原生支援 WebSocket upgrade,訊令 wss 無虞。

## 檔案結構(先鎖定切分)

**新增**

- `docker/neko-chromium/Dockerfile` — 以 `ghcr.io/m1k1o/neko/chromium` 為 base 的薄自訂 image。
- `docker/neko-chromium/chromium.conf` — 覆寫 supervisord 的 chromium program,支援 `PROXY_SERVER` 條件注入。
- `src/backend/services/neko_rooms_client.py` — neko-rooms REST API 薄封裝(create / get / delete / list)。
- `src/backend/services/tests/test_neko_rooms_client.py` — client 單元測試(mock `requests`)。
- `src/backend/authorized_keys/tests/test_remote_browser_service.py` — service 邏輯單元測試。

**修改**

- `src/backend/authorized_keys/remote_browser_service.py` — 換掉 Selenium,改用 neko-rooms;房間打 label;GC 加對帳;最大 session 數保護(views 不用動,回傳 key 由 `vnc_url` 改為 `url` 會自動 pass-through)。
- `src/backend/site_settings/models.py` `serializers.py` `admin.py`(+ migration)— 新增 `remote_browser_max_sessions`、`remote_browser_neko_image` 設定。
- `docker-compose.yml` — 移除 `selenium-standalone`;新增 `neko-rooms`(掛 docker.sock);build 自訂 image;後端加 Neko 相關 env。Traefik 服務**不變**。
- `src/configs/traefik/dynamic.yml` — 移除 `selenium-novnc` router/service/middleware,新增 `neko-rooms` router(`/neko` → `neko-rooms:8080`,不 strip prefix)。
- `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` — iframe `allow` 屬性、標籤文字、改用 `url`。
- `.env.example` — 新增 Neko/EPR/NAT1TO1 變數。

**刪除**

- `src/backend/authorized_keys/tests.py` — 空 stub,必須刪除,否則與新建的 `tests/` package 衝突(Python 不允許 `tests.py` 與 `tests/` 並存)。

**依賴關係**:Task 1(image)→ Task 6(compose 會 build 它);Task 2(client)→ Task 3(service 用它);Task 5(settings)→ Task 3 讀設定(以 `getattr` 預設值解耦,順序可對調)。建議依序執行。

---

## Task 0: 前置決策與分支

**Files:** 無(環境準備)

- [ ] **Step 1: 建立工作分支**

Run:
```bash
cd /path/to/telepy
git checkout -b feat/neko-remote-browser
```

- [ ] **Step 2: 決定並記下三個部署參數(寫進 PR 描述)**

- `NEKO_EPR_RANGE`:mux 模式下「一房一埠」,範圍大小 = 最大同時房間數。建議 `59000-59049`(50 房)起步。
- `NEKO_NAT1TO1_IP`:client 端瀏覽器能連到的伺服器 IP。本機開發可留空(neko 會自行偵測);正式環境填公開/內網 IP。
- `NEKO_IMAGE`:固定 `telepy-neko-chromium:latest`(Task 1 產出)。

- [ ] **Step 3: 確認 host 具備 Docker socket 與埠可用**

Run:
```bash
test -S /var/run/docker.sock && echo "docker.sock ok"
```
Expected: 印出 `docker.sock ok`(neko-rooms 需要它;Traefik 不需要)。

---

## Task 1: 自訂 neko chromium image(env 驅動 proxy)

**Files:**
- Create: `docker/neko-chromium/Dockerfile`
- Create: `docker/neko-chromium/chromium.conf`

- [ ] **Step 1: 寫 supervisord 覆寫檔**

Create `docker/neko-chromium/chromium.conf`(以官方 `apps/chromium/supervisord.conf` 為基底,把 chromium 的 `command` 換成 bash 包裝、加入條件式 proxy;**官方檔案同時含 `[program:chromium]` 與 `[program:openbox]` 兩段,openbox(window manager)必須原樣保留**,否則視窗不會 maximize):

```ini
[program:chromium]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s",PROXY_SERVER="%(ENV_PROXY_SERVER)s"
command=/bin/bash -c 'exec /usr/bin/chromium \
  --no-sandbox \
  --window-position=0,0 \
  --display=%(ENV_DISPLAY)s \
  --user-data-dir=/home/neko/.config/chromium \
  --no-first-run \
  --start-maximized \
  --bwsi \
  --force-dark-mode \
  --disable-file-system \
  --disable-gpu \
  --disable-software-rasterizer \
  --disable-dev-shm-usage \
  ${PROXY_SERVER:+--proxy-server="$PROXY_SERVER"} \
  ${PROXY_SERVER:+--proxy-bypass-list="<-loopback>"}'
stopsignal=INT
autorestart=true
priority=800
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/chromium.log
stdout_logfile_maxbytes=100MB
stdout_logfile_backups=10
redirect_stderr=true

[program:openbox]
environment=HOME="/home/%(ENV_USER)s",USER="%(ENV_USER)s",DISPLAY="%(ENV_DISPLAY)s"
command=/usr/bin/openbox --config-file /etc/neko/openbox.xml
autorestart=true
priority=300
user=%(ENV_USER)s
stdout_logfile=/var/log/neko/openbox.log
stdout_logfile_maxbytes=100MB
stdout_logfile_backups=10
redirect_stderr=true
```

說明:supervisord 會先展開 `%(ENV_DISPLAY)s` / `%(ENV_PROXY_SERVER)s`(後者要求 env 一定存在,由 Dockerfile 的 `ENV PROXY_SERVER=""` 保證),`${PROXY_SERVER:+...}` 則於執行期由 shell 判斷 —— `PROXY_SERVER` 為空就完全不加 proxy flag(image 可獨立運作),有值才走 SOCKS。與舊 Selenium 設定一致地保留 `--proxy-bypass-list=<-loopback>`(連 loopback 也走 proxy)。

- [ ] **Step 2: 寫 Dockerfile**

Create `docker/neko-chromium/Dockerfile`:

```dockerfile
FROM ghcr.io/m1k1o/neko/chromium:latest

# 明確標注 neko API 版本,讓 neko-rooms 的自動偵測(ImageInspect)永遠正確;
# service 端另會顯式送 api_version=3,雙保險。
LABEL net.m1k1o.neko.api-version=3

# proxy 由後端經 neko-rooms envs 注入;預設空字串 = 直連(image 可單獨啟動)
ENV PROXY_SERVER=""

# 覆寫官方 chromium 啟動設定,加入條件式 --proxy-server(含 openbox 段,見 chromium.conf)
COPY chromium.conf /etc/neko/supervisord/chromium.conf
```

- [ ] **Step 3: 本地 build**

Run:
```bash
docker build -t telepy-neko-chromium:latest docker/neko-chromium/
```
Expected: build 成功,`docker images | grep telepy-neko-chromium` 看得到。

- [ ] **Step 4: 冒煙測試 —— 不帶 proxy 也能起、chromium 有進程**

Run:
```bash
docker run -d --rm --name neko-smoke --shm-size=2g -p 8080:8080 \
  -e NEKO_MEMBER_MULTIUSER_USER_PASSWORD=neko \
  -e NEKO_MEMBER_MULTIUSER_ADMIN_PASSWORD=admin \
  telepy-neko-chromium:latest
sleep 8
docker exec neko-smoke pgrep -a chromium | head -1
docker rm -f neko-smoke
```
Expected: `pgrep` 印出含 `/usr/bin/chromium` 的一行(**不含** `--proxy-server`,因為未設 PROXY_SERVER)。

> 註:上面的 `NEKO_MEMBER_...` 只是讓 v3 image 能起 member provider 做冒煙測試;正式參數由 neko-rooms 帶。若你的 neko 版本 env 名不同,以 `docker logs neko-smoke` 為準修正,不影響本 image 的 proxy 邏輯。

- [ ] **Step 5: 冒煙測試 —— 帶 proxy 時 flag 有生效**

Run:
```bash
docker run -d --rm --name neko-smoke2 --shm-size=2g \
  -e PROXY_SERVER="socks5://127.0.0.1:9999" \
  telepy-neko-chromium:latest
sleep 8
docker exec neko-smoke2 pgrep -af chromium | grep -- "--proxy-server=socks5://127.0.0.1:9999"
docker rm -f neko-smoke2
```
Expected: `grep` 命中,證明 `PROXY_SERVER` 已轉成 chromium flag。

- [ ] **Step 6: Commit**

```bash
git add docker/neko-chromium/Dockerfile docker/neko-chromium/chromium.conf
git commit -m "feat(neko): add telepy-neko-chromium image with env-driven SOCKS proxy"
```

---

## Task 2: neko-rooms REST client

**Files:**
- Create: `src/backend/services/neko_rooms_client.py`
- Create: `src/backend/services/tests/__init__.py`(若不存在)
- Test: `src/backend/services/tests/test_neko_rooms_client.py`

neko-rooms API 行為(已對源碼確認 `internal/api/rooms.go`):`POST /api/rooms?start=true`(body 為 RoomSettings)會**建立並啟動**房間、回傳完整 RoomEntry(含 `id`、`name`、`url`、`is_ready`、`status`);`GET /api/rooms/{id}` 取單一;`DELETE /api/rooms/{id}` 回 204;`GET /api/rooms?<label>=<value>` 依 label 過濾清單。

- [ ] **Step 1: 先寫失敗測試**

Create `src/backend/services/tests/test_neko_rooms_client.py`:

```python
from unittest import mock
from django.test import TestCase
from services.neko_rooms_client import NekoRoomsClient, NekoRoomsError


class NekoRoomsClientTest(TestCase):
    def setUp(self):
        self.client = NekoRoomsClient(base_url="http://neko-rooms:8080")

    @mock.patch("services.neko_rooms_client.requests.post")
    def test_create_room_posts_with_start_true_and_returns_entry(self, post):
        post.return_value = mock.Mock(
            status_code=200,
            json=lambda: {"id": "abc", "name": "telepy-x", "url": "/neko/telepy-x/", "is_ready": False},
        )
        post.return_value.raise_for_status = lambda: None

        entry = self.client.create_room({"name": "telepy-x"})

        self.assertEqual(entry["id"], "abc")
        args, kwargs = post.call_args
        self.assertEqual(args[0], "http://neko-rooms:8080/api/rooms")
        self.assertEqual(kwargs["params"], {"start": "true"})
        self.assertEqual(kwargs["json"], {"name": "telepy-x"})

    @mock.patch("services.neko_rooms_client.requests.delete")
    def test_delete_room_calls_delete(self, delete):
        delete.return_value = mock.Mock(status_code=204)
        delete.return_value.raise_for_status = lambda: None

        self.client.delete_room("abc")

        delete.assert_called_once_with("http://neko-rooms:8080/api/rooms/abc", timeout=10)

    @mock.patch("services.neko_rooms_client.requests.get")
    def test_list_rooms_passes_labels_as_query(self, get):
        get.return_value = mock.Mock(status_code=200, json=lambda: [{"id": "abc"}])
        get.return_value.raise_for_status = lambda: None

        rooms = self.client.list_rooms({"telepy.managed": "true"})

        self.assertEqual(rooms, [{"id": "abc"}])
        _, kwargs = get.call_args
        self.assertEqual(kwargs["params"], {"telepy.managed": "true"})

    @mock.patch("services.neko_rooms_client.requests.post")
    def test_create_room_raises_neko_error_on_http_failure(self, post):
        import requests as _rq
        resp = mock.Mock(status_code=500, text="boom")
        resp.raise_for_status = mock.Mock(side_effect=_rq.exceptions.HTTPError("500"))
        post.return_value = resp

        with self.assertRaises(NekoRoomsError):
            self.client.create_room({"name": "telepy-x"})
```

- [ ] **Step 2: 跑測試,確認失敗**

Run: `docker compose run --rm backend python manage.py test services.tests.test_neko_rooms_client -v 2`
Expected: FAIL(`ModuleNotFoundError: No module named 'services.neko_rooms_client'`)。

- [ ] **Step 3: 實作 client**

Create `src/backend/services/neko_rooms_client.py`:

```python
import os
import time
import logging
import requests

logger = logging.getLogger(__name__)


class NekoRoomsError(Exception):
    pass


class NekoRoomsClient:
    """neko-rooms REST API 薄封裝。後端於內網直接呼叫,不經 Traefik。"""

    def __init__(self, base_url=None, timeout=10):
        self.base_url = (base_url or os.getenv("NEKO_ROOMS_API", "http://neko-rooms:8080")).rstrip("/")
        self.timeout = timeout

    def _rooms_url(self, suffix=""):
        return f"{self.base_url}/api/rooms{suffix}"

    def create_room(self, settings: dict) -> dict:
        try:
            resp = requests.post(
                self._rooms_url(),
                params={"start": "true"},
                json=settings,
                timeout=self.timeout,
            )
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def get_room(self, room_id: str) -> dict:
        try:
            resp = requests.get(self._rooms_url(f"/{room_id}"), timeout=self.timeout)
            resp.raise_for_status()
            return resp.json()
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def delete_room(self, room_id: str) -> None:
        try:
            resp = requests.delete(self._rooms_url(f"/{room_id}"), timeout=self.timeout)
            resp.raise_for_status()
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def list_rooms(self, labels: dict = None) -> list:
        try:
            resp = requests.get(self._rooms_url(), params=labels or {}, timeout=self.timeout)
            resp.raise_for_status()
            return resp.json() or []
        except requests.exceptions.RequestException as e:
            raise NekoRoomsError(str(e))

    def wait_ready(self, room_id: str, timeout: float = 20.0, interval: float = 0.5) -> bool:
        deadline = time.time() + timeout
        while time.time() < deadline:
            try:
                entry = self.get_room(room_id)
            except NekoRoomsError:
                return False
            if entry.get("is_ready"):
                return True
            time.sleep(interval)
        return False
```

- [ ] **Step 4: 跑測試,確認通過**

Run: `docker compose run --rm backend python manage.py test services.tests.test_neko_rooms_client -v 2`
Expected: PASS(4 tests)。

- [ ] **Step 5: Commit**

```bash
git add src/backend/services/neko_rooms_client.py src/backend/services/tests/
git commit -m "feat(neko): add neko-rooms REST client"
```

---

## Task 3: 改寫 remote_browser_service（保留 ssh -D,換成 neko-rooms）

**Files:**
- Modify: `src/backend/authorized_keys/remote_browser_service.py`(整檔重寫)
- Delete: `src/backend/authorized_keys/tests.py`(空 stub;不刪會與 `tests/` package 衝突)
- Create: `src/backend/authorized_keys/tests/__init__.py`
- Test: `src/backend/authorized_keys/tests/test_remote_browser_service.py`

設計要點:先把 session 登記進 `ACTIVE_SESSIONS`(帶 `session-id`),**再**建房間,避免對帳 thread 在建立空窗期把新房間當孤兒清掉;房間以 `telepy.session-id` label 對帳。

- [ ] **Step 1: 刪除舊 stub、先寫失敗測試**

先刪除空 stub(否則 `tests.py` 與 `tests/` package 並存,import 會衝突):

```bash
git rm src/backend/authorized_keys/tests.py
```

Create `src/backend/authorized_keys/tests/test_remote_browser_service.py`:

```python
from unittest import mock
from django.test import TestCase
import authorized_keys.remote_browser_service as svc


class RemoteBrowserServiceTest(TestCase):
    def tearDown(self):
        svc.ACTIVE_SESSIONS.clear()

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_neko")
    def test_start_creates_room_with_proxy_env_and_registers_session(self, neko, sp, _wp):
        sp.Popen.return_value = mock.Mock(poll=lambda: None)
        neko.create_room.return_value = {"id": "room1", "is_ready": True}
        neko.wait_ready.return_value = True

        result = svc.start_remote_browser("alice", 30001, 7)

        # 有回傳 session_id 與 /neko/ 房間 url
        self.assertIn("session_id", result)
        self.assertTrue(result["url"].startswith("/neko/telepy-"))
        # 房間 envs 帶 socks5 proxy,指向本後端 host
        settings = neko.create_room.call_args[0][0]
        self.assertTrue(settings["envs"]["PROXY_SERVER"].startswith("socks5://"))
        self.assertEqual(settings["labels"][svc.LABEL_MANAGED], "true")
        # session 已登記
        self.assertEqual(len(svc.ACTIVE_SESSIONS), 1)

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_neko")
    def test_start_cleans_up_ssh_when_room_creation_fails(self, neko, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        neko.create_room.side_effect = svc.NekoRoomsError("nope")

        with self.assertRaises(Exception):
            svc.start_remote_browser("alice", 30001, 7)

        proc.terminate.assert_called()             # ssh 有被收掉
        self.assertEqual(len(svc.ACTIVE_SESSIONS), 0)  # 沒有殘留 session

    @mock.patch.object(svc, "_wait_for_port", return_value=True)
    @mock.patch.object(svc, "subprocess")
    @mock.patch.object(svc, "_neko")
    def test_stop_deletes_room_and_terminates_ssh(self, neko, sp, _wp):
        proc = mock.Mock(poll=lambda: None)
        sp.Popen.return_value = proc
        neko.create_room.return_value = {"id": "room1", "is_ready": True}
        neko.wait_ready.return_value = True

        sid = svc.start_remote_browser("alice", 30001, 7)["session_id"]
        ok = svc.stop_remote_browser(sid)

        self.assertTrue(ok)
        neko.delete_room.assert_called_once_with("room1")
        self.assertNotIn(sid, svc.ACTIVE_SESSIONS)
```

- [ ] **Step 2: 跑測試,確認失敗**

Run: `docker compose run --rm backend python manage.py test authorized_keys.tests.test_remote_browser_service -v 2`
Expected: FAIL(現行 service 沒有 `_neko` / `LABEL_MANAGED` / `_wait_for_port` / `NekoRoomsError`,且回傳 key 仍是 `vnc_url`)。

- [ ] **Step 3: 整檔重寫 service**

Replace 全部 `src/backend/authorized_keys/remote_browser_service.py` 內容:

```python
import os
import time
import socket
import logging
import subprocess
import uuid
import threading
import secrets
from typing import Dict, Any

from site_settings.models import SiteSettings
from services.neko_rooms_client import NekoRoomsClient, NekoRoomsError

logger = logging.getLogger(__name__)

# session_id -> { ssh_process, proxy_port, server_id, room_id, room_name, last_seen }
ACTIVE_SESSIONS: Dict[str, Dict[str, Any]] = {}
_SESSIONS_LOCK = threading.Lock()

SSH_HOST = "reverse"                 # 既有 reverse gateway,保持不變
LABEL_MANAGED = "telepy.managed"
LABEL_SESSION = "telepy.session-id"

_neko = NekoRoomsClient()


def get_free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(('', 0))
        return s.getsockname()[1]


def _wait_for_port(host: str, port: int, timeout: float = 8.0) -> bool:
    deadline = time.time() + timeout
    while time.time() < deadline:
        with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
            s.settimeout(0.5)
            try:
                s.connect((host, port))
                return True
            except OSError:
                time.sleep(0.15)
    return False


def _count_active() -> int:
    with _SESSIONS_LOCK:
        return len(ACTIVE_SESSIONS)


def start_remote_browser(target_username, target_reverse_port, server_id):
    settings = SiteSettings.get_solo()
    # getattr 預設值:即使 SiteSettings 欄位尚未 migrate 也能運作(Task 5 會加上可調欄位)
    max_sessions = getattr(settings, "remote_browser_max_sessions", 10)
    if max_sessions and _count_active() >= max_sessions:
        raise Exception(
            "The Proxy Browser has reached its maximum concurrent user limit. "
            "Please wait for someone to disconnect and try again."
        )

    proxy_port = get_free_port()
    ssh_cmd = f"ssh -N -q -D 0.0.0.0:{proxy_port} -p {target_reverse_port} {target_username}@{SSH_HOST}"
    logger.info(f"Starting SSH proxy for target {server_id} on port {proxy_port}")
    ssh_process = subprocess.Popen(ssh_cmd, shell=True)

    # 等 SOCKS proxy listen(取代舊的 time.sleep(2),更快也更可靠)
    if not _wait_for_port("127.0.0.1", proxy_port, timeout=8.0) or ssh_process.poll() is not None:
        try:
            ssh_process.terminate()
        except Exception:
            pass
        raise Exception(f"Failed to start SSH proxy for target {server_id}.")

    session_id = str(uuid.uuid4())
    room_name = f"telepy-{session_id.split('-')[0]}"

    # 先登記(room_id=None),避免對帳 thread 在建立空窗期誤刪新房間
    with _SESSIONS_LOCK:
        ACTIVE_SESSIONS[session_id] = {
            "ssh_process": ssh_process,
            "proxy_port": proxy_port,
            "server_id": server_id,
            "room_id": None,
            "room_name": room_name,
            "last_seen": time.time(),
        }

    proxy_host = os.getenv("HOSTNAME", "backend")   # 後端容器名,房間經 telepy-network 解析
    user_pass = secrets.token_urlsafe(9)
    neko_image = getattr(settings, "remote_browser_neko_image", "telepy-neko-chromium:latest")
    room_settings = {
        "api_version": 3,                   # 顯式指定,跳過 neko-rooms 的 image 偵測(偵測失敗會 fallback v2 → 房間壞掉)
        "name": room_name,
        "neko_image": neko_image,
        "max_connections": 0,               # mux 模式:一房一埠(源碼確認 mux 時此值被忽略)
        "control_protection": False,
        "implicit_control": True,
        "user_pass": user_pass,
        "admin_pass": secrets.token_urlsafe(9),
        "screen": "1280x720@30",
        "video_codec": "VP8",               # 顯式送預設值 —— 不送會因 `"" != "VP8"` 產生空的 NEKO_CAPTURE_VIDEO_CODEC=
        "audio_codec": "OPUS",              # 同上(NEKO_CAPTURE_AUDIO_CODEC)
        "envs": {
            "PROXY_SERVER": f"socks5://{proxy_host}:{proxy_port}",
        },
        "labels": {
            LABEL_MANAGED: "true",
            LABEL_SESSION: session_id,
            "telepy.server-id": str(server_id),
        },
    }

    try:
        room = _neko.create_room(room_settings)     # start=true
    except NekoRoomsError as e:
        stop_remote_browser(session_id)             # 收 ssh + 移除登記
        raise Exception(f"Failed to create Neko room: {e}")

    room_id = room.get("id")
    with _SESSIONS_LOCK:
        if session_id in ACTIVE_SESSIONS:
            ACTIVE_SESSIONS[session_id]["room_id"] = room_id

    # 盡量等到 ready 再回,iframe 就不會停在開機畫面(逾時也照回,neko 有等待頁)
    if room_id:
        _neko.wait_ready(room_id, timeout=20.0)

    # 房間 URL 用 path_prefix + name(與 origin 無關,前端會補 apiBase);usr/pwd 自動登入
    room_url = f"/neko/{room_name}/?usr=telepy&pwd={user_pass}"
    return {"session_id": session_id, "url": room_url, "room_id": room_id}


def ping_remote_browser(session_id):
    with _SESSIONS_LOCK:
        session = ACTIVE_SESSIONS.get(session_id)
        if not session:
            return False
        session["last_seen"] = time.time()
    return True


def stop_remote_browser(session_id):
    with _SESSIONS_LOCK:
        session = ACTIVE_SESSIONS.pop(session_id, None)
    if not session:
        return False

    room_id = session.get("room_id")
    if room_id:
        try:
            _neko.delete_room(room_id)
        except NekoRoomsError as e:
            logger.warning(f"Failed to delete Neko room {room_id}: {e}")

    ssh_process = session.get("ssh_process")
    if ssh_process:
        try:
            ssh_process.terminate()
            ssh_process.wait(timeout=5)
        except Exception:
            try:
                ssh_process.kill()
            except Exception:
                pass
    return True


def _reconcile_orphan_rooms():
    """刪掉 neko-rooms 內帶 telepy label、但本行程已無對應 session 的孤兒房間。"""
    try:
        rooms = _neko.list_rooms({LABEL_MANAGED: "true"})
    except NekoRoomsError:
        return
    with _SESSIONS_LOCK:
        known = set(ACTIVE_SESSIONS.keys())
    for room in rooms:
        labels = room.get("labels") or {}
        sid = labels.get(LABEL_SESSION)
        if sid and sid not in known:
            try:
                _neko.delete_room(room["id"])
                logger.info(f"Reaped orphan Neko room {room.get('id')} (session {sid})")
            except NekoRoomsError:
                pass


def cleanup_dead_sessions():
    while True:
        try:
            idle_timeout = SiteSettings.get_solo().remote_browser_session_idle_timeout
            now = time.time()
            dead = []
            with _SESSIONS_LOCK:
                for sid, sess in list(ACTIVE_SESSIONS.items()):
                    proc = sess.get("ssh_process")
                    if (proc and proc.poll() is not None) or (now - sess.get("last_seen", now)) > idle_timeout:
                        dead.append(sid)
            for sid in dead:
                stop_remote_browser(sid)
            _reconcile_orphan_rooms()
        except Exception:
            pass
        time.sleep(10)


threading.Thread(target=cleanup_dead_sessions, daemon=True).start()
```

- [ ] **Step 4: 跑測試,確認通過**

Run: `docker compose run --rm backend python manage.py test authorized_keys.tests.test_remote_browser_service -v 2`
Expected: PASS(3 tests)。

- [ ] **Step 5: Commit**

```bash
git add src/backend/authorized_keys/remote_browser_service.py src/backend/authorized_keys/tests/
git commit -m "feat(neko): rewrite remote_browser_service to use neko-rooms instead of selenium"
```

---

## Task 5: SiteSettings 新增可調欄位（max sessions / neko image）

**Files:**
- Modify: `src/backend/site_settings/models.py`
- Modify: `src/backend/site_settings/serializers.py`
- Modify: `src/backend/site_settings/admin.py`
- Create(自動產生): `src/backend/site_settings/migrations/0002_*.py`

> service 已用 `getattr(..., 預設)` 讀這兩個值,故本任務與 Task 3 順序可對調;完成後管理員就能在 admin 調整上限與 image。
> migration 可用 `makemigrations` 自動產生(需容器環境),或直接手寫等價的 `AddField` migration(欄位定義單純,兩者結果一致)。
> **注意:本 repo 的 `.gitignore` 刻意排除所有 migration 檔(`0*_*.py`),migration 只存在於各部署環境本地、不進版控** —— 所以 Step 6 的 commit 只含 models/serializers/admin 三檔。

- [ ] **Step 1: models.py 加兩個欄位**

在 `remote_browser_session_idle_timeout` 欄位之後、`get_solo` 之前插入:

```python
    remote_browser_max_sessions = models.IntegerField(
        default=10,
        verbose_name="Remote Browser Max Concurrent Sessions",
        help_text="Maximum number of concurrent proxy-browser sessions (0 = unlimited).",
    )

    remote_browser_neko_image = models.CharField(
        max_length=255,
        default="telepy-neko-chromium:latest",
        verbose_name="Remote Browser Neko Image",
        help_text="Docker image used for the Neko proxy-browser rooms (must be whitelisted in neko-rooms).",
    )
```

- [ ] **Step 2: serializers.py 納入新欄位**

把 `fields` 改成:

```python
        fields = [
            'allow_registration',
            'remote_browser_session_idle_timeout',
            'remote_browser_max_sessions',
            'remote_browser_neko_image',
        ]
```

並在 `create` 與 `update` 各補兩行(與既有同風格):

```python
        instance.remote_browser_max_sessions = validated_data.get(
            'remote_browser_max_sessions', instance.remote_browser_max_sessions
        )
        instance.remote_browser_neko_image = validated_data.get(
            'remote_browser_neko_image', instance.remote_browser_neko_image
        )
```

- [ ] **Step 3: admin.py 顯示新欄位**

```python
    list_display = [
        'allow_registration',
        'remote_browser_session_idle_timeout',
        'remote_browser_max_sessions',
        'remote_browser_neko_image',
    ]
```

- [ ] **Step 4: 產生並套用 migration**

Run:
```bash
docker compose run --rm backend python manage.py makemigrations site_settings
docker compose run --rm backend python manage.py migrate site_settings
```
Expected: 產生 `0002_...py`(新增兩欄位),migrate 顯示 `OK`。

- [ ] **Step 5: 驗證欄位可讀**

Run:
```bash
docker compose run --rm backend python manage.py shell -c \
  "from site_settings.models import SiteSettings; s=SiteSettings.get_solo(); print(s.remote_browser_max_sessions, s.remote_browser_neko_image)"
```
Expected: 印出 `10 telepy-neko-chromium:latest`。

- [ ] **Step 6: Commit**

```bash
git add src/backend/site_settings/
git commit -m "feat(neko): add max_sessions and neko_image site settings"
```

---

## Task 6: docker-compose 改造（移除 selenium、加 neko-rooms）

**Files:**
- Modify: `docker-compose.yml`

- [ ] **Step 1: Traefik service 保持原樣**

採 neko-rooms 內建 proxy 模式,Traefik **不需要** docker provider、也**不掛** docker.sock(只有 neko-rooms 需要 socket)。本步驟無變更,僅確認。

- [ ] **Step 2: 移除 selenium-standalone service**

刪除整段 `selenium-standalone:`(第 112–123 行那塊,含 `shm_size` 與所有 `SE_*` 環境變數)。

- [ ] **Step 3: backend 加 neko-rooms API 位址(可選,顯式化)**

在 `backend` service 的 `environment:` 加:

```yaml
      - NEKO_ROOMS_API=http://neko-rooms:8080
```

- [ ] **Step 4: 新增 build-only 服務(讓 compose 能建自訂 image)**

在 `services:` 下新增:

```yaml
  neko-chromium-image:
    build:
      context: ./docker/neko-chromium
    image: telepy-neko-chromium:latest
    profiles: [ "images" ]
    command: [ "true" ]
```

以 `docker compose --profile images build neko-chromium-image` 建立 image(等同 Task 1 的 `docker build`);平時 `up` 不會啟動它。

- [ ] **Step 5: 新增 neko-rooms 服務**

在 `services:` 下新增(注意 `INSTANCE_NETWORK` 必須是**實際網路名** `telepy-network-${PROJECT_NAME}`):

```yaml
  neko-rooms:
    <<: [ *common-networks, *common-restart ]
    image: m1k1o/neko-rooms:latest
    container_name: telepy-neko-rooms-${PROJECT_NAME}
    environment:
      - TZ=Asia/Taipei
      - NEKO_ROOMS_MUX=true
      - NEKO_ROOMS_EPR=${NEKO_EPR_RANGE:-59000-59049}
      - NEKO_ROOMS_NAT1TO1=${NEKO_NAT1TO1_IP:-}
      - NEKO_ROOMS_NEKO_IMAGES=telepy-neko-chromium:latest
      - NEKO_ROOMS_INSTANCE_NAME=telepy-${PROJECT_NAME}
      - NEKO_ROOMS_INSTANCE_NETWORK=telepy-network-${PROJECT_NAME}
      - NEKO_ROOMS_PATH_PREFIX=/neko
      - NEKO_ROOMS_STORAGE_ENABLED=false
      - NEKO_ROOMS_TRAEFIK_ENABLED=false
      - NEKO_ROOMS_PROXY=true
    volumes:
      - /var/run/docker.sock:/var/run/docker.sock
```

要點:
- `neko-rooms` 這個 service 名就是後端呼叫用的 DNS(`http://neko-rooms:8080`);它用 docker.sock 建房間容器,並把房間掛到 `INSTANCE_NETWORK`(= telepy-network),房間才能用 `socks5://$HOSTNAME:<port>` 連回後端 SSH proxy。
- `NEKO_ROOMS_TRAEFIK_ENABLED=false` → 房間改掛 `m1k1o.neko_rooms.proxy.*` label,由 neko-rooms 自己的 HTTP server 反代 `/neko/<room>/`(Task 7 只需把 Traefik 的 `/neko` 指到它)。
- `NEKO_ROOMS_INSTANCE_NAME=telepy-${PROJECT_NAME}`:房間容器名 = `<instance_name>-<room_name>`,避免多套部署(不同 `PROJECT_NAME`)在同一台 host 撞名。
- `NEKO_ROOMS_PROXY=true`:server 信任 X-Forwarded-*(位於 Traefik 之後,log 記到真實 client IP)。
- `${NEKO_EPR_RANGE:-59000-59049}` / `${NEKO_NAT1TO1_IP:-}` 帶預設值,`.env` 未設定時 compose 也不會壞;`NAT1TO1` 空字串經 viper 解析為空 slice(源碼確認),neko 會自行偵測 IP。

- [ ] **Step 6: 驗證 compose 語法**

Run: `docker compose config >/dev/null && echo "compose ok"`
Expected: 印出 `compose ok`(`NEKO_EPR_RANGE` / `NEKO_NAT1TO1_IP` 已有 compose 預設值,`.env` 未設也不會失敗;正式環境仍應在 `.env` 明確設定,見 Task 9)。

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml
git commit -m "feat(neko): swap selenium-standalone for neko-rooms in compose"
```

---

## Task 7: Traefik 路由替換(selenium-novnc → neko-rooms)

**Files:**
- Modify: `src/configs/traefik/dynamic.yml`(`traefik.yml` **完全不動**)

- [ ] **Step 1: 替換路由**

在 `dynamic.yml`:
- 刪除 `routers:` 內的 `selenium-novnc:` 整段。
- 刪除 `middlewares:` 內的 `strip-novnc:` 整段(若 `middlewares:` 因此變空,一併刪除該 key)。
- 刪除 `services:` 內的 `selenium-service:` 整段。
- 新增 router 與 service(**不 strip prefix** —— neko-rooms 的 proxy 以 `/neko/<room>` 完整路徑做 prefix tree match,由它自己 StripPrefix 轉發給房間):

```yaml
    neko-rooms:
      <<: *commonRouterSettings
      rule: "PathPrefix(`/neko`)"
      service: neko-rooms-service
```

```yaml
    neko-rooms-service:
      loadBalancer:
        servers:
          - url: "http://neko-rooms:8080"
```

保留 `frontend` / `backend-api` / `backend-tunnel-sharing` / `backend-websocket` 等其餘路由不動。安全性:`/api` 仍由 `backend-api` router 導向 Django,neko-rooms 自己的 `/api` 不會被外部觸及(只有 `/neko/*` 進得來,其 server 對該前綴只服務房間 proxy)。

- [ ] **Step 2: 驗證 Traefik 設定可被解析**

Run:
```bash
docker compose up -d traefik
docker compose logs traefik | grep -i error | tail -20
curl -s -o /dev/null -w "%{http_code}\n" http://localhost:${WEB_SERVER_PORT:-8787}/neko/nonexistent/
```
Expected: 無 fatal error;curl 回 200(neko-rooms 的「room not found」等待頁)或 502(neko-rooms 尚未啟動),而**不是** Traefik 的 404(代表 router 沒生效)。

- [ ] **Step 3: Commit**

```bash
git add src/configs/traefik/dynamic.yml
git commit -m "feat(neko): route /neko to neko-rooms built-in proxy, drop selenium noVNC route"
```

---

## Task 8: 前端 iframe 改用 Neko 房間 URL

**Files:**
- Modify: `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx`

- [ ] **Step 1: 讀 `data.url`(取代 `data.vnc_url`)**

把:

```tsx
            let vncAbsolute = data.vnc_url as string;
```

改成:

```tsx
            let vncAbsolute = data.url as string;
```

- [ ] **Step 2: iframe 加上 WebRTC 需要的權限**

把 iframe 元素:

```tsx
                    <iframe
                        src={vncUrl}
                        className="w-full h-full border-0"
                        title="Proxy Browser noVNC"
                    />
```

改成:

```tsx
                    <iframe
                        src={vncUrl}
                        className="w-full h-full border-0"
                        title="Proxy Browser (Neko)"
                        allow="clipboard-read; clipboard-write; autoplay; fullscreen"
                    />
```

- [ ] **Step 3: 更新面板文案(noVNC/Selenium → Neko)**

- 標題:`Proxy Browser (noVNC)` → `Proxy Browser (Neko)`。
- 說明段落 `Starts a dedicated Selenium Chrome container. ...` → `Starts a dedicated Neko Chromium session. Traffic is tunneled through the target server ({username}@reverse), masquerading external requests as the target machine.`
- Loading 文案 `Spinning up Selenium Session and binding SSH proxy...` → `Spinning up Neko browser and binding SSH proxy...`

- [ ] **Step 4: 前端建置驗證**

Run: `cd src/frontend && npm run build`
Expected: build 成功、無 TypeScript 錯誤。

- [ ] **Step 5: Commit**

```bash
git add src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx
git commit -m "feat(neko): point remote browser iframe at neko room url"
```

---

## Task 9: 環境變數與防火牆

**Files:**
- Modify: `.env.example`
- Modify: `.env`(本機/部署,不進版控)

- [ ] **Step 1: `.env.example` 補上 Neko 區塊**

於檔尾新增:

```bash
# =========[ Neko Proxy Browser ]=========
# mux 模式:一房一埠;範圍大小 = 最大同時房間數
NEKO_EPR_RANGE=59000-59049
# client 端瀏覽器可連到的伺服器 IP;本機開發可留空,正式環境填公開/內網 IP
NEKO_NAT1TO1_IP=
```

- [ ] **Step 2: 同步到實際 `.env`**

在你的 `.env` 加入相同兩個變數(`NEKO_NAT1TO1_IP` 於正式環境務必填對外可達 IP,否則遠端 client 的 WebRTC 會連不上)。

- [ ] **Step 3: 開放 host 防火牆的 epr 埠(mux:UDP+TCP)**

正式主機需放行 `NEKO_EPR_RANGE`(預設 59000–59049)的 **UDP 與 TCP**。例:

```bash
sudo ufw allow 59000:59049/udp
sudo ufw allow 59000:59049/tcp
```
Expected: 規則新增成功(本機 Docker Desktop 通常免設)。

- [ ] **Step 4: Commit**

```bash
git add .env.example
git commit -m "docs(neko): document NEKO_EPR_RANGE and NAT1TO1 env vars"
```

---

## Task 10: 端到端驗證與收尾

**Files:** 無(整合驗證)

- [ ] **Step 1: 建 image 並啟動整個 stack**

Run:
```bash
docker compose --profile images build neko-chromium-image
docker compose up -d --build
docker compose ps
```
Expected: `traefik / frontend / backend / redis / ssh / neko-rooms` 都 Up;**沒有** selenium。

- [ ] **Step 2: 後端可連到 neko-rooms API**

Run:
```bash
docker compose exec backend python -c \
  "import requests; print(requests.get('http://neko-rooms:8080/api/rooms').status_code)"
```
Expected: 印出 `200`。

- [ ] **Step 3: 由 UI 啟動一個 proxy browser session**

在網頁進入某個 tunnel 的 Terminal 分頁 → Proxy Browser → Start Chrome。
Expected: iframe 於數秒內出現 Neko 畫面(先短暫等待頁再進瀏覽器);`docker ps` 多出一個 `telepy-neko-chromium` 房間容器。

- [ ] **Step 4: 驗證分頁(可切分頁)**

在 Neko 畫面按 `Ctrl+T` 開新分頁、輸入不同網址。
Expected: 原生多分頁可用、可切換 —— 符合「可切分頁」需求。

- [ ] **Step 5: 驗證 proxy 真的走 target 出口(核心)**

先取得該 session 的 SOCKS 埠(從後端日誌 `Starting SSH proxy ... on port <P>`),再:

```bash
docker compose exec backend curl -s --socks5-hostname 127.0.0.1:<P> https://ifconfig.me
```
Expected: 回傳的公網 IP 是 **target 機器** 的出口 IP(不是本伺服器);同一條 proxy 也是 Neko 瀏覽器在用,故瀏覽器內開 IP 查詢頁會顯示同一 IP。

- [ ] **Step 6: 驗證 per-target 隔離(不同機器不共用同個 instance)**

對兩個不同 target 各開一個 session。
Expected: `docker ps` 出現**兩個獨立**房間容器、兩個獨立畫面,互不干擾 —— 符合「不同機器不用同個 instance」需求(且解決舊 Selenium 共用單一 X display 的問題)。

- [ ] **Step 7: 驗證 idle GC**

停止前端(關閉分頁)使 ping 中斷,等 `remote_browser_session_idle_timeout + 10s`。
Expected: 房間容器與對應 `ssh` 進程被自動清掉;`ACTIVE_SESSIONS` 不再有該 session。

- [ ] **Step 8: 驗證孤兒房間對帳**

手動建一個帶 `telepy.managed=true` label、但無對應 session 的房間:

```bash
docker compose exec backend python -c \
"from services.neko_rooms_client import NekoRoomsClient as C; \
print(C().create_room({'name':'telepy-orphan','neko_image':'telepy-neko-chromium:latest','max_connections':0,'labels':{'telepy.managed':'true','telepy.session-id':'nonexistent'}})['id'])"
```
Expected: 下一輪對帳(≤10s)後,該房間被 `_reconcile_orphan_rooms` 清除(log 出現 `Reaped orphan Neko room`)。

- [ ] **Step 9: 後端測試全綠**

Run: `docker compose run --rm backend python manage.py test -v 2`
Expected: 全數 PASS(含 Task 2/3 新測試)。

- [ ] **Step 10: 合併**

```bash
git checkout main && git merge --no-ff feat/neko-remote-browser
```

---

## Rollback 計畫

若上線後出狀況,回退很單純(改動彼此獨立、且以 git 分段提交):

- **只回前端**:`git revert` Task 8 的 commit,iframe 立即回到舊行為(但後端已改,不建議單獨回)。
- **整體回退**:`git checkout main`(未合併前)或 `git revert` 合併 commit;`docker-compose.yml` 還原 `selenium-standalone`、`dynamic.yml` 還原 `selenium-novnc`,`docker compose up -d --build`(`traefik.yml` 本來就沒動)。
- neko-rooms 與房間容器可獨立清理:`docker rm -f $(docker ps -q --filter "label=telepy.managed=true")` 再停 `neko-rooms`。
- 舊 `selenium/standalone-chromium` image 建議在完全驗收前先別刪,保留快速回退能力。

## 已知風險與備註

- **WebRTC/NAT**:若遠端 client 位於受限網路(對稱 NAT / 只開 443),單靠 STUN 可能連不上,需再架 TURN(neko 支援 `NEKO_ICESERVERS`)。本計畫先用 mux + NAT1To1 涵蓋一般情境。
- **自動登入參數**:iframe URL 用 `?usr=telepy&pwd=<pass>` 自動登入;若你的 neko 版本參數不同,Step 3 會看到一個小登入框(輸入一次密碼即可),屆時調整 `remote_browser_service.py` 的 `room_url` 組法即可,不影響其他部分。
- **上游 proxy 模式為非預設路徑**:neko-rooms 官方文件主推 Traefik 整合;內建 proxy 模式(`m1k1o.neko_rooms.proxy.*` + `/*` fallback handler)已對 master 源碼確認存在且支援 wait page/WebSocket,但升級 neko-rooms 版本時應重新確認此行為未變。
- **`is_ready` 依賴 healthcheck**:`wait_ready` 輪詢的 `is_ready` = 房間事件 ready 或 container `healthy`;若自訂 image 意外失去 HEALTHCHECK,`wait_ready` 會等滿 timeout 後照樣回傳(neko-rooms 等待頁會接手),功能不壞、只是 API 回應多等幾秒。
- **image 更新**:neko 上游更新時,重建 `telepy-neko-chromium`(`docker compose --profile images build neko-chromium-image`);因為只覆寫一個 supervisord 檔,衝突面很小。
- **資源**:一 session 一容器,記憶體/磁碟成本高於舊的「單一 Selenium node 多 session」,但換得真正隔離與更順的 WebRTC 體感;用 `remote_browser_max_sessions` 控上限。

## Self-Review 結果

- **需求涵蓋**:可切分頁 → Task 10 Step 4;不同機器不共用 instance → Task 3(一 session 一房間 + label)、Task 10 Step 6;proxy 逐房間注入 → Task 1 + Task 3(`envs.PROXY_SERVER`);減肥/加速 → 移除 Selenium Grid(Task 6)、poll 取代 sleep(Task 3)、WebRTC 取代 noVNC(全案)。
- **Placeholder 掃描**:無 TODO/待填;唯一「驗證後可能微調」處(自動登入參數)已於「已知風險」明確標註並給出對應調整點。
- **型別一致**:service 回傳 `{session_id, url, room_id}` 與前端讀 `data.session_id`/`data.url` 一致;`_neko`、`NekoRoomsError`、`LABEL_MANAGED`、`LABEL_SESSION`、`_wait_for_port` 在 service 定義且測試以 `svc.*` 引用一致;client 方法 `create_room/get_room/delete_room/list_rooms/wait_ready` 與 service 呼叫一致。

## 上游源碼驗證紀錄(2026-07-02 二次 review)

對 `m1k1o/neko-rooms@master` 與 `m1k1o/neko@master` 逐檔確認:

- `internal/api/rooms.go`:`POST /api/rooms`(`start` 預設即 true)回完整 RoomEntry;`DELETE` 回 204;`GET /api/rooms?<label>=<value>` 支援過濾,label key 限 `[a-z0-9.-]`(`telepy.managed` / `telepy.session-id` 合法)。
- `internal/room/labels.go` + `containers.go`:user label 存到容器時加 `m1k1o.neko_rooms.x-` 前綴,list 過濾與回傳的 `labels` 都自動處理前綴 → 對帳設計可行;`is_ready` = ready 事件或 container healthy。
- `internal/room/manager.go`:mux 時每房固定配 1 埠(UDP+TCP 同號);`api_version==0` 會走 image 偵測且可能 fallback v2(→ 顯式送 3);`TRAEFIK_DOMAIN=*` 產生 `HostRegexp(`{host:.+}`)` v2 語法(→ 棄用 docker provider 路線);`INSTANCE_NETWORK` 需為實際網路名。
- `internal/types/room_api_v3.go`:user `envs` 原樣進容器(`PROXY_SERVER` 不在黑名單);`user_pass`/`admin_pass` → `NEKO_MEMBER_MULTIUSER_*`;mux → `NEKO_WEBRTC_UDPMUX/TCPMUX`;`video_codec` 不送會產生空 env(→ 顯式送 VP8/OPUS)。
- `internal/server/manager.go` + `internal/proxy/manager.go`:traefik disabled 時房間掛 `m1k1o.neko_rooms.proxy.*` label,server 以 `/*` fallback 反代房間(StripPrefix 自理、`httputil.ReverseProxy` 支援 WS、含等待頁);`/api` 與 admin 靜態檔為獨立路由,不經 `/neko` 前綴無法觸及。
- `neko/apps/chromium/supervisord.conf`:官方檔含 `[program:chromium]` + `[program:openbox]` 兩段(→ 覆寫檔補回 openbox)。
- `internal/config/room.go`:`NEKO_ROOMS_NAT1TO1=""` 經 viper `GetStringSlice` 為空 slice,安全;env 命名 `NEKO_ROOMS_*` 對應 viper key 無誤。

## 實作後強化(獨立 review 後追加,非阻斷項)

實作完成後另跑一次獨立 code review,無 BUG 級問題;針對兩個低風險項追加強化(已含在 `harden(neko): ...` commit):

- **backend `depends_on: neko-rooms`**:讓首次開機順序確定;即使 neko-rooms 尚未 ready,`create_room` 也只會丟 `NekoRoomsError` 並回收 ssh(可重試),不會 crash。
- **對帳範圍收斂到 `PROJECT_NAME`**:房間多打一個 `telepy.instance=<PROJECT_NAME>` label,`_reconcile_orphan_rooms` 以 `{telepy.managed, telepy.instance}` 過濾 —— 未來多套 stack 若共用同一台 neko-rooms,也不會互刪對方的活躍房間。(service 端常數 `LABEL_INSTANCE` / `INSTANCE`。)
