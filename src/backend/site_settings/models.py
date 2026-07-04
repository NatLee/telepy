from django.db import models


class SiteSettings(models.Model):
    """
    全站設定(單一列,pk=1,由 get_solo() 取得)。所有欄位都要寫 help_text 說明「這是做什麼的」,
    因為它們會直接顯示在 Django admin 與設定 API 上。
    Site-wide settings (single row, pk=1). Every field carries a help_text — it shows in the admin/API.
    """

    # ── 帳號 / Account ────────────────────────────────────────────────
    allow_registration = models.BooleanField(
        default=False,
        verbose_name="Allow registration",
        help_text="是否開放新帳號自行註冊。關閉時只有管理員能建立帳號。變更後立即生效。",
    )

    valid_register_domains = models.CharField(
        max_length=512,
        default="gmail.com",
        verbose_name="Allowed Registration Email Domains",
        help_text="允許用 Google 登入自行註冊的 email 網域白名單,用逗號分隔(例如 gmail.com,mycorp.com)。"
                  "只有這些網域的 Google 帳號能註冊。留空則沿用系統預設。變更後立即生效。",
    )

    # ── 遠端瀏覽器 / Remote Browser ──────────────────────────────────
    # 這一組控制 KasmVNC 代理瀏覽器(見 docs/remote-browser.md)。所有值都是**每次開新 session 時
    # 即時從這裡讀取**,所以改了之後「下次開啟瀏覽器」就套用(已經開著的 session 不受影響)。
    remote_browser_session_idle_timeout = models.IntegerField(
        default=60,
        verbose_name="Remote Browser Session Idle Timeout (seconds)",
        help_text="閒置多久沒有心跳就自動關閉並回收該瀏覽器 session(秒),避免沒人用的 session 一直"
                  "占用資源與目標機連線。你開著瀏覽器分頁時,伺服器每 20 秒會自動續命,所以正常使用"
                  "不會被關;只有分頁關掉/斷線後才開始倒數。變更後即時生效。",
    )

    remote_browser_max_sessions = models.IntegerField(
        default=10,
        verbose_name="Remote Browser Max Concurrent Sessions",
        help_text="同時可存在的代理瀏覽器 session 數上限,用來控管資源。達到上限時,新的「開啟瀏覽器」"
                  "會被拒絕並提示稍後再試。設 0 = 不限制。下次開啟瀏覽器時生效。",
    )

    remote_browser_geometry = models.CharField(
        max_length=32,
        default="1280x720",
        verbose_name="Remote Browser Screen Geometry",
        help_text="每個代理瀏覽器桌面的解析度,格式「寬x高」(例如 1280x720、1920x1080)。下次開啟"
                  "瀏覽器時生效。",
    )

    remote_browser_ssh_timeout = models.IntegerField(
        default=30,
        verbose_name="Remote Browser SSH Proxy Timeout (seconds)",
        help_text="開啟瀏覽器時,等待『ssh -D SOCKS 代理』把本地埠拉起來的逾時(秒)。此連線經 telepy-ssh"
                  "兩跳到目標裝置,冷啟較久;太短會把「還在連」誤判成裝置離線。下次開啟瀏覽器時生效。",
    )

    remote_browser_ssh_attempts = models.IntegerField(
        default=2,
        verbose_name="Remote Browser SSH Proxy Attempts",
        help_text="SOCKS 代理起不來時的重試次數(含第一次)。第一次連線是冷的常較慢,第二次因連線已暖"
                  "通常就會成功;真的離線的裝置會很快失敗、不會空等。建議 ≥ 2。下次開啟瀏覽器時生效。",
    )

    remote_browser_kasm_create_timeout = models.IntegerField(
        default=30,
        verbose_name="Remote Browser Startup Timeout (seconds)",
        help_text="開啟瀏覽器時,等待瀏覽器容器把桌面(Xkasmvnc)與 chromium 起好的逾時(秒)。冷啟或"
                  "機器忙碌時較久,太短會讓開啟失敗;太長則卡住較久才報錯。下次開啟瀏覽器時生效。",
    )

    remote_browser_homepage = models.CharField(
        max_length=512,
        default="https://www.google.com",
        verbose_name="Remote Browser Homepage",
        help_text="代理瀏覽器啟動時自動開啟的首頁網址(需含 http:// 或 https://)。下次開啟瀏覽器時生效。",
    )

    remote_browser_language = models.CharField(
        max_length=16,
        default="zh-TW",
        verbose_name="Remote Browser Language",
        help_text="代理瀏覽器的介面語系與 Accept-Language,格式如 zh-TW、en-US、ja-JP。也影響反爬蟲的"
                  "navigator.languages(空語系是機器人特徵)。下次開啟瀏覽器時生效。",
    )

    @classmethod
    def get_solo(cls):
        # 只保留單一列;不存在就建立(pk=1)。/ Keep exactly one row; create it (pk=1) if missing.
        obj, _created = cls.objects.get_or_create(pk=1)
        return obj
