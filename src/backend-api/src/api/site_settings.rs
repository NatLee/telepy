//! `/api/site/settings`（site_settings app）：`{"values": {...}, "meta": {...}}`。
//! meta 的 label/description 直接取自 Django model 的 verbose_name/help_text（前端以字典優先、meta 退回）。

use axum::http::HeaderMap;
use axum::extract::State;
use axum::Json;
use serde_json::{json, Map, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, settings::{SettingValue, SiteSettings, FIELDS}};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(get_settings, update_settings))
}

#[derive(Clone, Copy)]
enum Kind {
    Bool,
    Int,
    Str(usize),
    /// 可以空白（= 關閉）；有值就必須是 http(s) 網址。/ May be blank (= off); otherwise an http(s) URL.
    Url(usize),
    /// 可以空白的短文字（`signin_page_message`）。/ Short text that may be blank.
    Text(usize),
    /// 逗號分隔的 email 網域清單，可以空白（= 系統預設）。/ Comma-separated email domains; may be blank (= the system default).
    Domains(usize),
    /// 可以空白的字串（空白 = 沒設 / 預設）。/ A string that may be blank (= unset / the default).
    Opt(usize),
    /// 固定幾個值之一。/ One of a fixed set of values.
    Choice(&'static [&'static str]),
}

struct FieldMeta {
    name: &'static str,
    kind: Kind,
    label: &'static str,
    description: &'static str,
}

