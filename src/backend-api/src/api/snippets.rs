//! 工具箱：常用的指令片段，在網頁終端機一鍵送出（就像自己打的一樣，所以指令規則照樣檢查）。
//! - 三種範圍：`user`（自己的，任何隧道都能用；只有自己看得到、改得了）、`tunnel`（某條隧道的；owner / ADMIN 改，
//!   能開那條隧道終端機的人——owner / ADMIN 或至少有一個允許帳號——都能用）、`site`（全站；管理員改，大家都能用）
//! - `GET /api/snippets?tunnel_id=`：在那裡能用的全部（自己的 + 那條隧道的 + 全站的）
//! - `POST /api/snippets`、`PATCH/DELETE /api/snippets/{id}`、`POST /api/snippets/{id}/used`（計數）
//!
//! 變數（`$name` / `${name}`）在瀏覽器裡代換；秘密變數只存名稱與標籤，值永遠不會送到後端。
//! Toolbox: saved command snippets sent to the web terminal as if typed (so command rules still apply). Three scopes:
//! `user` (your own, usable on any tunnel), `tunnel` (owner / ADMIN edit; anyone who can open that tunnel's terminal
//! uses them) and `site` (admins edit, everyone uses). Variables are substituted in the browser; a secret variable
//! keeps only its name and label, its value never reaches the backend.

use std::collections::HashSet;

use axum::extract::{Path, Query, State};
use axum::http::StatusCode;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, snippets::{Fields, Snippet}, tunnels::Tunnel, users::User};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::state::AppState;
use crate::util::{db_to_iso_utc_z, opt_db_to_iso_utc_z};

/// 每個範圍（一個人 / 一條隧道 / 全站）最多幾個。/ Snippets per scope at most.
pub const MAX_PER_SCOPE: i64 = 200;
pub const NAME_MAX: usize = 60;
pub const COMMAND_MAX: usize = 4000;
pub const DESCRIPTION_MAX: usize = 500;
pub const MAX_VARIABLES: usize = 20;
pub const VAR_NAME_MAX: usize = 32;
pub const VAR_LABEL_MAX: usize = 60;
pub const VAR_DEFAULT_MAX: usize = 500;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list, create)).routes(routes!(update, destroy)).routes(routes!(used))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    User,
    Tunnel,
    Site,
}

impl Scope {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "user" => Some(Self::User),
            "tunnel" => Some(Self::Tunnel),
            "site" => Some(Self::Site),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Tunnel => "tunnel",
            Self::Site => "site",
        }
    }
}

/// 誰能改：自己的 = 本人；隧道的 = owner / ADMIN；全站 = 管理員。（純函式）
/// Who may edit: your own = you; a tunnel's = owner / ADMIN; site-wide = admins. (pure)
pub fn can_edit(scope: Scope, is_owner: bool, tunnel_admin: bool, is_superuser: bool) -> bool {
    match scope {
        Scope::User => is_owner,
        Scope::Tunnel => tunnel_admin,
        Scope::Site => is_superuser,
    }
}

/// 隧道片段誰能用：能開那條隧道終端機的人（owner / ADMIN，或至少有一個允許帳號）。（純函式）
/// Who uses a tunnel's snippets: whoever can open its terminal (owner / ADMIN, or at least one allowed account). (pure)
pub fn can_use_tunnel(eff: Option<permissions::Effective>, has_allowed_account: bool) -> bool {
    match eff {
        None => false,
        Some(e) => e.satisfies(Permission::Admin) || has_allowed_account,
    }
}

/// `$name` 的名稱規則（跟 Python `string.Template` 一樣：字母或底線開頭）。/ A variable name, as Python's `Template` reads it.
pub fn valid_var_name(s: &str) -> bool {
    let mut chars = s.chars();
    matches!(chars.next(), Some(c) if c.is_ascii_alphabetic() || c == '_')
        && chars.all(|c| c.is_ascii_alphanumeric() || c == '_')
        && s.len() <= VAR_NAME_MAX
}

