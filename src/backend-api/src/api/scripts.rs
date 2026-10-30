//! `/tunnels/server/config/*`、`/tunnels/server/script/*`：ssh config 與六種連線腳本、一次性 token。

use std::collections::{HashMap, HashSet};

use axum::extract::{Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::scripts::{self, ScriptContext, ALLOWED_SCRIPT_TYPES};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::tokens::ScriptTokenPayload;
use crate::util::{host_without_port, json_i64, json_str};

const CLIENT_STEM: &str = "\n# ========================================\n# Endpoint Configuration\n# ========================================\n";
const SERVER_STEM: &str = "# ========================================\n# Reverse Server Configuration\n# ========================================\n";

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(config))
        .routes(routes!(config_many))
        .routes(routes!(one_time_token))
        .routes(routes!(one_time_script))
        .routes(routes!(script))
}

/// Django 用 `HTTP_HOST`（去掉 port）當 server_domain，沒有才退回 settings.SERVER_DOMAIN。
pub(crate) fn server_domain(headers: &HeaderMap, state: &AppState) -> String {
    headers
        .get(header::HOST)
        .and_then(|h| h.to_str().ok())
        .map(host_without_port)
        .or_else(|| state.config.server_domain.clone())
        .unwrap_or_default()
}

/// ssh 實際連的主機：`SSH_SERVER_DOMAIN`（網站設定 → 伺服器 → SSH 主機），沒設就跟網頁同一個（[`server_domain`]）。
/// 網頁走 Cloudflare 這類只轉 HTTP(S) 的代理時，網頁的名稱連不到 gateway 的 port，所以要能分開。
/// The host ssh dials: SSH_SERVER_DOMAIN (Site settings → Server → SSH host), else the web host ([`server_domain`]).
/// Separate because a web name behind a proxy that only carries HTTP(S), such as Cloudflare's, cannot reach the gateway port.
pub(crate) fn ssh_host(headers: &HeaderMap, state: &AppState) -> String {
    state.config.ssh_host().unwrap_or_else(|| server_domain(headers, state))
}

/// 連線（安裝）腳本是把隧道裝上裝置的材料（服務金鑰、號碼、安裝代號）：只給 owner / ADMIN。
/// Connection (install) scripts set the tunnel up on the device (service key, number, install id): owner / ADMIN only.
const SCRIPTS_FORBIDDEN: &str = "Only the tunnel owner or an ADMIN sharee can get its connection scripts.";

async fn may_get_scripts(state: &AppState, user_id: i64, t: &Tunnel) -> ApiResult<bool> {
    Ok(permissions::check_access(&state.db, user_id, t, Permission::Admin).await?)
}

async fn viewable_tunnel(state: &AppState, user_id: i64, id: i64) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Reverse server keys not found"))?;
    if !permissions::check_access(&state.db, user_id, &t, Permission::View).await? {
        return Err(ApiError::not_found("Reverse server keys not found"));
    }
    Ok(t)
}

fn clean_key_path(raw: Option<&String>) -> Option<String> {
    raw.map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
}

/// ~/.ssh/config 的伺服器那一半：`Host telepy-<網域>-<port>` 區塊加上筆電要存的東西（單台與多台共用）。
/// The server half of the ~/.ssh/config: the `Host telepy-<domain>-<port>` stanza plus what the laptop saves (shared
/// by the single and the bulk config).
struct ServerPart {
    /// 標題 + 伺服器區塊。/ Banner + server stanza.
    text: String,
    /// 伺服器區塊的別名（裝置區塊的 ProxyCommand 跳它）。/ The server stanza's alias (the devices' ProxyCommand target).
    alias: String,
    /// 回應裡除了裝置以外的欄位。/ The response fields that are not about devices.
    fields: serde_json::Map<String, Value>,
    /// 網域（裝置在 known_hosts 裡的別名要用）。/ The domain (for the devices' known_hosts aliases).
    domain: String,
}