const META: &[FieldMeta] = &[
    FieldMeta { name: "allow_registration", kind: Kind::Bool, label: "Allow registration", description: "是否開放新帳號自行註冊。關閉時只有管理員能建立帳號。變更後立即生效。" },
    FieldMeta { name: "valid_register_domains", kind: Kind::Domains(512), label: "Allowed Registration Email Domains", description: "允許用 Google 登入的 email 網域白名單,用逗號分隔(例如 gmail.com,mycorp.com);網域須完全相符,子網域要另外列出。只有這些網域的 Google 帳號能登入或註冊。留空則使用系統預設 gmail.com。變更後立即生效。" },
    FieldMeta { name: "remote_browser_session_idle_timeout", kind: Kind::Int, label: "Remote Browser Session Idle Timeout (seconds)", description: "閒置多久沒有心跳就自動關閉並回收該瀏覽器 session(秒),避免沒人用的 session 一直占用資源與目標機連線。你開著瀏覽器分頁時,伺服器每 20 秒會自動續命,所以正常使用不會被關;只有分頁關掉/斷線後才開始倒數。變更後即時生效。" },
    FieldMeta { name: "remote_browser_max_sessions", kind: Kind::Int, label: "Remote Browser Max Concurrent Sessions", description: "同時可存在的代理瀏覽器 session 數上限,用來控管資源。達到上限時,新的「開啟瀏覽器」會被拒絕並提示稍後再試。設 0 = 不限制。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_geometry", kind: Kind::Str(32), label: "Remote Browser Screen Geometry", description: "每個代理瀏覽器桌面的解析度,格式「寬x高」(例如 1280x720、1920x1080)。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_ssh_timeout", kind: Kind::Int, label: "Remote Browser SSH Proxy Timeout (seconds)", description: "開啟瀏覽器時,等待『ssh -D SOCKS 代理』把本地埠拉起來的逾時(秒)。此連線經 telepy-ssh兩跳到目標裝置,冷啟較久;太短會把「還在連」誤判成裝置離線。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_ssh_attempts", kind: Kind::Int, label: "Remote Browser SSH Proxy Attempts", description: "SOCKS 代理起不來時的重試次數(含第一次)。第一次連線是冷的常較慢,第二次因連線已暖通常就會成功;真的離線的裝置會很快失敗、不會空等。建議 ≥ 2。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_kasm_create_timeout", kind: Kind::Int, label: "Remote Browser Startup Timeout (seconds)", description: "開啟瀏覽器時,等待瀏覽器容器把桌面(Xkasmvnc)與 chromium 起好的逾時(秒)。冷啟或機器忙碌時較久,太短會讓開啟失敗;太長則卡住較久才報錯。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_homepage", kind: Kind::Str(512), label: "Remote Browser Homepage", description: "代理瀏覽器啟動時自動開啟的首頁網址(需含 http:// 或 https://)。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "remote_browser_language", kind: Kind::Str(16), label: "Remote Browser Language", description: "代理瀏覽器的介面語系與 Accept-Language,格式如 zh-TW、en-US、ja-JP。也影響反爬蟲的navigator.languages(空語系是機器人特徵)。下次開啟瀏覽器時生效。" },
    FieldMeta { name: "ai_session_idle_timeout", kind: Kind::Int, label: "AI Session Idle Timeout (seconds)", description: "AI 工具（MCP）開的 SSH session 閒置多久沒有指令就自動關閉(秒)。執行中的指令不算閒置。變更後對新開的 session 生效。" },
    FieldMeta { name: "ai_session_max_lifetime", kind: Kind::Int, label: "AI Session Max Lifetime (seconds)", description: "AI 工具開的 SSH session 最長存活時間(秒),到期一律關閉(包含正在執行的指令)。變更後對新開的 session 生效。" },
    FieldMeta { name: "lan_scan_enabled", kind: Kind::Bool, label: "Allow LAN discovery", description: "允許通道擁有者與 ADMIN 分享者經由裝置掃描它所在的區網(只探測私有網段、由裝置的 sshd 發出連線,不在裝置上安裝任何東西)。關閉後只能手動新增跳板機。每次掃描都會記錄在該通道的 Logs。" },
    FieldMeta { name: "device_ip_lookup_url", kind: Kind::Url(512), label: "Device public IP lookup", description: "裝置的公網 IP 先問 Telepy 自己(/api/whoami);Telepy 看到的不是公網位址時(前面的代理或 Docker 把來源換掉了,或裝置跟 Telepy 在同一個 NAT 後面),裝置改問這個網址,它要用純文字回傳呼叫者的 IP(例如 https://api.ipify.org、https://ifconfig.me/ip)。每台裝置每次連上最多問一次、連著時每天一次。留空 = 不問第三方,看不到時只顯示內網 IP。" },
    FieldMeta { name: "notify_user_webhooks", kind: Kind::Bool, label: "Personal webhooks", description: "讓每個人在 Webhooks 頁設定自己的 webhook,收他在網頁上本來就會收到的通知(自己通道的狀態、分享、核准、登入…)。關閉後個人 webhook 全部暫停不送,管理員的全站 webhook 不受影響。" },
    FieldMeta { name: "notify_private_targets", kind: Kind::Bool, label: "Allow private network targets", description: "允許個人 webhook 連到內網、本機或雲端 metadata 這類位址(例如公司內部的 Mattermost)。伺服器會照使用者填的網址連線,開啟前請確認內網沒有不該被觸碰的服務。全站 webhook 一律允許。" },
    FieldMeta { name: "notify_max_webhooks", kind: Kind::Int, label: "Webhooks per person", description: "每個人最多可以建立幾個個人 webhook。0 到 100。" },
    FieldMeta { name: "user_key_max_days", kind: Kind::Int, label: "Personal key lifetime (days)", description: "個人 SSH 金鑰最長可以用幾天。設了之後,新增或續期的金鑰都必須在這個天數內到期(沒填就自動用最長效期);到期的金鑰會被 gateway 拒絕,並從裝置的 authorized_keys 移除。設 0 = 不限制。" },
    FieldMeta { name: "mfa_require_totp", kind: Kind::Bool, label: "Require an authenticator app", description: "要求每個帳號都設定驗證器 App(TOTP)。還沒設定的使用者登入後只能先完成設定,才能使用其他功能。開啟前你自己的帳號必須已經設定好。變更後立即生效。" },
    FieldMeta { name: "mfa_require_passkey", kind: Kind::Bool, label: "Require a passkey", description: "要求每個帳號都至少註冊一把 passkey。還沒註冊的使用者登入後只能先完成註冊,才能使用其他功能。passkey 需要以網域名稱(不是 IP)開啟網站。開啟前你自己的帳號必須已經有 passkey。變更後立即生效。" },
    FieldMeta { name: "recording_retention_days", kind: Kind::Int, label: "Keep terminal recordings (days)", description: "開了「錄下網頁終端機」的通道，錄影檔要留幾天；超過就連檔案一起刪掉（每小時清一次）。設 0 = 一直留。" },
    FieldMeta { name: "command_approval_timeout", kind: Kind::Int, label: "Command approval timeout (seconds)", description: "指令規則要求核准時，等 owner / ADMIN 多久(秒)；沒人回應就當作拒絕，終端機那一行被取消。核准後 agent 的同一個指令 10 分鐘內可以跑一次。" },
    FieldMeta { name: "terminal_detach_max_secs", kind: Kind::Int, label: "Keep detached terminals for at most (seconds)", description: "網頁終端機斷線(換網路、筆電睡著、重新整理)後,shell 最多留多久等同一個人接回來(秒)。每個人在偏好設定裡選自己要留多久(預設斷線就結束),實際用的是兩者較小的那個;通道也可以設成一律斷線就結束。設 0 = 關閉這個功能。0 到 86400。" },
    FieldMeta { name: "signin_lifetime", kind: Kind::Int, label: "Stay signed in for (seconds)", description: "網頁登入沒有任何造訪多久後要重新登入(秒)。只要有來,效期就從那時重新起算(分頁開著時瀏覽器會在背景自動續期),所以常用的人不會被登出;登出則立刻結束。300(5 分鐘)到 31536000(365 天)。" },
    FieldMeta { name: "signin_access_lifetime", kind: Kind::Int, label: "Access token lifetime (seconds)", description: "每顆短效 access token 的有效時間(秒);到期前瀏覽器會自動用登入 session 換一顆新的,使用者不會察覺。越短,外洩的 token 能用的時間越短。60(1 分鐘)到 86400(24 小時)。" },
    FieldMeta { name: "ai_max_sessions_per_user", kind: Kind::Int, label: "AI Sessions per User", description: "每位使用者同時可開的 AI SSH session 數上限(所有已授權的 app 合計)。設 0 = 不允許 AI 開 session。下次開 session 時生效。" },
    FieldMeta { name: "desktop_enabled", kind: Kind::Bool, label: "Allow remote desktop", description: "允許在網頁裡開裝置（或它區網裡主機）的 RDP / VNC 桌面。連線由裝置的 sshd 轉接到目標，經 guacd 轉成瀏覽器畫面；每個 session 都記錄在該通道的 Logs。關閉後不能再開新的 session，已開著的不受影響。" },
    FieldMeta { name: "desktop_max_sessions", kind: Kind::Int, label: "Remote Desktop Max Concurrent Sessions", description: "同時可開的遠端桌面 session 數上限（整站合計）。達到上限時新的連線會被拒絕並提示稍後再試。設 0 = 不限制。" },
    FieldMeta { name: "desktop_session_idle_timeout", kind: Kind::Int, label: "Remote Desktop Idle Timeout (seconds)", description: "遠端桌面多久沒有鍵盤 / 滑鼠 / 剪貼簿輸入就自動斷線(秒)。設 0 = 不自動斷線。變更後即時生效。" },
    FieldMeta { name: "desktop_clipboard", kind: Kind::Str(16), label: "Remote Desktop Clipboard Limit", description: "剪貼簿最多能開到哪個方向：both = 雙向、to_remote = 只能把文字貼進遠端、off = 關閉。每個人在桌面頁或偏好設定裡自己選方向，實際用的是兩者較窄的那個；RDP / VNC 由伺服器（guacd）把關，RustDesk 由瀏覽器裡的核心套用。下次開桌面時生效。" },
    FieldMeta { name: "desktop_max_resolution", kind: Kind::Int, label: "Remote Desktop Max Resolution", description: "Telepy 向遠端要的桌面大小上限（長邊，像素，640–16384）。瀏覽器視窗或選的固定大小比較大時，等比縮到這個值，畫面仍塞滿視窗、在瀏覽器裡放大。適用 RDP 與會跟著改大小的 VNC；其他 VNC 與 RustDesk 維持遠端自己的解析度。對新開的 session 生效。" },
    FieldMeta { name: "desktop_file_transfer", kind: Kind::Bool, label: "Remote Desktop File Transfer (RustDesk)", description: "允許在網頁內的 RustDesk 連線裡上傳 / 下載檔案（桌面頁的「檔案」面板）。關閉後面板不出現，中繼也會拒絕 RustDesk 的檔案傳輸登入。RDP / VNC 不經這裡傳檔。下次開面板時生效。" },
    FieldMeta { name: "signin_page_style", kind: Kind::Str(16), label: "Sign-in page look", description: "登入頁的樣子:standard = 產品介紹 + 連線示意圖;discreet = 只寫 Telepy 的低調畫面(動畫背景 + 一句話),不提遠端連線相關的任何字,路過的人只看得到一個叫 Telepy 的登入畫面。變更後立即生效。" },
    FieldMeta { name: "signin_oauth_style", kind: Kind::Str(16), label: "App connection sign-in page look", description: "MCP 應用程式要求連接、使用者還沒登入時看到的 OAuth 登入頁:standard = 連接流程與要求的權限;discreet = 同樣的低調畫面,只寫要連接的應用程式與會回到哪裡(權限仍會在登入後的同意頁列出)。變更後立即生效。" },
    FieldMeta { name: "signin_cli_style", kind: Kind::Str(16), label: "CLI sign-in page look", description: "在終端機打 telepy login、瀏覽器還沒登入時看到的那一頁:standard = 跟應用程式連接頁一樣的流程與權限;discreet = 同樣的低調畫面,只寫 telepy CLI 與它從哪台電腦登入(權限仍會在登入後的同意頁列出)。變更後立即生效。" },
    FieldMeta { name: "signin_consent_style", kind: Kind::Str(16), label: "Approval page look", description: "登入後允許 MCP 應用程式或 telepy login 的授權頁(/oauth/authorize):standard = 連接流程面板與步驟;discreet = 只寫 Telepy 的低調外框。兩種都列出應用程式、導回哪裡、權限與通道。telepy login 登入完成後顯示的那一頁也跟著它。變更後立即生效。" },
    FieldMeta { name: "client_ip_hops", kind: Kind::Str(8), label: "Trusted proxy hops", description: "How Telepy finds a visitor's address in X-Forwarded-For. auto = every internal address at the right end is a proxy (Traefik, a Nginx Proxy Manager in front) and the first public one is the visitor; a number from 0 to 10 = skip exactly that many entries from the right, Traefik included (1 = Traefik only, 2 = plus a TLS proxy or load balancer with a public address). Too high a number lets visitors choose their own address. Applies at once. TRUSTED_PROXY_HOPS in .env takes over." },
    FieldMeta { name: "client_ip_header", kind: Kind::Opt(64), label: "Client address header", description: "Take the visitor's address from this header instead (for example CF-Connecting-IP or X-Real-IP). Only set it when the proxy in front always overwrites the header, otherwise visitors can choose their own address. Blank = not used. Applies at once. CLIENT_IP_HEADER in .env takes over." },
    FieldMeta { name: "client_ip_cloudflare", kind: Kind::Choice(&crate::server_settings::Cloudflare::VALUES), label: "Cloudflare", description: "How Cloudflare's CF-Connecting-IP header is used. auto = only when the request reached Telepy from a Cloudflare address (nobody can fake that without going through Cloudflare); always = whenever the header is there (only when Cloudflare is always in front); off = ignored. Applies at once." },
    FieldMeta { name: "server_device_probe", kind: Kind::Bool, label: "Ask devices for their addresses", description: "Once per connection (and daily), log in to each connected device to read its host name, LAN addresses, public address and health facts. Off = no background logins; the lists then show only what the gateway sees. Applies from the next round (within 30 seconds). DEVICE_PROBE in .env takes over." },
    FieldMeta { name: "server_keep_shared_service_key", kind: Kind::Bool, label: "Keep the shared service key on devices", description: "Never remove the shared service key from devices, also not by hand. Turn it on while another Telepy server (an old one running in parallel) still logs in to the same devices with that key. Applies at once. KEEP_SHARED_SERVICE_KEY in .env takes over." },
    FieldMeta { name: "server_gateway_proxy_protocol_from", kind: Kind::Opt(512), label: "PROXY protocol from", description: "IP addresses or CIDRs of a TCP (L4) proxy in front of the SSH gateway that sends a PROXY protocol header, comma or space separated. Connections from these addresses may carry the header and their real source is used; nobody else is ever trusted. Blank = off. Applies to new connections. GATEWAY_PROXY_PROTOCOL_FROM in .env takes over." },
    FieldMeta { name: "server_log_level", kind: Kind::Opt(256), label: "Log level", description: "error, warn, info, debug or trace, or a full filter such as info,telepy_server=debug. Blank = info (debug when DEBUG=true). Applies at once. LOG_LEVEL in .env takes over." },
    FieldMeta { name: "server_openapi_enabled", kind: Kind::Bool, label: "API reference (Swagger)", description: "Serve the API reference page and /api/openapi.json to signed-in people. Off = both answer 404. Applies at once. OPENAPI_ENABLED in .env takes over." },
    FieldMeta { name: "server_google_client_id", kind: Kind::Opt(256), label: "Google client ID", description: "The OAuth client ID of Google sign-in: the sign-in button uses it and Google sign-ins are checked against it. Blank = no Google sign-in. Applies at once. SOCIAL_GOOGLE_CLIENT_ID in .env takes over." },
    FieldMeta { name: "server_public_url", kind: Kind::Url(512), label: "Public address", description: "The address people open Telepy at, like https://telepy.example.com (no path). Used for the OAuth issuer, links in scripts and webhooks, the passkey domain and devices' address lookups. Blank = taken from each request's X-Forwarded-* headers. Changing it makes passkeys registered under another domain stop working. Applies at once. PUBLIC_URL in .env takes over." },
    FieldMeta { name: "server_ssh_host", kind: Kind::Opt(253), label: "SSH host", description: "The name devices and laptops connect their SSH to (the gateway port). Blank = the same name as the web. Set it when the web name goes through a proxy that only carries web ports (Cloudflare, another CDN, an HTTP load balancer…): that name then cannot reach the SSH port, so give SSH a name that goes straight to this server. Only new scripts and SSH configs use it; installed devices keep the name they were set up with. SSH_SERVER_DOMAIN in .env takes over." },
    FieldMeta { name: "signin_page_message", kind: Kind::Text(SIGNIN_MESSAGE_MAX), label: "Discreet sign-in page lines", description: "低調登入頁在 Telepy 下面像打字一樣出現的句子,一行一句(最多 6 句、每句 80 字)。一句 = 打出來後留著;兩句以上 = 打出來、刪掉、換下一句輪流。留空 = 輪播內建的幾句問候語(會跟著訪客的語言)。登入前任何人都看得到,不要寫內部資訊。" },
];

fn values_json(s: &SiteSettings) -> Value {
    let mut m = Map::new();
    m.insert("allow_registration".into(), json!(s.allow_registration));
    m.insert("valid_register_domains".into(), json!(s.valid_register_domains));
    m.insert("remote_browser_session_idle_timeout".into(), json!(s.remote_browser_session_idle_timeout));
    m.insert("remote_browser_max_sessions".into(), json!(s.remote_browser_max_sessions));
    m.insert("remote_browser_geometry".into(), json!(s.remote_browser_geometry));
    m.insert("remote_browser_ssh_timeout".into(), json!(s.remote_browser_ssh_timeout));
    m.insert("remote_browser_ssh_attempts".into(), json!(s.remote_browser_ssh_attempts));
    m.insert("remote_browser_kasm_create_timeout".into(), json!(s.remote_browser_kasm_create_timeout));
    m.insert("remote_browser_homepage".into(), json!(s.remote_browser_homepage));
    m.insert("remote_browser_language".into(), json!(s.remote_browser_language));
    m.insert("ai_session_idle_timeout".into(), json!(s.ai_session_idle_timeout));
    m.insert("ai_session_max_lifetime".into(), json!(s.ai_session_max_lifetime));
    m.insert("ai_max_sessions_per_user".into(), json!(s.ai_max_sessions_per_user));
    m.insert("lan_scan_enabled".into(), json!(s.lan_scan_enabled));
    m.insert("device_ip_lookup_url".into(), json!(s.device_ip_lookup_url));
    m.insert("notify_user_webhooks".into(), json!(s.notify_user_webhooks));
    m.insert("notify_private_targets".into(), json!(s.notify_private_targets));
    m.insert("notify_max_webhooks".into(), json!(s.notify_max_webhooks));
    m.insert("user_key_max_days".into(), json!(s.user_key_max_days));
    m.insert("desktop_enabled".into(), json!(s.desktop_enabled));
    m.insert("desktop_max_sessions".into(), json!(s.desktop_max_sessions));
    m.insert("desktop_session_idle_timeout".into(), json!(s.desktop_session_idle_timeout));
    m.insert("desktop_clipboard".into(), json!(s.desktop_clipboard));
    m.insert("desktop_max_resolution".into(), json!(s.desktop_max_resolution));
    m.insert("desktop_file_transfer".into(), json!(s.desktop_file_transfer));
    m.insert("mfa_require_totp".into(), json!(s.mfa_require_totp));
    m.insert("mfa_require_passkey".into(), json!(s.mfa_require_passkey));
    m.insert("recording_retention_days".into(), json!(s.recording_retention_days));
    m.insert("command_approval_timeout".into(), json!(s.command_approval_timeout));
    m.insert("signin_lifetime".into(), json!(s.signin_lifetime));
    m.insert("signin_access_lifetime".into(), json!(s.signin_access_lifetime));
    m.insert("terminal_detach_max_secs".into(), json!(s.terminal_detach_max_secs));
    m.insert("signin_page_style".into(), json!(s.signin_page_style));
    m.insert("signin_oauth_style".into(), json!(s.signin_oauth_style));
    m.insert("signin_cli_style".into(), json!(s.signin_cli_style));
    m.insert("signin_consent_style".into(), json!(s.signin_consent_style));
    m.insert("signin_page_message".into(), json!(s.signin_page_message));
    m.insert("client_ip_hops".into(), json!(s.client_ip_hops));
    m.insert("client_ip_header".into(), json!(s.client_ip_header));
    m.insert("client_ip_cloudflare".into(), json!(s.client_ip_cloudflare));
    m.insert("server_device_probe".into(), json!(s.server_device_probe));
    m.insert("server_keep_shared_service_key".into(), json!(s.server_keep_shared_service_key));
    m.insert("server_gateway_proxy_protocol_from".into(), json!(s.server_gateway_proxy_protocol_from));
    m.insert("server_log_level".into(), json!(s.server_log_level));
    m.insert("server_openapi_enabled".into(), json!(s.server_openapi_enabled));
    m.insert("server_google_client_id".into(), json!(s.server_google_client_id));
    m.insert("server_public_url".into(), json!(s.server_public_url));
    m.insert("server_ssh_host".into(), json!(s.server_ssh_host));
    Value::Object(m)
}

fn meta_json() -> Value {
    let mut m = Map::new();
    for f in META {
        let kind = match f.kind {
            Kind::Bool => "boolean",
            Kind::Int => "integer",
            Kind::Str(_) => "string",
            Kind::Url(_) => "url",
            Kind::Text(_) => "text",
            Kind::Domains(_) => "string",
            Kind::Opt(_) => "string",
            Kind::Choice(_) => "choice",
        };
        let mut entry = json!({ "label": f.label, "description": f.description, "type": kind });
        if let Kind::Choice(choices) = f.kind {
            entry["choices"] = json!(choices);
        }
        m.insert(f.name.into(), entry);
    }
    Value::Object(m)
}

#[utoipa::path(get, path = "/api/site/settings", tag = "Site Settings", security(("bearer" = [])), responses((status = 200, description = "values + meta; empty objects for non-admins", body = super::schemas::SiteSettingsResponse)))]
async fn get_settings(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Ok(Json(json!({ "values": {}, "meta": {} })));
    }
    let s = db::settings::get_solo(&state.db).await?;
    Ok(Json(json!({ "values": values_json(&s), "meta": meta_json(), "env": state.config.env_json() })))
}