/// 驗證並正規化變數清單：`[{name, label, default, secret}]`，名稱不重複；秘密變數的預設值一律清空（值不存）。
/// Validate and normalise the variables: `[{name, label, default, secret}]` with unique names; a secret variable never
/// keeps a default (its value is never stored).
pub fn parse_variables(v: Option<&Value>) -> Result<Value, String> {
    let items = match v {
        None | Some(Value::Null) => return Ok(json!([])),
        Some(Value::Array(a)) => a,
        Some(_) => return Err("variables must be a list.".into()),
    };
    if items.len() > MAX_VARIABLES {
        return Err(format!("A snippet can ask for at most {MAX_VARIABLES} variables."));
    }
    let mut seen = HashSet::new();
    let mut out = Vec::with_capacity(items.len());
    for item in items {
        let obj = item.as_object().ok_or("Each variable must be an object with a name.")?;
        let name = obj.get("name").and_then(Value::as_str).map(str::trim).unwrap_or_default();
        if !valid_var_name(name) {
            return Err(format!("\"{name}\" is not a variable name: use letters, digits and _ (not starting with a digit), at most {VAR_NAME_MAX}."));
        }
        if !seen.insert(name.to_string()) {
            return Err(format!("${name} is listed twice."));
        }
        let text = |k: &str| obj.get(k).and_then(Value::as_str).map(str::trim).unwrap_or_default().to_string();
        let label = text("label");
        if label.chars().count() > VAR_LABEL_MAX {
            return Err(format!("The label of ${name} is longer than {VAR_LABEL_MAX} characters."));
        }
        let secret = obj.get("secret").and_then(Value::as_bool).unwrap_or(false);
        let default = if secret { String::new() } else { obj.get("default").and_then(Value::as_str).unwrap_or_default().to_string() };
        if default.chars().count() > VAR_DEFAULT_MAX {
            return Err(format!("The default of ${name} is longer than {VAR_DEFAULT_MAX} characters."));
        }
        out.push(json!({ "name": name, "label": label, "default": default, "secret": secret }));
    }
    Ok(Value::Array(out))
}

/// 表單 → 欄位（修改時沒帶的欄位沿用現在的）。/ The form → fields (on update, missing fields keep their value).
struct Parsed {
    name: String,
    command: String,
    description: String,
    variables: String,
    confirm: bool,
    sort_order: i64,
}

fn parse_fields(body: &Value, current: Option<&Snippet>) -> ApiResult<Parsed> {
    let name = match body.get("name") {
        None => current.map(|c| c.name.clone()).unwrap_or_default(),
        Some(v) => v.as_str().ok_or_else(|| ApiError::field("name", "name must be text."))?.trim().to_string(),
    };
    if name.is_empty() {
        return Err(ApiError::field("name", "Give the snippet a name."));
    }
    if name.chars().count() > NAME_MAX {
        return Err(ApiError::field("name", format!("Keep the name under {NAME_MAX} characters.")));
    }
    let command = match body.get("command") {
        None => current.map(|c| c.command.clone()).unwrap_or_default(),
        // 頭尾換行去掉（最後的 Enter 由送出時加），中間的保留（多行片段）。/ Outer newlines go, inner ones stay.
        Some(v) => v.as_str().ok_or_else(|| ApiError::field("command", "command must be text."))?.trim_matches(|c| c == '\n' || c == '\r').to_string(),
    };
    if command.trim().is_empty() {
        return Err(ApiError::field("command", "The command can't be empty."));
    }
    if command.chars().count() > COMMAND_MAX {
        return Err(ApiError::field("command", format!("Keep the command under {COMMAND_MAX} characters.")));
    }
    let description = match body.get("description") {
        None => current.map(|c| c.description.clone()).unwrap_or_default(),
        Some(Value::Null) => String::new(),
        Some(v) => v.as_str().ok_or_else(|| ApiError::field("description", "description must be text."))?.trim().to_string(),
    };
    if description.chars().count() > DESCRIPTION_MAX {
        return Err(ApiError::field("description", format!("Keep the description under {DESCRIPTION_MAX} characters.")));
    }
    let variables = match body.get("variables") {
        None => current.map(|c| c.variables.clone()).unwrap_or_else(|| "[]".into()),
        v => parse_variables(v).map_err(|m| ApiError::field("variables", m))?.to_string(),
    };
    let confirm = match body.get("confirm") {
        None | Some(Value::Null) => current.map(|c| c.confirm).unwrap_or(false),
        Some(Value::Bool(b)) => *b,
        Some(_) => return Err(ApiError::field("confirm", "confirm must be true or false.")),
    };
    let sort_order = match body.get("sort_order") {
        None | Some(Value::Null) => current.map(|c| c.sort_order).unwrap_or(0),
        Some(v) => v.as_i64().filter(|n| (-1_000_000..=1_000_000).contains(n)).ok_or_else(|| ApiError::field("sort_order", "sort_order must be a whole number."))?,
    };
    Ok(Parsed { name, command, description, variables, confirm, sort_order })
}