impl ServerPart {
    /// 一台裝置的 host key 怎麼核對，並把釘住的那幾行接到回應的 `known_hosts` 後面（安裝指令一起存）。
    /// How one device's host key is checked; its pinned lines go after the response's `known_hosts` (saved together).
    fn device_key(&mut self, state: &AppState, tunnel_id: i64, pins: &[String]) -> (String, bool) {
        let alias = scripts::device_key_alias(&self.domain, &state.config.reverse_server_ssh_port, tunnel_id);
        if !pins.is_empty() {
            let mut known = self.fields.get("known_hosts").and_then(Value::as_str).unwrap_or_default().to_string();
            known.push_str(&scripts::known_hosts_lines(&alias, pins));
            self.fields.insert("known_hosts".into(), json!(known));
        }
        (alias, !pins.is_empty())
    }
}

fn server_part(state: &AppState, headers: &HeaderMap, transport: Option<String>) -> ApiResult<ServerPart> {
    let domain = server_domain(headers, state);
    let host = ssh_host(headers, state);
    let gateway_keys = state.gateway.host_public_keys();
    // SSH over WebSocket（筆電只能出網頁 port）或自動（先 SSH 的 port、不通再走網頁）：伺服器區塊多一行 ProxyCommand，
    // 筆電要先存 telepy-ws.py。/ SSH over WebSocket, or automatic (the SSH port first, the web port when it fails): the
    // server stanza gets a ProxyCommand and the laptop saves telepy-ws.py first.
    let transport = super::join::parse_transport(transport)?;
    let base = crate::oauth::issuer(state.config.public_base().as_deref(), headers);
    let ws_url = super::join::ws_url(&base);
    let tcp = format!("{host}:{}", gateway_port(state));
    let ws_proxy = match transport {
        "websocket" => Some(scripts::laptop_proxy_command(None, &ws_url)),
        "auto" => Some(scripts::laptop_proxy_command(Some(&tcp), &ws_url)),
        _ => None,
    };
    let mut text = String::from(SERVER_STEM);
    text.push_str(&scripts::render_server_config(&domain, &host, &state.config.reverse_server_ssh_port, &gateway_keys, ws_proxy.as_deref()));
    let alias = scripts::server_alias(&domain, &state.config.reverse_server_ssh_port);
    // legacy_alias：舊版的共用別名，安裝指令確定是這台的、又沒人用時會拿掉。/ The old shared alias install commands clean up.
    let server = json!({ "alias": alias, "legacy_alias": scripts::LEGACY_SERVER_ALIAS, "host": host, "domain": domain, "port": state.config.reverse_server_ssh_port });
    // 筆電要存的 known_hosts（`HostKeyAlias` 的別名 + gateway 的 host key）；gateway 沒有金鑰時是空字串。
    // The known_hosts the laptop saves (alias for `HostKeyAlias` + the gateway's host keys); empty without gateway keys.
    let known_hosts = scripts::known_hosts_lines(&scripts::gateway_alias(&domain, &state.config.reverse_server_ssh_port), &gateway_keys);
    let Value::Object(fields) = json!({
        "server": server,
        "known_hosts": known_hosts, "known_hosts_path": scripts::LAPTOP_KNOWN_HOSTS,
        "transport": transport,
        "ws_url": ws_url,
        "ws_client_url": format!("{base}/api/join/telepy-ws.py"),
        "ws_client_path": scripts::WS_CLIENT_PATH,
    }) else {
        unreachable!()
    };
    Ok(ServerPart { text, alias, fields, domain })
}

/// 這個人的裝置別名前綴（個人設定，空 = 不加）。/ This person's device alias prefix (personal setting; empty = none).
async fn alias_prefix(state: &AppState, user_id: i64) -> ApiResult<String> {
    Ok(db::users::settings_for(&state.db, user_id).await?.map(|s| s.ssh_alias_prefix).unwrap_or_default())
}