/// DRF 欄位驗證（BooleanField / IntegerField / CharField max_length、不可空白）。
fn parse_value(f: &FieldMeta, v: &Value) -> Result<SettingValue, ApiError> {
    match f.kind {
        Kind::Bool => match v {
            Value::Bool(b) => Ok(SettingValue::Bool(*b)),
            Value::String(s) if matches!(s.to_ascii_lowercase().as_str(), "true" | "1" | "yes" | "on") => Ok(SettingValue::Bool(true)),
            Value::String(s) if matches!(s.to_ascii_lowercase().as_str(), "false" | "0" | "no" | "off") => Ok(SettingValue::Bool(false)),
            Value::Number(n) if n.as_i64() == Some(1) => Ok(SettingValue::Bool(true)),
            Value::Number(n) if n.as_i64() == Some(0) => Ok(SettingValue::Bool(false)),
            _ => Err(ApiError::field(f.name, "Must be a valid boolean.")),
        },
        Kind::Int => match v {
            Value::Number(n) => n.as_i64().ok_or_else(|| ApiError::field(f.name, "A valid integer is required.")).map(SettingValue::Int),
            Value::String(s) => s.trim().parse::<i64>().map(SettingValue::Int).map_err(|_| ApiError::field(f.name, "A valid integer is required.")),
            _ => Err(ApiError::field(f.name, "A valid integer is required.")),
        },
        Kind::Str(max) => match v {
            Value::String(s) if s.is_empty() => Err(ApiError::field(f.name, "This field may not be blank.")),
            Value::String(s) if s.chars().count() > max => Err(ApiError::field(f.name, format!("Ensure this field has no more than {max} characters."))),
            Value::String(s) => Ok(SettingValue::Str(s.clone())),
            Value::Null => Err(ApiError::field(f.name, "This field may not be null.")),
            other => Ok(SettingValue::Str(other.to_string())),
        },
        Kind::Url(max) => match v {
            Value::String(s) if s.trim().is_empty() => Ok(SettingValue::Str(String::new())),
            Value::String(s) if s.chars().count() > max => Err(ApiError::field(f.name, format!("Ensure this field has no more than {max} characters."))),
            Value::String(s) => match reqwest::Url::parse(s.trim()) {
                Ok(u) if matches!(u.scheme(), "http" | "https") && u.host_str().is_some() => Ok(SettingValue::Str(s.trim().to_string())),
                _ => Err(ApiError::field(f.name, "Enter a valid http:// or https:// URL, or leave it blank.")),
            },
            _ => Err(ApiError::field(f.name, "Enter a valid http:// or https:// URL, or leave it blank.")),
        },
        Kind::Text(max) => match v {
            Value::String(s) => normalize_text(s, max).map(SettingValue::Str).map_err(|msg| ApiError::field(f.name, msg)),
            Value::Null => Ok(SettingValue::Str(String::new())),
            _ => Err(ApiError::field(f.name, "Not a valid string.")),
        },
        Kind::Domains(max) => match v {
            Value::String(s) => normalize_domains(s, max).map(SettingValue::Str).map_err(|msg| ApiError::field(f.name, msg)),
            Value::Null => Ok(SettingValue::Str(String::new())),
            _ => Err(ApiError::field(f.name, "Not a valid string.")),
        },
        Kind::Opt(max) => match v {
            Value::String(s) if s.trim().chars().count() > max => Err(ApiError::field(f.name, format!("Ensure this field has no more than {max} characters."))),
            Value::String(s) => Ok(SettingValue::Str(s.trim().to_string())),
            Value::Null => Ok(SettingValue::Str(String::new())),
            _ => Err(ApiError::field(f.name, "Not a valid string.")),
        },
        Kind::Choice(choices) => match v {
            Value::String(s) if choices.contains(&s.trim().to_ascii_lowercase().as_str()) => Ok(SettingValue::Str(s.trim().to_ascii_lowercase())),
            _ => Err(ApiError::field(f.name, format!("Must be one of: {}.", choices.join(", ")))),
        },
    }
}

