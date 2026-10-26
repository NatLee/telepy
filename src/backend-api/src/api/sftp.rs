//! `/api/sftp/{shell,list,download,upload}/{id}/{username}`（web_sftp app），改走原生 SFTP：
//! 下載串流、目錄打包、上傳串流；沒有 `shell=True`、沒有把使用者路徑拼進指令。

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use axum::body::Body as RawBody;
use russh_sftp::client::error::Error as SftpError;

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::sftp::{self, ops};
use crate::ssh::pool::PooledSftp;
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(shell))
        .routes(routes!(list))
        .routes(routes!(download))
        .routes(routes!(upload))
        .routes(routes!(mkdir))
        .routes(routes!(touch))
        .routes(routes!(rename))
        .routes(routes!(delete))
        .routes(routes!(chmod))
        .routes(routes!(copy))
        .routes(routes!(stat))
        .routes(routes!(zip))
        .routes(routes!(read_text, save_text))
        .layer(DefaultBodyLimit::disable())
}

/// 權限：VIEW（否則 404）+ 敏感隧道的 step-up（否則 403）+ username 在允許清單（否則 400），與 Django 版訊息相同。
async fn access(state: &AppState, user_id: i64, id: i64, username: &str, headers: &HeaderMap) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Reverse server keys not found"))?;
    if !permissions::check_access(&state.db, user_id, &t, Permission::View).await? {
        return Err(ApiError::not_found("Reverse server keys not found"));
    }
    super::step_up::check(state, user_id, &t, headers)?;
    let allowed = permissions::allowed_usernames(&state.db, user_id, &t).await?;
    if !allowed.iter().any(|u| u.username == username) {
        return Err(ApiError::bad_request("Username not found"));
    }
    Ok(t)
}

/// 共用連線池借一條 SFTP channel（同一台、同一個 OS 帳號只握手一次）。
async fn connect(state: &AppState, username: &str, t: &Tunnel) -> ApiResult<PooledSftp> {
    state.pool.sftp(state, t.reverse_port, username).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

#[utoipa::path(get, path = "/api/sftp/shell/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), responses((status = 200, body = super::schemas::SftpShell), (status = 400, description = "Username not allowed or device unreachable", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn shell(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>) -> ApiResult<Json<Value>> {
    let t = access(&state, user.id, id, &username, &headers).await?;
    let sftp = connect(&state, &username, &t).await?;
    Ok(Json(json!({ "shell": sftp::detect_shell(&sftp).await })))
}

#[utoipa::path(get, path = "/api/sftp/list/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = Option<String>, Query, description = "Directory; default ~/ (unix) or C:\\ (Windows)")), responses((status = 200, body = super::schemas::SftpListing), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let t = access(&state, user.id, id, &username, &headers).await?;
    let sftp = connect(&state, &username, &t).await?;
    let home = sftp::home(&sftp).await;
    let shell = if sftp::is_windows_home(&home) { "powershell" } else { "unix" };
    let raw = q.get("path").cloned().unwrap_or_else(|| if shell == "powershell" { "C:\\".into() } else { "~/".into() });
    let path = sftp::resolve_path(&raw, &home);
    let entries = sftp::list_dir(&sftp, &path).await.map_err(|e| ApiError::not_found(e.to_string()))?;
    let tz = state.config.tz_offset_minutes;
    Ok(Json(json!({
        "shell": shell,
        "total": entries.len(),
        "path": path,
        "files": entries.iter().map(|e| sftp::rest_entry_json(e, tz)).collect::<Vec<_>>(),
    })))
}