/// 一台裝置的 Host 區塊（附在 `out` 後面）與給前端的別名清單。`used` = 已經用掉的別名（多台時避免重複）。
/// One device's Host stanzas (appended to `out`) and the alias list for the frontend; `used` = aliases taken already.
fn push_device_stanzas(out: &mut String, t: &Tunnel, accounts: &[&db::tunnels::UsernameWithCreator], server_alias: &str, prefix: &str, used: &mut HashSet<String>, key: &scripts::DeviceHostKey) -> Vec<Value> {
    let names: Vec<&str> = accounts.iter().map(|u| u.username.as_str()).collect();
    let aliases = scripts::device_aliases(prefix, &t.host_friendly_name, &names, used);
    // 結構化欄位給前端的指令速查（-L/-R/-D/-J 指令要用跟 config 一模一樣的 Host 別名）。
    // Structured fields for the frontend command sheet (commands must use the exact Host aliases above).
    accounts
        .iter()
        .zip(aliases)
        .map(|(u, alias)| {
            out.push_str(&scripts::render_client_config(&alias, &u.username, &t.host_friendly_name, t.reverse_port, server_alias, key));
            json!({ "alias": alias, "username": u.username, "username_id": u.id })
        })
        .collect()
}

/// `ReverseServerAuthorizedKeysConfig`
#[utoipa::path(get, path = "/tunnels/server/config/{id}", tag = "Script", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username_ids" = Option<String>, Query, description = "Comma-separated target username ids to render (default: all you may use); one id = the plain device alias"), ("username_id" = Option<i64>, Query, description = "Older form of username_ids with one id"), ("transport" = Option<String>, Query, description = "ssh | websocket")), responses((status = 200, description = "~/.ssh/config stanzas (server + one per target username)", body = super::schemas::ConfigResponse), (status = 404, body = super::schemas::ErrorBody)))]
async fn config(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path(id): Path<i64>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let t = viewable_tunnel(&state, user.id, id).await?;
    let mut part = server_part(&state, &headers, q.get("transport").cloned())?;

    let all = permissions::allowed_usernames(&state.db, user.id, &t).await?;
    let usernames_list: Vec<Value> = all
        .iter()
        .map(|u| json!({ "id": u.id, "username": u.username, "created_by": u.created_by, "created_by_id": u.user_id }))
        .collect();
    // 挑幾個帳號（照帳號清單的順序）；沒給 = 全部。不能用的 id 直接略過。/ Picked accounts, in list order; none = all.
    let picked: Option<Vec<i64>> = match (q.get("username_ids").map(|s| s.trim()).filter(|s| !s.is_empty()), q.get("username_id").and_then(|s| s.parse::<i64>().ok())) {
        (Some(list), _) => Some(scripts::parse_id_list(list).map_err(|_| ApiError::field("username_ids", "A comma-separated list of username ids."))?),
        (None, Some(one)) => Some(vec![one]),
        (None, None) => None,
    };
    let selected: Vec<_> = match &picked {
        Some(ids) => all.iter().filter(|u| ids.contains(&u.id)).collect(),
        None => all.iter().collect(),
    };
    if !selected.is_empty() {
        part.text.push_str(CLIENT_STEM);
    }
    let prefix = alias_prefix(&state, user.id).await?;
    let pins = if selected.is_empty() { Vec::new() } else { db::host_keys::pinned_lines(&state.db, t.id).await? };
    let (key_alias, pinned) = part.device_key(&state, t.id, &pins);
    let ServerPart { text: mut out, alias: server_alias, mut fields, .. } = part;
    let key = scripts::DeviceHostKey { alias: &key_alias, pinned };
    let hosts = push_device_stanzas(&mut out, &t, &selected, &server_alias, &prefix, &mut HashSet::from([server_alias.clone()]), &key);
    fields.insert("alias_prefix".into(), json!(prefix));
    // 隧道的預設帳號（我能用的話），前端拿來決定一開始勾哪個。/ The tunnel's default account, when I may use it.
    let default_id = t.default_username_id.filter(|d| all.iter().any(|u| u.id == *d));
    fields.insert("default_username_id".into(), json!(default_id));
    fields.insert("config".into(), json!(out));
    fields.insert("usernames".into(), json!(usernames_list));
    fields.insert("hosts".into(), json!(hosts));
    fields.insert("reverse_port".into(), json!(t.reverse_port));
    Ok(Json(Value::Object(fields)))
}