/**
 * 一個 email 網域：小寫、去掉前面的 `@` 或整個信箱的使用者部分、結尾的 `.`；要是合法的主機名稱（ASCII、至少兩段、
 * 每段 1–63 字、不以 `-` 開頭或結尾、最後一段不是純數字）。不支援萬用字元，子網域要另外列出。與前端 `lib/registerDomains.ts` 一致。
 * One email domain: lower-cased, a leading `@` or a whole address's local part and a trailing `.` removed; must be a valid
 * hostname (ASCII, at least two labels, 1–63 characters each, no leading / trailing `-`, last label not all digits). No
 * wildcards: subdomains are listed separately. Mirrors `lib/registerDomains.ts`.
 */
pub fn normalize_domain(raw: &str) -> Result<String, String> {
    let mut d = raw.trim();
    if let Some((_, after)) = d.rsplit_once('@') {
        d = after;
    }
    let d = d.trim().trim_end_matches('.').to_ascii_lowercase();
    if d.is_empty() {
        return Err("is empty".into());
    }
    if d.contains('*') {
        return Err("wildcards are not supported; list each subdomain".into());
    }
    if !d.is_ascii() {
        return Err("use the ASCII (xn--) form of the domain".into());
    }
    if d.len() > 253 {
        return Err("is longer than 253 characters".into());
    }
    if !d.contains('.') {
        return Err("needs a dot, like example.com".into());
    }
    for label in d.split('.') {
        if label.is_empty() {
            return Err("has an empty part between dots".into());
        }
        if label.len() > 63 {
            return Err("has a part longer than 63 characters".into());
        }
        if !label.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-') {
            return Err("may only contain letters, digits, hyphens and dots".into());
        }
        if label.starts_with('-') || label.ends_with('-') {
            return Err("has a part that starts or ends with a hyphen".into());
        }
    }
    if d.rsplit('.').next().is_some_and(|tld| tld.bytes().all(|b| b.is_ascii_digit())) {
        return Err("must end in a name, not a number".into());
    }
    Ok(d)
}

