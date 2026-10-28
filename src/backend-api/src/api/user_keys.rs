//! `/api/reverse/user/keys`：使用者金鑰 ViewSet（`UserAuthorizedKeysViewSet`）。

use axum::extract::{Path, State};
use axum::http::StatusCode;
use axum::Json;
use serde_json::{json, Value};

use super::serialize::user_key_json;
use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, keys::UserKey, tunnels::like_prefix, Db};
use crate::device_keys::authorized_keys::{parse_public_key, weak_key_reason};
use crate::error::{is_unique_violation, ApiError, ApiResult};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};
use crate::util::json_str;
use crate::expiry::{check_expiry, parse_expiry};
use chrono::{Duration, Utc};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(list, create))
        .routes(routes!(retrieve, update, replace, destroy))
}

pub fn unique_error(e: sqlx::Error) -> ApiError {
    if is_unique_violation(&e) {
        let msg = crate::error::db_error_message(&e);
        if msg.contains("host_friendly_name") {
            ApiError::field("host_friendly_name", "user keys with this Host Friendly Name already exists.")
        } else {
            ApiError::field("key", "user keys with this SSH Key (public) already exists.")
        }
    } else {
        ApiError::from(e)
    }
}

#[utoipa::path(get, path = "/api/reverse/user/keys", tag = "Reverse Server Keys", security(("bearer" = [])), responses((status = 200, body = Vec<super::schemas::UserKey>)))]
async fn list(State(state): State<AppState>, AuthUser(user): AuthUser) -> ApiResult<Json<Value>> {
    let rows = db::keys::user_keys(&state.db, user.id).await?;
    let groups = db::groups::key_group_of(&state.db, user.id).await?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(Value::Array(
        rows.iter()
            .map(|k| {
                let mut v = user_key_json(k, tz);
                v["group_id"] = json!(groups.get(&k.id));
                v
            })
            .collect(),
    )))
}

/// 單筆金鑰的 JSON，加上它在哪個金鑰群組。/ One key's JSON plus its key group.
async fn key_reply(state: &AppState, k: &UserKey) -> ApiResult<Value> {
    let mut v = user_key_json(k, state.config.tz_offset_minutes);
    v["group_id"] = json!(db::groups::key_group_of_key(&state.db, k.id).await?);
    Ok(v)
}

/// `group_id`：沒給 = 不動；null = 拿出群組；否則必須是自己的金鑰群組。/ `group_id`: absent = unchanged; null = none;
/// else one of the caller's key groups.
async fn group_choice(state: &AppState, user_id: i64, body: &Value) -> ApiResult<Option<Option<i64>>> {
    match body.get("group_id") {
        None => Ok(None),
        Some(Value::Null) => Ok(Some(None)),
        Some(v) => {
            let id = v.as_i64().ok_or_else(|| ApiError::field("group_id", "Expected a key group id or null."))?;
            if db::groups::key_group(&state.db, user_id, id).await?.is_none() {
                return Err(ApiError::field("group_id", "Key group not found."));
            }
            Ok(Some(Some(id)))
        }
    }
}

/// 金鑰換組：舊組與新組授予的裝置都要同步。/ A key changed group: sync the devices of both groups.
async fn move_key(state: &AppState, key_id: i64, group: Option<i64>) -> ApiResult<()> {
    let old = db::groups::set_key_group(&state.db, key_id, group).await?;
    for g in old.into_iter().chain(group) {
        state.device_keys.kick_many(db::groups::key_group_reach(&state.db, g).await?);
    }
    Ok(())
}

async fn own_key(state: &AppState, user_id: i64, id: i64) -> ApiResult<UserKey> {
    db::keys::user_key_by_id(&state.db, user_id, id).await?.ok_or_else(ApiError::drf_not_found)
}