#[utoipa::path(get, path = "/api/sftp/download/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = String, Query, description = "File or directory (directories are zipped)")), responses((status = 200, description = "Streamed file (application/octet-stream) or zip (application/zip) with Content-Disposition", content_type = "application/octet-stream"), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn download(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let t = access(&state, user.id, id, &username, &headers).await?;
    let raw = q.get("path").cloned().filter(|p| !p.is_empty()).ok_or_else(|| ApiError::bad_request("path is required"))?;
    let sftp = connect(&state, &username, &t).await?;
    let home = sftp::home(&sftp).await;
    let path = sftp::resolve_path(&raw, &home);
    let name = sftp::basename(&path);
    let meta = sftp.metadata(&path).await.map_err(|_| ApiError::bad_request("Failed to download file or directory"))?;
    if meta.is_dir() {
        let tmp = sftp::zip_directory(&sftp, &path).await.map_err(|e| {
            tracing::warn!(error = %e, "zip download failed");
            ApiError::bad_request("Failed to download file or directory")
        })?;
        let file = tokio::fs::File::open(tmp.path()).await.map_err(|e| ApiError::internal(e.to_string()))?;
        let len = file.metadata().await.ok().map(|m| m.len());
        let body = Body::from_stream(ReaderStream::new(file));
        let mut resp = Response::new(body);
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
        resp.headers_mut().insert(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}.zip\"").parse().unwrap());
        if let Some(l) = len {
            resp.headers_mut().insert(header::CONTENT_LENGTH, l.to_string().parse().unwrap());
        }
        // 暫存檔在串流結束後刪除。/ Keep the temp file alive until the stream finishes.
        tokio::spawn(async move {
            tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
            drop(tmp);
        });
        Ok(resp)
    } else {
        let file = sftp.open(&path).await.map_err(|_| ApiError::bad_request("Failed to download file or directory"))?;
        // SFTP channel（與它的 lease）要活到串流結束。/ Keep the SFTP channel for the duration of the stream.
        let stream = ReaderStream::new(file);
        // fuse：壓縮層（br / gzip）在串流結束後還會再 poll 一次，沒 fuse 的 unfold 會 panic、連線被砍（瀏覽器下載卡住）。
        // fuse: the compression layer polls once more after the end; an unfused unfold panics and the download hangs.
        use futures::StreamExt;
        let guarded = futures::stream::unfold((stream, Some(sftp)), |(mut s, guard)| async move {
            match s.next().await {
                Some(item) => Some((item, (s, guard))),
                None => {
                    drop(guard);
                    None
                }
            }
        })
        .fuse();
        let mut resp = Response::new(Body::from_stream(guarded));
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert(header::CONTENT_TYPE, "application/octet-stream".parse().unwrap());
        resp.headers_mut().insert(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"").parse().unwrap());
        resp.headers_mut().insert(header::CONTENT_LENGTH, meta.len().to_string().parse().unwrap());
        Ok(resp)
    }
}

#[utoipa::path(post, path = "/api/sftp/upload/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("destination_path" = String, Query, description = "Directory (file keeps its name) or full target path")), request_body(content = super::schemas::UploadForm, content_type = "multipart/form-data"), responses((status = 200, body = super::schemas::UploadResult), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn upload(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let t = access(&state, user.id, id, &username, &headers).await?;
    let Some(destination) = q.get("destination_path").cloned().filter(|p| !p.is_empty()) else {
        return Err(ApiError::bad_request("File and destination path required"));
    };
    let sftp = connect(&state, &username, &t).await?;
    let home = sftp::home(&sftp).await;
    let dest = sftp::resolve_path(&destination, &home);
    // multipart 的 Field 借用 Multipart，所以在迴圈內直接串流寫入。/ Stream the field inside the loop.
    while let Ok(Some(mut field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().map(str::to_string).unwrap_or_else(|| "upload".to_string());
        let target = sftp::upload_target(&sftp, &dest, &filename).await;
        let mut file = sftp.create(&target).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
        while let Some(chunk) = field.chunk().await.map_err(|e| ApiError::bad_request(e.to_string()))? {
            file.write_all(&chunk).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
        }
        file.shutdown().await.map_err(|e| ApiError::bad_request(e.to_string()))?;
        return Ok(Json(json!({ "success": "File uploaded successfully" })));
    }
    Err(ApiError::bad_request("File and destination path required"))
}

#[allow(dead_code)]
fn _unused() -> impl IntoResponse {
    StatusCode::OK
}

// ---------------------------------------------------------------- 檔案操作 / file operations

/// `{error, code}`（前端對應 `files.err.<code>`）。/ `{error, code}`, mapped to `files.err.<code>` in the UI.
fn coded(status: StatusCode, code: &str, msg: impl Into<String>) -> ApiError {
    ApiError::new(status, json!({ "error": msg.into(), "code": code }))
}

fn sftp_error(e: &SftpError, what: &str) -> ApiError {
    let (status, code) = ops::classify(e);
    coded(StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_REQUEST), code, format!("{what}: {e}"))
}