/**
 * 網域清單：以逗號、分號或空白分開，逐一正規化、去重（保留順序），用逗號接起來；空白 = 沿用系統預設。
 * 第一個壞掉的值會被點名。接起來的長度不可超過 `max`。
 * A domain list: split on commas, semicolons or whitespace, each normalised and de-duplicated (order kept), joined with
 * commas; blank = the system default. The first bad value is named. The joined text may not exceed `max`.
 */
pub fn normalize_domains(raw: &str, max: usize) -> Result<String, String> {
    let mut out: Vec<String> = Vec::new();
    for part in raw.split(|c: char| c == ',' || c == ';' || c.is_whitespace()).filter(|p| !p.is_empty()) {
        let d = normalize_domain(part).map_err(|why| format!("\"{part}\" {why}."))?;
        if !out.contains(&d) {
            out.push(d);
        }
    }
    let joined = out.join(",");
    if joined.chars().count() > max {
        return Err(format!("Ensure this field has no more than {max} characters."));
    }
    Ok(joined)
}

/// 登入頁的兩種樣子。/ The two sign-in page looks.
pub const SIGNIN_STYLES: [&str; 2] = ["standard", "discreet"];
/// 低調登入頁的句子：一行一句，最多幾句、每句幾個字。/ The discreet page's lines: how many, and characters per line.
const SIGNIN_MESSAGE_LINES: usize = 6;
const SIGNIN_LINE_MAX: usize = 80;
/// 整段的上限（六句各 80 字加換行，永遠不會比逐行的限制先碰到）。/ The whole text (never reached before the per-line limits).
pub const SIGNIN_MESSAGE_MAX: usize = SIGNIN_MESSAGE_LINES * (SIGNIN_LINE_MAX + 1);