/// 用 russh 解析公鑰：格式、強度（拒收 DSA / 短 RSA）、與既有金鑰重複（不看 comment）。回傳去掉前後空白的那一行。
/// Parse with russh: format, strength and duplicates (ignoring the comment). Returns the trimmed line.
/// `import-user-keys` 也用這個。/ Shared with `telepy-server import-user-keys`.
pub async fn checked_key(db: &Db, raw: &str, except_id: Option<i64>) -> ApiResult<String> {
    let key = raw.trim();
    let parsed = parse_public_key(key).ok_or_else(|| ApiError::field("key", "Invalid SSH public key. Paste a single line such as \"ssh-ed25519 AAAA… user@host\"."))?;
    if let Some(reason) = weak_key_reason(&parsed) {
        return Err(ApiError::field("key", reason));
    }
    let like = like_prefix(&parsed.bare);
    if db::keys::user_key_bare_taken(db, &like, except_id).await? {
        return Err(ApiError::field("key", "user keys with this SSH Key (public) already exists."));
    }
    let service = db::keys::service_keys(db).await?;
    if db::tunnels::by_key_prefix(db, &like).await?.is_some()
        || db::tunnel_keys::tunnel_by_key_prefix(db, &like).await?.is_some()
        || service.iter().any(|s| parse_public_key(&s.key).is_some_and(|p| p.bare == parsed.bare))
    {
        return Err(ApiError::field("key", "This key is already used by a tunnel or by Telepy itself; use a different key."));
    }
    Ok(key.to_string())
}

pub fn validate_full(body: &Value) -> Result<(String, String), ApiError> {
    let mut errors = serde_json::Map::new();
    let name = json_str(body, "host_friendly_name").filter(|s| !s.is_empty());
    let key = json_str(body, "key").filter(|s| !s.is_empty());
    if name.is_none() {
        errors.insert("host_friendly_name".into(), json!(["This field is required."]));
    }
    if key.is_none() {
        errors.insert("key".into(), json!(["This field is required."]));
    }
    if !errors.is_empty() {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, Value::Object(errors)));
    }
    Ok((name.unwrap(), key.unwrap()))
}

/// 驗證過、可以寫進 DB 的新金鑰。/ A new key that passed every check, ready to insert.
pub struct NewKey {
    pub name: String,
    pub key: String,
    pub description: Option<String>,
    /// DB 格式的到期時間。/ Expiry in the DB format.
    pub expires_at: Option<String>,
}

/// 新金鑰的到期時間：沒給 = 站台有上限就用上限，否則不到期。/ A new key's expiry: absent = the site limit when set, else never.
pub async fn new_key_expiry(db: &Db, given: Option<&Value>) -> ApiResult<Option<String>> {
    let max_days = db::settings::get_solo(db).await?.user_key_max_days;
    let now = Utc::now();
    let expires = match given {
        Some(v) => check_expiry(parse_expiry(v).map_err(|m| ApiError::field("expires_at", m))?, now, max_days),
        None if max_days > 0 => Ok(Some(now + Duration::days(max_days))),
        None => Ok(None),
    }
    .map_err(|m| ApiError::field("expires_at", m))?;
    Ok(expires.map(crate::util::db_time))
}

/// `POST /api/reverse/user/keys` 的全部檢查（名稱、公鑰、重複、到期），`import-user-keys` 共用。
/// Every check of `POST /api/reverse/user/keys` (name, key, duplicates, expiry); shared with `import-user-keys`.
pub async fn prepare_new(db: &Db, body: &Value) -> ApiResult<NewKey> {
    let (name, key) = validate_full(body)?;
    let key = checked_key(db, &key, None).await?;
    let description = json_str(body, "description");
    let expires_at = new_key_expiry(db, body.get("expires_at")).await?;
    Ok(NewKey { name, key, description, expires_at })
}

/// 寫入（唯一鍵衝突轉成跟 API 一樣的欄位錯誤）。/ Insert; unique violations become the API's field errors.
pub async fn insert_new(db: &Db, user_id: i64, k: &NewKey) -> ApiResult<UserKey> {
    db::keys::user_key_create(db, user_id, &k.name, &k.key, k.description.as_deref(), k.expires_at.as_deref()).await.map_err(unique_error)
}