/// 一次操作要的東西：隧道、共用 SFTP、家目錄。/ What one operation needs.
struct Op {
    t: Tunnel,
    username: String,
    by: String,
    sftp: PooledSftp,
    home: String,
}

impl Op {
    async fn open(state: &AppState, user: &crate::db::users::User, id: i64, username: &str, headers: &HeaderMap) -> ApiResult<Self> {
        let t = access(state, user.id, id, username, headers).await?;
        let sftp = state.pool.sftp(state, t.reverse_port, username).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device", format!("{e:#}")))?;
        let home = sftp::home(&sftp).await;
        Ok(Self { t, username: username.to_string(), by: user.username.clone(), sftp, home })
    }

    /// 前端送來的路徑 → SFTP 路徑；空的回 400。/ Resolve a client path; empty = 400.
    fn path(&self, raw: Option<&str>) -> ApiResult<String> {
        let raw = raw.map(str::trim).filter(|p| !p.is_empty()).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "path_required", "path is required"))?;
        Ok(sftp::resolve_path(raw, &self.home))
    }

    fn paths(&self, body: &Value) -> ApiResult<Vec<String>> {
        let list = body.get("paths").and_then(Value::as_array).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "path_required", "paths is required"))?;
        if list.is_empty() || list.len() > MAX_BATCH {
            return Err(coded(StatusCode::BAD_REQUEST, "path_required", format!("send 1–{MAX_BATCH} paths")));
        }
        list.iter().map(|p| self.path(p.as_str())).collect()
    }

    /// 根目錄、磁碟機根目錄、家目錄不能刪 / 搬。/ The root, a drive root and the home folder are protected.
    fn protected(&self, path: &str) -> bool {
        let p = path.trim_end_matches('/');
        p.is_empty() || p == self.home.trim_end_matches('/') || (sftp::is_windows_home(p) && p.len() <= 3)
    }

    async fn event(&self, state: &AppState, kind: &str, message: String) {
        state.gateway.event(kind, None, u16::try_from(self.t.reverse_port).ok(), Some(self.t.id), message).await;
    }
}

/// 一次最多處理幾個路徑。/ Paths per batch request.
const MAX_BATCH: usize = 500;

fn failure(path: &str, e: &ApiError) -> Value {
    json!({ "path": path, "code": e.body.get("code").cloned().unwrap_or(Value::Null), "error": e.body.get("error").cloned().unwrap_or(Value::Null) })
}

/// 日誌裡列出的路徑（前 5 個，其餘「and N more」）。/ Paths named in the log line.
pub fn path_summary(paths: &[String]) -> String {
    let shown: Vec<&str> = paths.iter().take(5).map(String::as_str).collect();
    let rest = paths.len().saturating_sub(shown.len());
    if rest > 0 {
        format!("{} and {rest} more", shown.join(", "))
    } else {
        shown.join(", ")
    }
}

fn str_field<'a>(body: &'a Value, key: &str) -> Option<&'a str> {
    body.get(key).and_then(Value::as_str)
}

/// 新名字（路徑的最後一段）要合法。/ The last component of a new path must be a valid name.
fn check_name(path: &str) -> ApiResult<()> {
    if ops::valid_name(&sftp::basename(path)) {
        Ok(())
    } else {
        Err(coded(StatusCode::BAD_REQUEST, "invalid_name", "That name can't be used"))
    }
}

async fn must_not_exist(op: &Op, path: &str) -> ApiResult<()> {
    match ops::exists(&op.sftp, path).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(coded(StatusCode::CONFLICT, "exists", format!("{path} already exists"))),
        Err(e) => Err(sftp_error(&e, "stat")),
    }
}

#[utoipa::path(post, path = "/api/sftp/mkdir/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpPathRequest, responses((status = 200, body = super::schemas::SftpPathResult), (status = 400, description = "code = path_required | invalid_name | failed", body = super::schemas::SftpError), (status = 403, description = "code = permission_denied (the device account may not write there) | step_up_required", body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError), (status = 409, description = "code = exists", body = super::schemas::SftpError)))]
async fn mkdir(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let path = op.path(str_field(&body, "path"))?;
    check_name(&path)?;
    must_not_exist(&op, &path).await?;
    op.sftp.create_dir(path.as_str()).await.map_err(|e| sftp_error(&e, "mkdir"))?;
    Ok(Json(json!({ "path": path })))
}