/**
 * 低調登入頁的句子（一行一句，輪流打出來）：換行統一成 `\n`、每句去頭尾空白、空行拿掉；超過句數、某句太長、
 * 整段太長或有其他控制字元就拒絕。與前端 `lib/signinLook.ts` 的 `joinLines` / `messageProblem` 一致。
 * The discreet page's lines (one per line, typed in turn): newlines normalised to `\n`, each line trimmed, blank
 * lines dropped; too many lines, a line or the whole text too long, or other control characters are refused.
 * Mirrors `joinLines` / `messageProblem` in the frontend's `lib/signinLook.ts`.
 */
fn normalize_text(raw: &str, max: usize) -> Result<String, String> {
    let lines: Vec<&str> = raw.split('\n').map(|l| l.trim_end_matches('\r').trim()).filter(|l| !l.is_empty()).collect();
    let text = lines.join("\n");
    if text.chars().any(|c| c.is_control() && c != '\n') {
        return Err("Use plain text without control characters.".into());
    }
    if lines.len() > SIGNIN_MESSAGE_LINES {
        return Err(format!("Use at most {SIGNIN_MESSAGE_LINES} lines."));
    }
    if lines.iter().any(|l| l.chars().count() > SIGNIN_LINE_MAX) {
        return Err(format!("Keep each line to {SIGNIN_LINE_MAX} characters or fewer."));
    }
    if text.chars().count() > max {
        return Err(format!("Ensure this field has no more than {max} characters."));
    }
    Ok(text)
}