impl Parsed {
    fn fields(&self) -> Fields<'_> {
        Fields { name: &self.name, command: &self.command, description: &self.description, variables: &self.variables, confirm: self.confirm, sort_order: self.sort_order }
    }
}

fn snippet_json(s: &Snippet, can_edit: bool) -> Value {
    json!({
        "id": s.id,
        "scope": s.scope,
        "tunnel_id": s.tunnel_id,
        "name": s.name,
        "command": s.command,
        "description": s.description,
        "variables": serde_json::from_str::<Value>(&s.variables).unwrap_or_else(|_| json!([])),
        "confirm": s.confirm,
        "sort_order": s.sort_order,
        "use_count": s.use_count,
        "last_used_at": opt_db_to_iso_utc_z(&s.last_used_at),
        "can_edit": can_edit,
        "created_at": db_to_iso_utc_z(&s.created_at),
        "updated_at": db_to_iso_utc_z(&s.updated_at),
    })
}

fn not_found() -> ApiError {
    ApiError::not_found("Snippet not found")
}

/// 一條隧道對我：(隧道, 能不能用它的片段, 能不能改)；看不到 = 404。
/// A tunnel for me: (tunnel, may use its snippets, may edit them); invisible = 404.
async fn tunnel_rights(state: &AppState, me: &User, id: i64) -> ApiResult<(Tunnel, bool, bool)> {
    let nf = || ApiError::not_found("Tunnel not found");
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(nf)?;
    let eff = permissions::effective_for(&state.db, me.id, &t).await?.ok_or_else(nf)?;
    let admin = eff.satisfies(Permission::Admin);
    let has_account = admin || !permissions::allowed_usernames(&state.db, me.id, &t).await?.is_empty();
    Ok((t, can_use_tunnel(Some(eff), has_account), admin))
}

/// 一個片段對我：(能不能用, 能不能改)；連用都不行的回 404。/ A snippet for me: (use, edit); not even usable = 404.
async fn rights(state: &AppState, me: &User, s: &Snippet) -> ApiResult<(bool, bool)> {
    match Scope::parse(&s.scope) {
        Some(Scope::User) => {
            let mine = s.user_id == Some(me.id);
            Ok((mine, mine))
        }
        Some(Scope::Tunnel) => match s.tunnel_id {
            Some(tid) => match tunnel_rights(state, me, tid).await {
                Ok((_, usable, admin)) => Ok((usable || admin, can_edit(Scope::Tunnel, false, admin, me.is_superuser))),
                Err(_) => Ok((false, false)),
            },
            None => Ok((false, false)),
        },
        Some(Scope::Site) => Ok((true, can_edit(Scope::Site, false, false, me.is_superuser))),
        None => Ok((false, false)),
    }
}

#[derive(Debug, Deserialize, utoipa::IntoParams)]
pub struct ListQuery {
    /// 在這條隧道上能用的（加上它自己的片段）。/ What is usable on this tunnel (its own snippets included).
    pub tunnel_id: Option<i64>,
}

/// 在那裡能用的全部片段：自己的 + 那條隧道的（能開它的終端機時）+ 全站的。
/// Everything usable there: your own + that tunnel's (when you can open its terminal) + site-wide.
#[utoipa::path(get, path = "/api/snippets", tag = "Toolbox", security(("bearer" = [])), params(ListQuery), responses((status = 200, body = super::schemas::SnippetList), (status = 404, body = super::schemas::ErrorBody)))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser, Query(q): Query<ListQuery>) -> ApiResult<Json<Value>> {
    let mut out: Vec<Value> = db::snippets::for_user(&state.db, me.id).await?.iter().map(|s| snippet_json(s, true)).collect();
    let mut tunnel = Value::Null;
    if let Some(tid) = q.tunnel_id {
        let (t, usable, admin) = tunnel_rights(&state, &me, tid).await?;
        if usable {
            out.extend(db::snippets::for_tunnel(&state.db, t.id).await?.iter().map(|s| snippet_json(s, admin)));
        }
        tunnel = json!({ "id": t.id, "name": t.host_friendly_name, "can_use": usable, "can_edit": admin });
    }
    out.extend(db::snippets::for_site(&state.db).await?.iter().map(|s| snippet_json(s, me.is_superuser)));
    Ok(Json(json!({ "snippets": out, "tunnel": tunnel, "can_edit_site": me.is_superuser, "limit": MAX_PER_SCOPE })))
}