/// 多台一次：一個伺服器區塊 + 每台裝置的區塊，依裝置名稱排序。`ids` 沒給 = 我能登入的每一台；給了就只挑那些
/// （看不到的 id 直接略過，不透露存在與否）。`accounts=default`（預設）= 每台一個 Host，用隧道的預設帳號（不能用就用
/// 第一個），別名就是裝置名稱；`accounts=all` = 每個帳號一個，跟單台的「全部帳號」同一套別名。沒有任何帳號的裝置列在
/// `skipped`。
/// Several devices at once: one server stanza plus every device's stanzas, sorted by device name. Without `ids`:
/// every device I can log in to; with them, just those (ids I can't see are skipped silently). `accounts=default`
/// (the default) = one Host per device with the tunnel's default account (else the first) and the device name as the
/// alias; `accounts=all` = one per account, with the single config's aliases. `pick=<tunnel>:<account>.<account>,…`
/// overrides that per device (one account = the plain alias, several = `<name>-<account>`; ids I may not use are
/// dropped, and a device left with none falls back to the mode). Devices without an account for me are listed in
/// `skipped`.
#[utoipa::path(get, path = "/tunnels/server/config", tag = "Script", security(("bearer" = [])), params(("ids" = Option<String>, Query, description = "Comma-separated tunnel ids (default: every tunnel you can log in to)"), ("accounts" = Option<String>, Query, description = "default (one Host per device) | all (one Host per account)"), ("pick" = Option<String>, Query, description = "Per-device accounts overriding `accounts`: `<tunnel id>:<username id>.<username id>,…`"), ("transport" = Option<String>, Query, description = "ssh | websocket")), responses((status = 200, description = "~/.ssh/config stanzas (server + every chosen device)", body = super::schemas::BulkConfigResponse), (status = 400, body = super::schemas::ErrorBody)))]
async fn config_many(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    let every_account = match q.get("accounts").map(|s| s.trim()) {
        None | Some("") | Some("default") => false,
        Some("all") => true,
        Some(_) => return Err(ApiError::field("accounts", "Use \"default\" or \"all\".")),
    };
    let wanted: Option<HashSet<i64>> = match q.get("ids").map(|s| s.trim()).filter(|s| !s.is_empty()) {
        None => None,
        Some(s) => Some(
            s.split(',')
                .map(|p| p.trim().parse::<i64>())
                .collect::<Result<_, _>>()
                .map_err(|_| ApiError::field("ids", "A comma-separated list of tunnel ids."))?,
        ),
    };
    let picks = scripts::parse_picks(q.get("pick").map(String::as_str).unwrap_or("")).map_err(|_| ApiError::field("pick", "Use <tunnel id>:<username id>.<username id>, separated by commas."))?;
    let mut part = server_part(&state, &headers, q.get("transport").cloned())?;
    let server_alias = part.alias.clone();
    let all_pins = db::host_keys::pinned_lines_by_tunnel(&state.db).await?;

    let mut tunnels = db::tunnels::visible_to(&state.db, user.id).await?;
    if let Some(w) = &wanted {
        tunnels.retain(|t| w.contains(&t.id));
    }
    tunnels.sort_by(|a, b| a.host_friendly_name.to_lowercase().cmp(&b.host_friendly_name.to_lowercase()).then(a.id.cmp(&b.id)));

    let mut used: HashSet<String> = HashSet::from([server_alias.clone()]);
    let prefix = alias_prefix(&state, user.id).await?;
    let mut listed = Vec::new();
    let mut skipped = Vec::new();
    for t in &tunnels {
        let allowed = permissions::allowed_usernames(&state.db, user.id, t).await?;
        if allowed.is_empty() {
            skipped.push(json!({ "id": t.id, "name": t.host_friendly_name, "reason": "no_accounts" }));
            continue;
        }
        let picked: Vec<_> = picks.get(&t.id).map(|ids| allowed.iter().filter(|u| ids.contains(&u.id)).collect()).unwrap_or_default();
        let chosen: Vec<_> = if !picked.is_empty() {
            picked
        } else if every_account {
            allowed.iter().collect()
        } else {
            vec![allowed.iter().find(|u| Some(u.id) == t.default_username_id).unwrap_or(&allowed[0])]
        };
        if listed.is_empty() {
            part.text.push_str(CLIENT_STEM);
        }
        let (key_alias, pinned) = part.device_key(&state, t.id, all_pins.get(&t.id).map(Vec::as_slice).unwrap_or_default());
        let key = scripts::DeviceHostKey { alias: &key_alias, pinned };
        let hosts = push_device_stanzas(&mut part.text, t, &chosen, &server_alias, &prefix, &mut used, &key);
        let usernames: Vec<Value> = allowed.iter().map(|u| json!({ "id": u.id, "username": u.username })).collect();
        let default_id = t.default_username_id.filter(|d| allowed.iter().any(|u| u.id == *d));
        listed.push(json!({ "id": t.id, "name": t.host_friendly_name, "reverse_port": t.reverse_port, "hosts": hosts, "usernames": usernames, "default_username_id": default_id, "picked": picks.contains_key(&t.id) }));
    }
    let ServerPart { text: out, mut fields, .. } = part;
    fields.insert("config".into(), json!(out));
    fields.insert("accounts".into(), json!(if every_account { "all" } else { "default" }));
    fields.insert("alias_prefix".into(), json!(prefix));
    fields.insert("tunnels".into(), json!(listed));
    fields.insert("skipped".into(), json!(skipped));
    Ok(Json(Value::Object(fields)))
}