#[utoipa::path(post, path = "/api/sftp/touch/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpPathRequest, responses((status = 200, body = super::schemas::SftpPathResult), (status = 400, body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError), (status = 409, description = "code = exists (never truncates an existing file)", body = super::schemas::SftpError)))]
async fn touch(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let path = op.path(str_field(&body, "path"))?;
    check_name(&path)?;
    must_not_exist(&op, &path).await?;
    ops::touch(&op.sftp, &path).await.map_err(|e| sftp_error(&e, "create"))?;
    Ok(Json(json!({ "path": path })))
}

/// 搬一個：目標不能已存在（SFTP rename 本來就不覆蓋）、資料夾不能搬進自己。/ Move one entry.
async fn move_one(op: &Op, from: &str, to: &str) -> ApiResult<()> {
    if op.protected(from) {
        return Err(coded(StatusCode::BAD_REQUEST, "protected", format!("{from} can't be moved")));
    }
    check_name(to)?;
    if from.trim_end_matches('/') == to.trim_end_matches('/') {
        return Ok(());
    }
    if ops::is_within(to, from) {
        return Err(coded(StatusCode::BAD_REQUEST, "into_itself", "A folder can't go inside itself"));
    }
    must_not_exist(op, to).await?;
    op.sftp.rename(from, to).await.map_err(|e| sftp_error(&e, "rename"))
}

#[utoipa::path(post, path = "/api/sftp/rename/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpRenameRequest, responses((status = 200, description = "{path} for a rename, {moved, failed} for a move", body = super::schemas::SftpBatchResult), (status = 400, description = "code = invalid_name | into_itself | protected", body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError), (status = 409, description = "code = exists (nothing is overwritten)", body = super::schemas::SftpError)))]
async fn rename(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    if body.get("paths").is_some() {
        let paths = op.paths(&body)?;
        let dest = op.path(str_field(&body, "destination"))?;
        let (mut moved, mut failed) = (0, Vec::new());
        for from in &paths {
            match move_one(&op, from, &ops::join(&dest, &sftp::basename(from))).await {
                Ok(()) => moved += 1,
                Err(e) => failed.push(failure(from, &e)),
            }
        }
        return Ok(Json(json!({ "moved": moved, "failed": failed, "destination": dest })));
    }
    let from = op.path(str_field(&body, "from"))?;
    let to = op.path(str_field(&body, "to"))?;
    move_one(&op, &from, &to).await?;
    Ok(Json(json!({ "path": to })))
}

#[utoipa::path(post, path = "/api/sftp/delete/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("count" = Option<String>, Query, description = "1 = dry run: count what would be deleted")), request_body = super::schemas::SftpPathsRequest, responses((status = 200, description = "Dry run: {files, dirs, links, bytes, entries, truncated}; otherwise {removed, failed}", body = super::schemas::SftpDeleteResult), (status = 400, description = "code = path_required | protected", body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError)))]
async fn delete(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    AppJson(body): AppJson<Value>,
) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let paths = op.paths(&body)?;
    if let Some(p) = paths.iter().find(|p| op.protected(p)) {
        return Err(coded(StatusCode::BAD_REQUEST, "protected", format!("{p} can't be deleted")));
    }
    if q.get("count").is_some_and(|c| c == "1" || c == "true") {
        let mut total = ops::Tally::default();
        for p in &paths {
            let t = ops::count_tree(&op.sftp, p).await.map_err(|e| sftp_error(&e, p))?;
            total.files += t.files;
            total.dirs += t.dirs;
            total.links += t.links;
            total.bytes += t.bytes;
            total.truncated |= t.truncated;
        }
        return Ok(Json(json!({
            "files": total.files, "dirs": total.dirs, "links": total.links, "bytes": total.bytes,
            "entries": total.entries(), "truncated": total.truncated,
        })));
    }
    let (mut removed, mut failed, mut gone) = (0u64, Vec::new(), Vec::new());
    for p in &paths {
        match ops::remove_tree(&op.sftp, p).await {
            Ok(n) => {
                removed += n;
                gone.push(p.clone());
            }
            Err((e, n)) => {
                removed += n;
                failed.push(failure(p, &sftp_error(&e, "delete")));
            }
        }
    }
    if removed > 0 {
        // 只記路徑與數量，不記內容。/ Paths and counts only, never content.
        let what = if gone.is_empty() { path_summary(&paths) } else { path_summary(&gone) };
        op.event(&state, "files_delete", format!("{} deleted {removed} entr{} as {}: {what}", op.by, if removed == 1 { "y" } else { "ies" }, op.username)).await;
    }
    Ok(Json(json!({ "removed": removed, "failed": failed })))
}