/// 新增片段（`scope` 預設 user；tunnel 要帶 `tunnel_id`）。/ Add a snippet (`scope` defaults to user; tunnel needs `tunnel_id`).
#[utoipa::path(post, path = "/api/snippets", tag = "Toolbox", security(("bearer" = [])), request_body = super::schemas::SnippetInput, responses((status = 201, body = super::schemas::Snippet), (status = 400, description = "{field: [message]}, or {error, code: limit} at 200 per scope", body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn create(State(state): State<AppState>, AuthUser(me): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let scope_text = body.get("scope").and_then(Value::as_str).unwrap_or("user");
    let scope = Scope::parse(scope_text).ok_or_else(|| ApiError::field("scope", "Choose user, tunnel or site."))?;
    let (user_id, tunnel_id) = match scope {
        Scope::User => (Some(me.id), None),
        Scope::Tunnel => {
            let tid = body.get("tunnel_id").and_then(Value::as_i64).ok_or_else(|| ApiError::field("tunnel_id", "Pick the tunnel this snippet belongs to."))?;
            let (t, _, admin) = tunnel_rights(&state, &me, tid).await?;
            if !admin {
                return Err(ApiError::forbidden("Only the tunnel owner or an ADMIN sharee can add snippets to this tunnel."));
            }
            (None, Some(t.id))
        }
        Scope::Site => {
            if !me.is_superuser {
                return Err(ApiError::forbidden("Only administrators can add site-wide snippets."));
            }
            (None, None)
        }
    };
    let p = parse_fields(&body, None)?;
    if db::snippets::count(&state.db, scope.as_str(), user_id.or(tunnel_id)).await? >= MAX_PER_SCOPE {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": format!("There can be at most {MAX_PER_SCOPE} snippets here."), "code": "limit" })));
    }
    let row = db::snippets::create(&state.db, scope.as_str(), user_id, tunnel_id, &p.fields(), me.id).await?;
    Ok((StatusCode::CREATED, Json(snippet_json(&row, true))))
}

/// 能改的片段；用都不能用的回 404，能用不能改的回 403。/ An editable snippet; 404 when not even usable, 403 when read-only.
async fn editable(state: &AppState, me: &User, id: i64) -> ApiResult<Snippet> {
    let row = db::snippets::get(&state.db, id).await?.ok_or_else(not_found)?;
    let (usable, edit) = rights(state, me, &row).await?;
    if edit {
        return Ok(row);
    }
    if !usable {
        return Err(not_found());
    }
    Err(ApiError::forbidden(match row.scope.as_str() {
        "site" => "Only administrators can change site-wide snippets.",
        _ => "Only the tunnel owner or an ADMIN sharee can change this tunnel's snippets.",
    }))
}

/// 修改片段（只帶要改的欄位；範圍不能改）。/ Change a snippet (send only what changes; the scope can't change).
#[utoipa::path(patch, path = "/api/snippets/{id}", tag = "Toolbox", security(("bearer" = [])), params(("id" = i64, Path, description = "Snippet id")), request_body = super::schemas::SnippetInput, responses((status = 200, body = super::schemas::Snippet), (status = 400, body = Object), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let row = editable(&state, &me, id).await?;
    if let Some(s) = body.get("scope").and_then(Value::as_str) {
        if s != row.scope {
            return Err(ApiError::field("scope", "A snippet can't move to another scope; add a copy there instead."));
        }
    }
    let p = parse_fields(&body, Some(&row))?;
    let row = db::snippets::update(&state.db, id, &p.fields()).await?.ok_or_else(not_found)?;
    Ok(Json(snippet_json(&row, true)))
}

/// 刪除片段。/ Delete a snippet.
#[utoipa::path(delete, path = "/api/snippets/{id}", tag = "Toolbox", security(("bearer" = [])), params(("id" = i64, Path, description = "Snippet id")), responses((status = 204), (status = 403, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    editable(&state, &me, id).await?;
    db::snippets::delete(&state.db, id).await?;
    Ok(StatusCode::NO_CONTENT)
}