#[utoipa::path(post, path = "/api/site/settings", tag = "Site Settings", security(("bearer" = [])), request_body(content = Object, description = "Partial update: {field: value, …} using the keys of `values`"), responses((status = 200, body = super::schemas::SiteSettingsResponse), (status = 400, description = "{field: [message]}", body = Object), (status = 403, body = super::schemas::ErrorBody)))]
async fn update_settings(State(state): State<AppState>, AuthUser(me): AuthUser, headers: HeaderMap, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    if !me.is_superuser {
        return Err(ApiError::forbidden("Permission denied. Only administrators can modify system settings."));
    }
    let mut updates = Vec::new();
    for f in META {
        if let Some(v) = body.get(f.name) {
            // SSH 主機不能是你現在看網頁用的名稱（PUBLIC_URL 另有其名時）：那個名稱的登入會被擋，等於把自己鎖在外面。
            // The SSH host must not be the name you are using the web at right now (when PUBLIC_URL names another):
            // sign-ins through it would be refused, locking you out.
            if f.name == "server_ssh_host" {
                let wanted = v.as_str().map(crate::ssh_host::strip_port).unwrap_or_default();
                let web = crate::ssh_host::web_host(state.config.public_base().as_deref());
                let here = crate::ssh_host::request_host(&headers);
                if !wanted.is_empty() && web.as_deref().is_some_and(|w| w != wanted) && here.as_deref() == Some(wanted.as_str()) {
                    return Err(ApiError::field(f.name, format!("That is the name you are using the web at right now; sign-ins through it would be refused. The web address is {} — open Telepy there to set this, or change the public address first.", web.unwrap_or_default())));
                }
            }
            // 環境變數有設的鍵鎖住：它說了算，存了也不會生效。/ A key whose variable is set is locked: it wins anyway.
            if let (Some(var), Some(_)) = (crate::server_settings::env_var(f.name), state.config.env_value(f.name)) {
                return Err(ApiError::field(f.name, crate::server_settings::locked_message(var)));
            }
            let value = normalize(f.name, parse_value(f, v)?)?;
            validate(f.name, &value)?;
            updates.push((f.name, value));
        }
    }
    // 開啟「必須有 TOTP / passkey」前，管理員自己要先有，否則會把自己鎖在設定畫面外（關閉永遠可以）。
    // Turning a requirement on needs that factor on the admin's own account first; turning it off is always allowed.
    let current = db::settings::get_solo(&state.db).await?;
    let turning_on = |name: &str, was: bool| !was && updates.iter().any(|(n, v)| *n == name && matches!(v, SettingValue::Bool(true)));
    let need_totp = turning_on("mfa_require_totp", current.mfa_require_totp);
    let need_passkey = turning_on("mfa_require_passkey", current.mfa_require_passkey);
    if need_totp || need_passkey {
        let mine = super::mfa::factors(&state, me.id).await?;
        if need_totp && !mine.totp {
            return Err(ApiError::field("mfa_require_totp", "Set up an authenticator app on your own account first."));
        }
        if need_passkey && mine.passkeys == 0 {
            return Err(ApiError::field("mfa_require_passkey", "Register a passkey on your own account first."));
        }
    }
    let touches_mfa = updates.iter().any(|(n, _)| n.starts_with("mfa_require_"));
    for (name, value) in updates {
        debug_assert!(FIELDS.contains(&name));
        db::settings::update_field(&state.db, name, value).await?;
    }
    if touches_mfa {
        state.mfa.requirement.invalidate_all();
    }
    state.webhooks.invalidate();
    // 伺服器設定的記憶體快照（log 等級也在這裡換）。/ The server settings snapshot (the log level switches here too).
    state.config.reload_saved(&state.db).await?;
    let s = db::settings::get_solo(&state.db).await?;
    Ok(Json(json!({ "values": values_json(&s), "meta": meta_json(), "env": state.config.env_json() })))
}

/// 伺服器設定存檔前的整理與檢查（`server_settings` 的純函式）。/ Server settings, normalised and checked before saving.
fn normalize(name: &str, value: SettingValue) -> Result<SettingValue, ApiError> {
    use crate::server_settings as ss;
    let SettingValue::Str(s) = &value else { return Ok(value) };
    let checked = match name {
        "client_ip_hops" => ss::check_hops(s),
        "client_ip_header" => ss::check_header_name(s),
        "server_gateway_proxy_protocol_from" => ss::check_cidr_list(s),
        "server_log_level" => ss::check_log_level(s),
        "server_google_client_id" => ss::check_google_client_id(s),
        "server_public_url" => ss::check_public_url(s),
        "server_ssh_host" => ss::check_ssh_host(s),
        _ => return Ok(value),
    };
    checked.map(SettingValue::Str).map_err(|msg| ApiError::field(name, msg))
}