/// gateway 對外的 port（沒設 = 22）。/ The gateway's public port (22 when unset).
fn gateway_port(state: &AppState) -> String {
    Some(state.config.reverse_server_ssh_port.trim()).filter(|p| !p.is_empty()).unwrap_or("22").to_string()
}

/// 腳本用的載具：`websocket` / `auto` 時 (ws url, 小程式 url, auto 時 SSH 的 `host:port`)。
/// The carrier for the scripts: (ws url, carrier url, and the SSH `host:port` for `auto`).
type Carrier = (String, String, Option<String>);

fn ws_carrier(state: &AppState, headers: &HeaderMap, transport: Option<String>) -> Result<Option<Carrier>, ApiError> {
    let transport = super::join::parse_transport(transport)?;
    if transport == "ssh" {
        return Ok(None);
    }
    let base = crate::oauth::issuer(state.config.public_base().as_deref(), headers);
    let tcp = (transport == "auto").then(|| format!("{}:{}", ssh_host(headers, state), gateway_port(state)));
    Ok(Some((super::join::ws_url(&base), format!("{base}/api/join/telepy-ws.py"), tcp)))
}

/// 六種腳本的共用渲染：autossh-service 需要目標使用者名稱（username_id 可指定）。
async fn render_for(
    state: &AppState,
    user_id: i64,
    t: &Tunnel,
    kind: &str,
    ssh_port: i64,
    key_path: Option<&str>,
    username_id: Option<i64>,
    domain: &str,
    ssh_host: &str,
    ws: Option<Carrier>,
) -> Result<(String, &'static str), ApiError> {
    let username = if kind == "autossh-service" {
        let allowed = permissions::allowed_usernames(&state.db, user_id, t).await?;
        let selected = allowed.iter().find(|u| username_id.map(|id| u.id == id).unwrap_or(true));
        match selected {
            Some(u) => u.username.clone(),
            None => return Err(ApiError::not_found("No username found for this server")),
        }
    } else {
        "root".to_string()
    };
    // 腳本裡寫進 authorized_keys 的是這條隧道自己的服務金鑰。/ The scripts authorize the tunnel's own service key.
    let service_key = Some(crate::ssh::tunnel_keys::ensure(state, t.id).await?);
    let gateway_keys = state.gateway.host_public_keys();
    let install_id = db::device_install::ensure(&state.db, t.id).await?;
    let ctx = ScriptContext {
        host_friendly_name: &t.host_friendly_name,
        server_domain: domain,
        ssh_host,
        reverse_port: t.reverse_port,
        ssh_port,
        reverse_server_ssh_port: &state.config.reverse_server_ssh_port,
        username: &username,
        key_path,
        telepy_public_key: service_key.as_deref(),
        gateway_host_keys: &gateway_keys,
        ws: ws.as_ref().map(|(url, client_url, tcp)| scripts::WsCarrier { url, client_url, tcp: tcp.as_deref() }),
        install_id: &install_id,
    };
    scripts::render_script(kind, &ctx).map_err(ApiError::bad_request)
}