#[utoipa::path(post, path = "/api/sftp/chmod/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpChmodRequest, responses((status = 200, body = super::schemas::SftpBatchResult), (status = 400, description = "code = invalid_mode | path_required", body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError)))]
async fn chmod(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let paths = op.paths(&body)?;
    let mode = str_field(&body, "mode").and_then(ops::parse_mode).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "invalid_mode", "mode must be octal, like 644 or 0755"))?;
    let recursive = body.get("recursive").and_then(Value::as_bool).unwrap_or(false);
    let (mut changed, mut failed) = (0u64, Vec::new());
    for p in &paths {
        match ops::chmod_tree(&op.sftp, p, mode, recursive).await {
            Ok(n) => changed += n,
            Err(e) => failed.push(failure(p, &sftp_error(&e, "chmod"))),
        }
    }
    Ok(Json(json!({ "changed": changed, "mode": ops::mode_octal(mode), "failed": failed })))
}

/// 在裝置上跑 `cp -R`。`Ok(None)` = 裝置跑不了（沒有 shell / `cp`，exec 被拒），改用串流。
/// Run `cp -R` on the device; `Ok(None)` = the device can't (no shell / cp, exec refused): stream instead.
async fn device_copy(state: &AppState, op: &Op, from: &str, to: &str) -> Option<ApiResult<()>> {
    let ran = async {
        let (_lease, channel) = state.pool.session_channel(state, op.t.reverse_port, &op.username).await?;
        crate::ssh::exec::run_on(channel, &ops::cp_command(from, to), COPY_TIMEOUT, 16 * 1024).await
    };
    match ran.await {
        Err(e) => {
            tracing::info!(error = format!("{e:#}"), "file copy: exec unavailable, streaming instead");
            None
        }
        Ok(r) if r.timed_out => Some(Err(coded(StatusCode::GATEWAY_TIMEOUT, "timeout", "The copy took too long and was stopped"))),
        // 127 = 找不到指令（沒有 cp，或根本不是 shell）。/ 127 = command not found.
        Ok(r) if r.exit_code == Some(127) => None,
        Ok(r) if r.exit_code == Some(0) => Some(Ok(())),
        Ok(r) => Some(Err(coded(StatusCode::BAD_REQUEST, "failed", format!("cp: {}", r.stderr.text.trim())))),
    }
}

const COPY_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(300);

async fn copy_one(state: &AppState, op: &Op, from: &str, dest: &str, method: &mut &'static str) -> ApiResult<()> {
    let to = ops::join(dest, &sftp::basename(from));
    if ops::is_within(&to, from) {
        return Err(coded(StatusCode::BAD_REQUEST, "into_itself", "A folder can't be copied inside itself"));
    }
    must_not_exist(op, &to).await?;
    if !sftp::is_windows_home(&op.home) {
        if let Some(done) = device_copy(state, op, from, &to).await {
            return done;
        }
    }
    let size = ops::count_tree(&op.sftp, from).await.map_err(|e| sftp_error(&e, "copy"))?;
    if size.truncated || size.bytes > ops::STREAM_COPY_LIMIT {
        return Err(coded(StatusCode::BAD_REQUEST, "too_large", format!("Copying through Telepy is limited to {} MB", ops::STREAM_COPY_LIMIT / 1024 / 1024)));
    }
    *method = "stream";
    ops::stream_copy(&op.sftp, from, &to).await.map(|_| ()).map_err(|e| sftp_error(&e, "copy"))
}