#[utoipa::path(post, path = "/api/reverse/user/keys", tag = "Reverse Server Keys", security(("bearer" = [])), request_body = super::schemas::UserKeyWrite, responses((status = 201, body = super::schemas::UserKey), (status = 400, description = "Validation error {field: [message]}", body = Object)))]
async fn create(State(state): State<AppState>, AuthUser(user): AuthUser, AppJson(body): AppJson<Value>) -> ApiResult<(StatusCode, Json<Value>)> {
    let new = prepare_new(&state.db, &body).await?;
    let group = group_choice(&state, user.id, &body).await?;
    let k = insert_new(&state.db, user.id, &new).await?;
    // 放進金鑰群組：那組授予的裝置都會裝上它。/ Into a key group: every device the group is granted to gets it.
    if let Some(Some(g)) = group {
        move_key(&state, k.id, Some(g)).await?;
    }
    state.hub.notify_user(
        user.id,
        &json!({
            "action": "CREATED-USER-KEYS",
            "details": format!("A new user authorized key has been created by {}", user.username),
        }),
    );
    Ok((StatusCode::CREATED, Json(key_reply(&state, &k).await?)))
}

#[utoipa::path(get, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), responses((status = 200, body = super::schemas::UserKey), (status = 404, body = super::schemas::ErrorBody)))]
async fn retrieve(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<Json<Value>> {
    let k = own_key(&state, user.id, id).await?;
    Ok(Json(key_reply(&state, &k).await?))
}

#[utoipa::path(patch, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), request_body = super::schemas::UserKeyPatch, responses((status = 200, body = super::schemas::UserKey), (status = 404, body = super::schemas::ErrorBody)))]
async fn update(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    own_key(&state, user.id, id).await?;
    let group = group_choice(&state, user.id, &body).await?;
    let name = json_str(&body, "host_friendly_name");
    let key = match json_str(&body, "key") {
        Some(k) => Some(checked_key(&state.db, &k, Some(id)).await?),
        None => None,
    };
    let description = body.get("description").map(|v| v.as_str().map(str::to_string));
    // 續期 / 改到期時間（null = 不到期，站台有上限時不行）。/ Renew or change the expiry.
    let expires: Option<Option<String>> = match body.get("expires_at") {
        Some(v) => {
            let max_days = db::settings::get_solo(&state.db).await?.user_key_max_days;
            let t = check_expiry(parse_expiry(v).map_err(|m| ApiError::field("expires_at", m))?, Utc::now(), max_days).map_err(|m| ApiError::field("expires_at", m))?;
            Some(t.map(crate::util::db_time))
        }
        None => None,
    };
    let k = db::keys::user_key_update(
        &state.db,
        id,
        name.as_deref(),
        key.as_deref(),
        description.as_ref().map(|d| d.as_deref()),
        expires.as_ref().map(|e| e.as_deref()),
    )
    .await
    .map_err(unique_error)?;
    if key.is_some() || expires.is_some() {
        // 公鑰換了：裝置上的舊金鑰換成新的。/ New key material: replace it on every device.
        state.device_keys.kick_many(db::device_keys::tunnels_with_key(&state.db, id).await?);
    }
    if let Some(group) = group {
        move_key(&state, id, group).await?;
    }
    Ok(Json(key_reply(&state, &k).await?))
}

#[utoipa::path(put, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), request_body = super::schemas::UserKeyWrite, responses((status = 200, body = super::schemas::UserKey), (status = 404, body = super::schemas::ErrorBody)))]
async fn replace(state: State<AppState>, user: AuthUser, id: Path<i64>, body: AppJson<Value>) -> ApiResult<Json<Value>> {
    update(state, user, id, body).await
}

#[utoipa::path(delete, path = "/api/reverse/user/keys/{id}", tag = "Reverse Server Keys", security(("bearer" = [])), params(("id" = i64, Path, description = "Key id")), responses((status = 204, description = "Deleted"), (status = 404, body = super::schemas::ErrorBody)))]
async fn destroy(State(state): State<AppState>, AuthUser(user): AuthUser, Path(id): Path<i64>) -> ApiResult<StatusCode> {
    own_key(&state, user.id, id).await?;
    // 先記下用到它的裝置：刪掉之後由同步把它從那些裝置移除。/ Devices that must drop this key.
    let tunnels = db::device_keys::tunnels_with_key(&state.db, id).await?;
    db::device_keys::delete_entries_for_key(&state.db, id).await?;
    db::groups::forget_key(&state.db, id).await?;
    db::keys::user_key_delete(&state.db, id).await?;
    state.device_keys.kick_many(tunnels);
    state.hub.notify_user(
        user.id,
        &json!({
            "action": "DELETED-USER-KEYS",
            "details": format!("An user authorized key has been deleted by {}", user.username),
        }),
    );
    Ok(StatusCode::NO_CONTENT)
}