/// `/tunnels/server/script/{kind}/{id}/{ssh_port}`
#[utoipa::path(get, path = "/tunnels/server/script/{kind}/{id}/{ssh_port}", tag = "Script", security(("bearer" = [])), params(("kind" = String, Path, description = "ssh | powershell | autossh | autossh-service | docker-run | docker-compose"), ("id" = i64, Path, description = "Tunnel id"), ("ssh_port" = i64, Path, description = "sshd port on the device"), ("key_path" = Option<String>, Query, description = "Private key path to embed (-i)"), ("username_id" = Option<i64>, Query, description = "autossh-service only: which target username runs the service")), responses((status = 200, body = super::schemas::ScriptResponse), (status = 403, description = "Owner / ADMIN only", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn script(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((kind, id, ssh_port)): Path<(String, i64, i64)>,
    Query(q): Query<HashMap<String, String>>,
    headers: HeaderMap,
) -> ApiResult<Json<Value>> {
    if !ALLOWED_SCRIPT_TYPES.contains(&kind.as_str()) {
        return Err(ApiError::drf_not_found());
    }
    let t = viewable_tunnel(&state, user.id, id).await?;
    if !may_get_scripts(&state, user.id, &t).await? {
        return Err(ApiError::forbidden(SCRIPTS_FORBIDDEN));
    }
    let domain = server_domain(&headers, &state);
    let key_path = clean_key_path(q.get("key_path"));
    let username_id = q.get("username_id").and_then(|s| s.parse::<i64>().ok());
    let ws = ws_carrier(&state, &headers, q.get("transport").cloned())?;
    let (script, language) = render_for(&state, user.id, &t, &kind, ssh_port, key_path.as_deref(), username_id, &domain, &ssh_host(&headers, &state), ws).await?;
    Ok(Json(json!({ "script": script, "language": language })))
}

/// `OneTimeScriptTokenView`：`{"token", "url"}`；url 的 scheme/host 依 X-Forwarded-* 決定。
#[utoipa::path(post, path = "/tunnels/server/script/one-time/token", tag = "Script", security(("bearer" = [])), request_body = super::schemas::OneTimeTokenRequest, responses((status = 200, description = "Single-use URL (10 minutes) that serves the script without auth", body = super::schemas::OneTimeToken), (status = 400, body = super::schemas::ErrorBody), (status = 403, description = "No access, or not the owner / an ADMIN sharee", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn one_time_token(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    AppJson(body): AppJson<Value>,
) -> ApiResult<Json<Value>> {
    let server_id = json_i64(&body, "server_id");
    let ssh_port = json_i64(&body, "ssh_port");
    let script_type = json_str(&body, "script_type");
    let (Some(server_id), Some(ssh_port), Some(script_type)) = (server_id, ssh_port, script_type) else {
        return Err(ApiError::bad_request("server_id, ssh_port, and script_type are required"));
    };
    if server_id == 0 || ssh_port == 0 || script_type.is_empty() {
        return Err(ApiError::bad_request("server_id, ssh_port, and script_type are required"));
    }
    if !ALLOWED_SCRIPT_TYPES.contains(&script_type.as_str()) {
        let mut sorted: Vec<&str> = ALLOWED_SCRIPT_TYPES.to_vec();
        sorted.sort();
        let list = sorted.iter().map(|s| format!("'{s}'")).collect::<Vec<_>>().join(", ");
        return Err(ApiError::bad_request(format!("Invalid script_type. Allowed: [{list}]")));
    }
    let t = db::tunnels::by_id(&state.db, server_id).await?.ok_or_else(|| ApiError::not_found("Tunnel not found"))?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::View).await? {
        return Err(ApiError::forbidden("Access denied"));
    }
    if !may_get_scripts(&state, user.id, &t).await? {
        return Err(ApiError::forbidden(SCRIPTS_FORBIDDEN));
    }
    let username_id = json_i64(&body, "username_id");
    if script_type == "autossh-service" {
        if let Some(uid) = username_id {
            let allowed = permissions::allowed_usernames(&state.db, user.id, &t).await?;
            if !allowed.iter().any(|u| u.id == uid) {
                return Err(ApiError::bad_request("Username not allowed or not found"));
            }
        }
    }
    let transport = super::join::parse_transport(json_str(&body, "transport"))?;
    let token = state.tokens.issue_script_token(ScriptTokenPayload {
        user_id: user.id,
        server_id,
        ssh_port,
        script_type,
        key_path: json_str(&body, "key_path"),
        username_id,
        transport: Some(transport.to_string()),
    });
    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .filter(|v| v == "https")
        .unwrap_or_else(|| "http".to_string());
    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get(header::HOST))
        .and_then(|v| v.to_str().ok())
        .map(|v| v.split(',').next().unwrap_or("").trim().to_string())
        .unwrap_or_default();
    Ok(Json(json!({ "token": token, "url": format!("{scheme}://{host}/tunnels/server/script/one-time/{token}") })))
}