/// 個別欄位的值域（型別檢查之外）。/ Per-field value constraints beyond the type check.
fn validate(name: &str, value: &SettingValue) -> Result<(), ApiError> {
    match (name, value) {
        ("desktop_clipboard", SettingValue::Str(s)) if !crate::desktop::Clipboard::VALUES.contains(&s.as_str()) => {
            Err(ApiError::field(name, format!("Must be one of: {}.", crate::desktop::Clipboard::VALUES.join(", "))))
        }
        ("signin_page_style" | "signin_oauth_style" | "signin_cli_style" | "signin_consent_style", SettingValue::Str(s)) if !SIGNIN_STYLES.contains(&s.as_str()) => {
            Err(ApiError::field(name, format!("Must be one of: {}.", SIGNIN_STYLES.join(", "))))
        }
        ("desktop_max_resolution", SettingValue::Int(n)) if !(640..=16384).contains(n) => Err(ApiError::field(name, "Must be between 640 and 16384.")),
        ("desktop_max_sessions" | "desktop_session_idle_timeout", SettingValue::Int(n)) if *n < 0 => Err(ApiError::field(name, "Must be 0 or more.")),
        // 網址會放進裝置上的 shell 指令。/ The URL goes into a shell command on the device.
        ("device_ip_lookup_url", SettingValue::Str(s)) if !s.is_empty() && !crate::device_info::safe_url(s) => {
            Err(ApiError::field(name, "Use only letters, digits and . - _ : / ? = & in the address."))
        }
        ("notify_max_webhooks", SettingValue::Int(n)) if !(0..=100).contains(n) => Err(ApiError::field(name, "Must be between 0 and 100.")),
        ("command_approval_timeout", SettingValue::Int(n)) if !(30..=86_400).contains(n) => Err(ApiError::field(name, "Must be between 30 and 86400 seconds.")),
        ("terminal_detach_max_secs", SettingValue::Int(n)) if !crate::terminal_detach::SITE_MAX_RANGE.contains(n) => Err(ApiError::field(name, "Must be between 0 and 86400 seconds.")),
        ("signin_lifetime", SettingValue::Int(n)) if !crate::auth::sessions::SIGNIN_LIFETIME_RANGE.contains(n) => {
            Err(ApiError::field(name, "Must be between 300 seconds (5 minutes) and 31536000 seconds (365 days)."))
        }
        ("signin_access_lifetime", SettingValue::Int(n)) if !crate::auth::sessions::ACCESS_LIFETIME_RANGE.contains(n) => {
            Err(ApiError::field(name, "Must be between 60 seconds (1 minute) and 86400 seconds (24 hours)."))
        }
        _ => Ok(()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn domains_are_normalised_and_deduplicated() {
        assert_eq!(normalize_domains(" Gmail.com, @MyCorp.com ;alice@mycorp.com  sub.mycorp.com. ", 512).unwrap(), "gmail.com,mycorp.com,sub.mycorp.com");
        assert_eq!(normalize_domains("", 512).unwrap(), "", "blank = the system default");
        assert_eq!(normalize_domains(" , ,", 512).unwrap(), "");
        assert_eq!(normalize_domains("xn--fiqs8s.cn", 512).unwrap(), "xn--fiqs8s.cn");
    }

    #[test]
    fn bad_domains_are_named() {
        for bad in ["localhost", "*.mycorp.com", "a..com", "-a.com", "a-.com", "exa_mple.com", "1.2.3.4", "公司.tw", "mycorp.123"] {
            let e = normalize_domains(&format!("gmail.com,{bad}"), 512);
            assert!(e.is_err(), "{bad} should be refused");
            assert!(e.unwrap_err().contains(bad), "the message names {bad}");
        }
        assert!(normalize_domains("my corp@.com", 512).is_err(), "split on the space: `my` has no dot");
        assert!(normalize_domains(&format!("{}.com", "a".repeat(64)), 512).is_err(), "label over 63");
        assert!(normalize_domains(&format!("{}.com", "a".repeat(250)), 512).is_err(), "domain over 253");
    }

    #[test]
    fn domains_respect_the_length_limit() {
        let many: Vec<String> = (0..60).map(|i| format!("d{i:02}.example.com")).collect();
        let e = normalize_domains(&many.join(","), 512).unwrap_err();
        assert!(e.contains("512"));
        assert!(normalize_domains(&many[..20].join(","), 512).is_ok());
    }

    #[test]
    fn signin_lines_are_trimmed_and_limited() {
        let max = SIGNIN_MESSAGE_MAX;
        assert_eq!(normalize_text("  Hello \r\n\n   \n  world  \n", max).unwrap(), "Hello\nworld", "trimmed, blank lines dropped");
        assert_eq!(normalize_text("   \n \n", max).unwrap(), "", "blank = the built-in lines");
        assert!(normalize_text(&"字".repeat(80), max).is_ok(), "counted in characters, not bytes");
        assert_eq!(normalize_text(&"x".repeat(81), max).unwrap_err(), "Keep each line to 80 characters or fewer.");
        let six = vec!["a"; 6].join("\n");
        assert!(normalize_text(&six, max).is_ok());
        assert_eq!(normalize_text(&format!("{six}\nb"), max).unwrap_err(), "Use at most 6 lines.");
        assert!(normalize_text(&vec!["字".repeat(80); 6].join("\n"), max).is_ok(), "the whole-text cap never bites first");
        assert!(normalize_text("tab\there", max).is_err());
        assert!(normalize_text("bell\u{7}", max).is_err());
    }
}