#[utoipa::path(post, path = "/api/sftp/copy/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpMoveRequest, responses((status = 200, description = "method = device (cp -R on the device) | stream (through Telepy, ≤ 256 MB)", body = super::schemas::SftpBatchResult), (status = 400, body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError)))]
async fn copy(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let paths = op.paths(&body)?;
    let dest = op.path(str_field(&body, "destination"))?;
    let (mut copied, mut failed, mut method) = (0, Vec::new(), "device");
    for from in &paths {
        match copy_one(&state, &op, from, &dest, &mut method).await {
            Ok(()) => copied += 1,
            Err(e) => failed.push(failure(from, &e)),
        }
    }
    Ok(Json(json!({ "copied": copied, "method": method, "failed": failed, "destination": dest })))
}

#[utoipa::path(post, path = "/api/sftp/zip/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpPathsRequest, responses((status = 200, description = "application/zip with every path at the top level (folders whole)", content_type = "application/zip"), (status = 400, body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError)))]
async fn zip(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Response> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let paths = op.paths(&body)?;
    let tmp = sftp::zip_paths(&op.sftp, &paths).await.map_err(|e| {
        tracing::warn!(error = %e, "zip download failed");
        coded(StatusCode::BAD_REQUEST, "failed", "Failed to download file or directory")
    })?;
    let name = if paths.len() == 1 { sftp::basename(&paths[0]) } else { sftp::basename(&ops::parent(&paths[0])) };
    let name = if name.is_empty() || name == "/" { "files".to_string() } else { name };
    let file = tokio::fs::File::open(tmp.path()).await.map_err(|e| ApiError::internal(e.to_string()))?;
    let len = file.metadata().await.ok().map(|m| m.len());
    let mut resp = Response::new(Body::from_stream(ReaderStream::new(file)));
    resp.headers_mut().insert(header::CONTENT_TYPE, "application/zip".parse().unwrap());
    let disposition = format!("attachment; filename=\"{}.zip\"", name.replace(['"', '\\', '\r', '\n'], "_"));
    if let Ok(v) = disposition.parse() {
        resp.headers_mut().insert(header::CONTENT_DISPOSITION, v);
    }
    if let Some(l) = len {
        resp.headers_mut().insert(header::CONTENT_LENGTH, l.to_string().parse().unwrap());
    }
    // 暫存檔在串流結束後刪除。/ Keep the temp file alive until the stream finishes.
    tokio::spawn(async move {
        tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
        drop(tmp);
    });
    Ok(resp)
}

fn epoch_iso(t: Option<u32>) -> Value {
    t.and_then(|t| chrono::DateTime::from_timestamp(i64::from(t), 0)).map(|d| json!(d.to_rfc3339_opts(chrono::SecondsFormat::Secs, true))).unwrap_or(Value::Null)
}

fn kind_name(m: &russh_sftp::protocol::FileAttributes) -> &'static str {
    if m.is_symlink() {
        "symlink"
    } else if m.is_dir() {
        "directory"
    } else {
        "file"
    }
}

#[utoipa::path(get, path = "/api/sftp/stat/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = String, Query, description = "File, folder or link (not followed)")), responses((status = 200, body = super::schemas::SftpStat), (status = 404, body = super::schemas::SftpError)))]
async fn stat(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let path = op.path(q.get("path").map(String::as_str))?;
    let m = op.sftp.symlink_metadata(path.as_str()).await.map_err(|e| sftp_error(&e, "stat"))?;
    let (mut link_target, mut target_type) = (Value::Null, Value::Null);
    if m.is_symlink() {
        link_target = op.sftp.read_link(path.as_str()).await.map(Value::String).unwrap_or(Value::Null);
        target_type = json!(match op.sftp.metadata(path.as_str()).await {
            Ok(t) => kind_name(&t),
            Err(_) => "missing",
        });
    }
    let mode = m.permissions.unwrap_or(0);
    Ok(Json(json!({
        "path": path,
        "name": sftp::basename(&path),
        "type": kind_name(&m),
        "size": m.size.unwrap_or(0),
        "mode": ops::mode_octal(mode),
        "permissions": sftp::mode_string(mode, m.is_dir(), m.is_symlink()),
        "uid": m.uid,
        "gid": m.gid,
        "mtime": epoch_iso(m.mtime),
        "mtime_epoch": m.mtime,
        "atime": epoch_iso(m.atime),
        "link_target": link_target,
        "target_type": target_type,
    })))
}