/// 用了一次（計數，最常用的排前面用）。/ Count one use (for "most used").
#[utoipa::path(post, path = "/api/snippets/{id}/used", tag = "Toolbox", security(("bearer" = [])), params(("id" = i64, Path, description = "Snippet id")), responses((status = 200, body = super::schemas::SnippetUse), (status = 404, body = super::schemas::ErrorBody)))]
async fn used(State(state): State<AppState>, AuthUser(me): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let row = db::snippets::get(&state.db, id).await?.ok_or_else(not_found)?;
    if !rights(&state, &me, &row).await?.0 {
        return Err(not_found());
    }
    let row = db::snippets::mark_used(&state.db, id).await?.ok_or_else(not_found)?;
    Ok(Json(json!({ "id": row.id, "use_count": row.use_count, "last_used_at": opt_db_to_iso_utc_z(&row.last_used_at) })))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::permissions::Effective;

    #[test]
    fn edit_and_use_rules() {
        assert!(can_edit(Scope::User, true, false, false));
        assert!(!can_edit(Scope::User, false, true, true), "nobody else edits your own snippets, admins included");
        assert!(can_edit(Scope::Tunnel, false, true, false));
        assert!(!can_edit(Scope::Tunnel, false, false, true), "a site admin is not a tunnel manager");
        assert!(can_edit(Scope::Site, false, false, true));
        assert!(!can_edit(Scope::Site, true, true, false));
        assert!(can_use_tunnel(Some(Effective::Owner), false));
        assert!(can_use_tunnel(Some(Effective::Shared(Permission::Admin)), false));
        assert!(can_use_tunnel(Some(Effective::Shared(Permission::View)), true));
        assert!(!can_use_tunnel(Some(Effective::Shared(Permission::Edit)), false), "no account = no terminal = no tunnel snippets");
        assert!(!can_use_tunnel(None, true));
    }

    #[test]
    fn variable_names() {
        for ok in ["port", "_x", "HOST_1", "a"] {
            assert!(valid_var_name(ok), "{ok}");
        }
        for bad in ["", "1x", "a-b", "a b", "ü", &"x".repeat(33)] {
            assert!(!valid_var_name(bad), "{bad}");
        }
    }

    #[test]
    fn variables_are_validated_and_secrets_lose_their_default() {
        assert_eq!(parse_variables(None).unwrap(), json!([]));
        let v = parse_variables(Some(&json!([
            {"name": " port ", "label": "Port", "default": "8080"},
            {"name": "token", "secret": true, "default": "leak"},
        ])))
        .unwrap();
        assert_eq!(v, json!([
            {"name": "port", "label": "Port", "default": "8080", "secret": false},
            {"name": "token", "label": "", "default": "", "secret": true},
        ]));
        assert!(parse_variables(Some(&json!([{"name": "a"}, {"name": "a"}]))).unwrap_err().contains("twice"));
        assert!(parse_variables(Some(&json!([{"name": "9"}]))).is_err());
        assert!(parse_variables(Some(&json!("port"))).is_err());
        assert!(parse_variables(Some(&json!([{"label": "x"}]))).is_err());
        let many: Vec<Value> = (0..=MAX_VARIABLES).map(|i| json!({"name": format!("v{i}")})).collect();
        assert!(parse_variables(Some(&Value::Array(many))).is_err());
    }

    fn row() -> Snippet {
        Snippet {
            id: 1, scope: "user".into(), user_id: Some(1), tunnel_id: None, name: "Disk".into(), command: "df -h".into(), description: String::new(),
            variables: "[]".into(), confirm: true, sort_order: 3, use_count: 0, last_used_at: None, created_by_id: Some(1), created_at: String::new(), updated_at: String::new(),
        }
    }

    #[test]
    fn fields_keep_what_is_left_out() {
        let r = row();
        let p = parse_fields(&json!({"name": "  Disk usage "}), Some(&r)).unwrap();
        assert_eq!((p.name.as_str(), p.command.as_str(), p.confirm, p.sort_order), ("Disk usage", "df -h", true, 3));
        let p = parse_fields(&json!({"name": "x", "command": "\nuptime\nfree -h\n"}), None).unwrap();
        assert_eq!(p.command, "uptime\nfree -h", "outer newlines go, inner ones stay");
        assert!(parse_fields(&json!({"name": "", "command": "x"}), None).is_err());
        assert!(parse_fields(&json!({"name": "x", "command": "  "}), None).is_err());
        assert!(parse_fields(&json!({"name": "x".repeat(NAME_MAX + 1), "command": "x"}), None).is_err());
        assert!(parse_fields(&json!({"name": "x", "command": "y".repeat(COMMAND_MAX + 1)}), None).is_err());
        assert!(parse_fields(&json!({"name": "x", "command": "y", "confirm": "yes"}), None).is_err());
    }
}