fn plain(status: StatusCode, body: String) -> Response {
    (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], body).into_response()
}

/// `OneTimeScriptView`（AllowAny）：取用即失效，回 text/plain。
#[utoipa::path(get, path = "/tunnels/server/script/one-time/{token}", tag = "Script", params(("token" = String, Path, description = "Single-use token")), responses((status = 200, description = "The script, text/plain; the token is consumed", content_type = "text/plain", body = String), (status = 404, description = "Token invalid or already used", content_type = "text/plain", body = String)))]
async fn one_time_script(State(state): State<AppState>, Path(token): Path<String>, headers: HeaderMap) -> Response {
    let Some(payload) = state.tokens.pop_script_token(&token) else {
        return plain(StatusCode::NOT_FOUND, "Token invalid or already used".into());
    };
    let user = match db::users::by_id(&state.db, payload.user_id).await {
        Ok(Some(u)) => u,
        Ok(None) => return plain(StatusCode::NOT_FOUND, "User not found".into()),
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    let t = match db::tunnels::by_id(&state.db, payload.server_id).await {
        Ok(Some(t)) => t,
        Ok(None) => return plain(StatusCode::NOT_FOUND, "Tunnel not found".into()),
        Err(e) => return plain(StatusCode::INTERNAL_SERVER_ERROR, e.to_string()),
    };
    // 取用時再看一次：網址發出後被降級或取消分享就不給。/ Checked again on use: a demotion or unshare since issuing wins.
    match may_get_scripts(&state, user.id, &t).await {
        Ok(true) => {}
        Ok(false) => return plain(StatusCode::FORBIDDEN, "Access denied".into()),
        Err(e) => return plain(e.status, "error".into()),
    }
    let domain = server_domain(&headers, &state);
    let key_path = payload.key_path.as_ref().map(|s| s.trim().to_string()).filter(|s| !s.is_empty());
    let ws = match ws_carrier(&state, &headers, payload.transport.clone()) {
        Ok(ws) => ws,
        Err(e) => return plain(StatusCode::BAD_REQUEST, format!("{:?}", e.body)),
    };
    let way = match &ws {
        Some((_, _, Some(_))) => "auto",
        Some(_) => "websocket",
        None => "ssh",
    };
    match render_for(&state, user.id, &t, &payload.script_type, payload.ssh_port, key_path.as_deref(), payload.username_id, &domain, &ssh_host(&headers, &state), ws).await {
        Ok((script, _)) => {
            // 裝置拿走了腳本：它就是這樣加進來的（重新安裝就覆蓋）。/ The device took the script: this is how it is added.
            if let Err(e) = db::tunnels::set_way_in(&state.db, t.id, way).await {
                tracing::warn!(tunnel = t.id, error = %e, "cannot record how the tunnel was added");
            }
            plain(StatusCode::OK, script)
        }
        Err(e) => {
            let msg = e.body.get("error").and_then(|v| v.as_str()).unwrap_or("error").to_string();
            plain(e.status, msg)
        }
    }
}