#[utoipa::path(get, path = "/api/sftp/text/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = String, Query, description = "Text file (≤ 1 MiB, UTF-8, no NUL in the first 8 KiB)")), responses((status = 200, body = super::schemas::SftpText), (status = 400, description = "code = is_directory | too_large | binary | not_utf8", body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError)))]
async fn read_text(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let path = op.path(q.get("path").map(String::as_str))?;
    let m = op.sftp.metadata(path.as_str()).await.map_err(|e| sftp_error(&e, "stat"))?;
    if m.is_dir() {
        return Err(coded(StatusCode::BAD_REQUEST, "is_directory", "That is a folder"));
    }
    let size = m.size.unwrap_or(0);
    if size > ops::TEXT_LIMIT {
        return Err(ApiError::new(StatusCode::BAD_REQUEST, json!({ "error": "The file is larger than 1 MiB", "code": "too_large", "size": size, "limit": ops::TEXT_LIMIT })));
    }
    let data = ops::read_all(&op.sftp, &path, ops::TEXT_LIMIT).await.map_err(|e| sftp_error(&e, "read"))?;
    if data.len() as u64 > ops::TEXT_LIMIT {
        return Err(coded(StatusCode::BAD_REQUEST, "too_large", "The file is larger than 1 MiB"));
    }
    if ops::is_binary(&data) {
        return Err(coded(StatusCode::BAD_REQUEST, "binary", "This looks like a binary file"));
    }
    let content = String::from_utf8(data).map_err(|_| coded(StatusCode::BAD_REQUEST, "not_utf8", "The file is not UTF-8 text"))?;
    Ok(Json(json!({
        "path": path,
        "name": sftp::basename(&path),
        "size": size,
        "mtime_epoch": m.mtime,
        "mode": ops::mode_octal(m.permissions.unwrap_or(0)),
        "content": content,
    })))
}

/// 用暫存檔原子取代 `target`：有 `posix-rename@openssh.com` 就用它（在連線池同一條連線上開一條短命的 sftp
/// channel 送這個擴充請求 —— 高階 `SftpSession` 不開放擴充請求）；沒有就「原檔改名備份 → 暫存檔改名 → 刪備份」。
/// Replace `target` with `tmp` atomically: `posix-rename@openssh.com` when the device's sftp-server has it (sent on a
/// short-lived raw sftp channel of the same pooled connection, as the high-level session exposes no extended
/// requests); otherwise backup → rename → remove the backup, restoring the backup on failure.
async fn replace_file(state: &AppState, op: &Op, tmp: &str, target: &str) -> Result<(), SftpError> {
    match posix_rename(state, op, tmp, target).await {
        Ok(true) => return Ok(()),
        Ok(false) => {}
        Err(e) => tracing::info!(error = format!("{e:#}"), "file save: posix-rename unavailable, using the backup swap"),
    }
    let bak = ops::backup_path(target, &crate::util::random_alnum(8).to_lowercase());
    op.sftp.rename(target, bak.as_str()).await?;
    if let Err(e) = op.sftp.rename(tmp, target).await {
        let _ = op.sftp.rename(bak.as_str(), target).await;
        return Err(e);
    }
    let _ = op.sftp.remove_file(bak).await;
    Ok(())
}

/// `Ok(false)` = 裝置不支援這個擴充。/ `Ok(false)` = the extension is not offered.
async fn posix_rename(state: &AppState, op: &Op, tmp: &str, target: &str) -> anyhow::Result<bool> {
    use russh_sftp::protocol::{Packet, StatusCode as Sc};
    const POSIX_RENAME: &str = "posix-rename@openssh.com";
    let (_lease, channel) = state.pool.session_channel(state, op.t.reverse_port, &op.username).await?;
    channel.request_subsystem(true, "sftp").await?;
    let raw = russh_sftp::client::RawSftpSession::new(channel.into_stream());
    raw.set_timeout(10);
    let version = raw.init().await?;
    if !version.extensions.get(POSIX_RENAME).is_some_and(|v| v == "1") {
        return Ok(false);
    }
    let mut data = Vec::new();
    for s in [tmp, target] {
        data.extend_from_slice(&(s.len() as u32).to_be_bytes());
        data.extend_from_slice(s.as_bytes());
    }
    match raw.extended(POSIX_RENAME, data).await? {
        Packet::Status(s) if s.status_code == Sc::Ok => Ok(true),
        Packet::Status(s) => Err(SftpError::Status(s).into()),
        _ => anyhow::bail!("posix-rename: unexpected reply"),
    }
}

