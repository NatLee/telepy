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
        help_text="是否開放新帳號自行註冊。關閉時只有管理員能建立帳號。",
    )

    # ── 遠端瀏覽器 / Remote Browser ──────────────────────────────────
    # 這一組控制 KasmVNC 代理瀏覽器(見 docs/remote-browser.md)。
    remote_browser_session_idle_timeout = models.IntegerField(
        default=60,
        verbose_name="Remote Browser Session Idle Timeout (seconds)",
        help_text="閒置多久沒有心跳就回收該瀏覽器 session(秒)。VNC WebSocket 連著時伺服器會每 20 秒"
                  "自動續命,所以只有真的沒人連的 session 才會在這個時間後被收。",
    )

    remote_browser_max_sessions = models.IntegerField(
        default=10,
        verbose_name="Remote Browser Max Concurrent Sessions",
        help_text="同時可存在的代理瀏覽器 session 數上限。達到上限時新的「開啟瀏覽器」會被拒絕。"
                  "設 0 = 不限制。",
    )

    remote_browser_geometry = models.CharField(
        max_length=32,
        default="1280x720",
        verbose_name="Remote Browser Screen Geometry",
        help_text="每個代理瀏覽器桌面的解析度(寬x高,例如 1280x720)。",
    )

    remote_browser_ssh_timeout = models.IntegerField(
        default=30,
        verbose_name="Remote Browser SSH Proxy Timeout (seconds)",
        help_text="開啟瀏覽器時,等待『ssh -D SOCKS 代理』把本地埠拉起來的逾時(秒)。兩跳連線"
                  "(經 telepy-ssh 到裝置)冷啟較久,太短會誤判裝置離線。",
    )

    remote_browser_ssh_attempts = models.IntegerField(
        default=2,
        verbose_name="Remote Browser SSH Proxy Attempts",
        help_text="SOCKS 代理起不來時的重試次數(含第一次)。第一次連線是冷的常較慢,第二次因連線"
                  "已暖通常會成功;真的離線的裝置會很快失敗、不會空等。建議 ≥ 2。",
    )

    remote_browser_homepage = models.CharField(
        max_length=512,
        default="https://www.google.com",
        verbose_name="Remote Browser Homepage",
        help_text="代理瀏覽器啟動時開啟的首頁網址。",
    )

    remote_browser_language = models.CharField(
        max_length=16,
        default="zh-TW",
        verbose_name="Remote Browser Language",
        help_text="代理瀏覽器的介面語系與 Accept-Language(例如 zh-TW、en-US)。也影響反爬蟲的"
                  "navigator.languages(空語系是機器人特徵)。",
    )

    @classmethod
    def get_solo(cls):
        # 只保留單一列;不存在就建立(pk=1)。/ Keep exactly one row; create it (pk=1) if missing.
        obj, _created = cls.objects.get_or_create(pk=1)
        return obj