/// 存檔請求的 body 上限（內容 1 MiB，JSON 跳脫後可能變大）。/ Body cap for a save (escaping can grow it).
const SAVE_BODY_LIMIT: usize = 8 * 1024 * 1024;

#[utoipa::path(put, path = "/api/sftp/text/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpSaveRequest, responses((status = 200, body = super::schemas::SftpText), (status = 400, description = "code = too_large | path_required", body = super::schemas::SftpError), (status = 403, description = "code = permission_denied | dir_not_writable (saves go through a temp file next to it)", body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError), (status = 409, description = "code = modified (the file changed on the device since it was opened; carries its mtime / size)", body = super::schemas::SftpError)))]
async fn save_text(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, body: RawBody) -> ApiResult<Json<Value>> {
    let bytes = axum::body::to_bytes(body, SAVE_BODY_LIMIT).await.map_err(|_| coded(StatusCode::BAD_REQUEST, "too_large", "The file is larger than 1 MiB"))?;
    let body: Value = serde_json::from_slice(&bytes).map_err(|e| ApiError::detail(StatusCode::BAD_REQUEST, format!("JSON parse error - {e}")))?;
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let raw = op.path(str_field(&body, "path"))?;
    let content = str_field(&body, "content").ok_or_else(|| coded(StatusCode::BAD_REQUEST, "content_required", "content is required"))?;
    if content.len() as u64 > ops::TEXT_LIMIT {
        return Err(coded(StatusCode::BAD_REQUEST, "too_large", "The file is larger than 1 MiB"));
    }
    // symlink：改它指到的檔案（取代連結本身會把連結變成一般檔案）。/ Edit a link's target, never replace the link.
    let target = op.sftp.canonicalize(raw.as_str()).await.map_err(|e| sftp_error(&e, "open"))?;
    let m = op.sftp.metadata(target.as_str()).await.map_err(|e| sftp_error(&e, "stat"))?;
    if m.is_dir() {
        return Err(coded(StatusCode::BAD_REQUEST, "is_directory", "That is a folder"));
    }
    let force = body.get("force").and_then(Value::as_bool).unwrap_or(false);
    let expected_mtime = body.get("mtime").and_then(Value::as_u64);
    let expected_size = body.get("size").and_then(Value::as_u64);
    let changed = expected_mtime.is_some_and(|t| Some(t) != m.mtime.map(u64::from)) || expected_size.is_some_and(|s| s != m.size.unwrap_or(0));
    if changed && !force {
        return Err(ApiError::new(
            StatusCode::CONFLICT,
            json!({ "error": "The file changed on the device since you opened it", "code": "modified", "mtime_epoch": m.mtime, "size": m.size }),
        ));
    }
    let mode = m.permissions.unwrap_or(0o644) & 0o7777;
    let tmp = ops::temp_path(&target, &crate::util::random_alnum(8).to_lowercase());
    if let Err(e) = ops::write_new(&op.sftp, &tmp, content.as_bytes(), mode).await {
        let _ = op.sftp.remove_file(tmp.as_str()).await;
        return Err(match ops::classify(&e) {
            (403, _) => coded(StatusCode::FORBIDDEN, "dir_not_writable", format!("{} can't create files in {}", op.username, ops::parent(&target))),
            _ => sftp_error(&e, "save"),
        });
    }
    if let Err(e) = replace_file(&state, &op, &tmp, &target).await {
        let _ = op.sftp.remove_file(tmp.as_str()).await;
        return Err(sftp_error(&e, "save"));
    }
    let after = op.sftp.metadata(target.as_str()).await.map_err(|e| sftp_error(&e, "stat"))?;
    op.event(&state, "files_edit", format!("{} edited {target} as {} ({})", op.by, op.username, crate::ws::filemanager::format_size(content.len() as f64))).await;
    Ok(Json(json!({
        "path": target,
        "name": sftp::basename(&target),
        "size": after.size.unwrap_or(0),
        "mtime_epoch": after.mtime,
        "mode": ops::mode_octal(after.permissions.unwrap_or(mode)),
    })))
}
