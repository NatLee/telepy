//! `/api/sftp/{shell,list,download,upload}/{id}/{username}`（web_sftp app），改走原生 SFTP：
//! 下載串流、目錄邊打包邊送（`sftp::zipstream`）、上傳串流；沒有 `shell=True`、沒有把使用者路徑拼進指令。
//! 網頁的下載走一次性連結（`download-link` → `fetch`，瀏覽器自己下載），上傳分段（`upload-part`：每段一個請求，
//! 前面的代理（Cloudflare 100 MB、逾時）不會卡住大檔，失敗的那段重送就好；完成才改名成目標）。
//! The web downloads through one-time links (the browser downloads natively) and uploads in parts (one request per
//! part, so proxies' body limits and timeouts never see a big file; a failed part is resent; the file is renamed
//! onto the target only when complete).

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, HeaderMap, HeaderValue, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::Json;
use futures::StreamExt;
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::{AsyncReadExt, AsyncSeekExt, AsyncWriteExt};
use tokio_util::io::ReaderStream;

use axum::body::Body as RawBody;
use russh_sftp::client::error::Error as SftpError;

use super::AppJson;
use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::sftp::links::{self, Link};
use crate::db::upload_parts::{self, NewPart, PartRow};
use crate::sftp::ops::{self, PartStep};
use crate::uploads::{self, Resume};
use crate::sftp;
use crate::sftp::target::{Bulk, Shared, Target};
use crate::state::AppState;
use utoipa_axum::{router::OpenApiRouter, routes};

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new()
        .routes(routes!(shell))
        .routes(routes!(list))
        .routes(routes!(download))
        .routes(routes!(download_link))
        .routes(routes!(fetch))
        .routes(routes!(upload))
        .routes(routes!(upload_start))
        .routes(routes!(upload_part, upload_part_cancel))
        .routes(routes!(unfinished_uploads))
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
/// 帳號位置是 `~<代號>` = 這個人開的區網檔案 session（`lan::files`）：還在、屬於這條隧道、經過的裝置帳號還允許、
/// 「網路」功能還開著（否則 404 `lan_files_gone` / 403）。
/// Access: VIEW + step-up + an allowed account. `~<id>` = this person's LAN file session: still open, on this tunnel,
/// its device account still allowed and the network feature on.
async fn access(state: &AppState, user: &crate::db::users::User, id: i64, username: &str, headers: &HeaderMap) -> ApiResult<(Tunnel, Target)> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Reverse server keys not found"))?;
    if !permissions::check_access(&state.db, user.id, &t, Permission::View).await? {
        return Err(ApiError::not_found("Reverse server keys not found"));
    }
    super::step_up::check(state, user.id, &t, headers)?;
    let target = Target::of(state, user.id, t.reverse_port, username).filter(|g| g.lan().is_none_or(|f| f.tunnel_id == t.id)).ok_or_else(lan_gone)?;
    let account = match &target {
        Target::Device { username, .. } => username.clone(),
        Target::Lan(f) => {
            crate::features::check(state, user, crate::features::Feature::Network).await?;
            f.account.clone()
        }
    };
    let allowed = permissions::allowed_usernames(&state.db, user.id, &t).await?;
    if !allowed.iter().any(|u| u.username == account) {
        return Err(ApiError::bad_request("Username not found"));
    }
    Ok((t, target))
}

fn lan_gone() -> ApiError {
    coded(StatusCode::NOT_FOUND, "lan_files_gone", "This LAN host's file session has ended; open its files again")
}

/// 共用連線池借一條 SFTP channel（同一台、同一個 OS 帳號只握手一次；區網主機 = 它那個 session 的）。
async fn connect(state: &AppState, target: &Target) -> ApiResult<Shared> {
    target.sftp(state).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

#[utoipa::path(get, path = "/api/sftp/shell/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), responses((status = 200, body = super::schemas::SftpShell), (status = 400, description = "Username not allowed or device unreachable", body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn shell(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>) -> ApiResult<Json<Value>> {
    let (_t, target) = access(&state, &user, id, &username, &headers).await?;
    let sftp = connect(&state, &target).await?;
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
    let (_t, target) = access(&state, &user, id, &username, &headers).await?;
    let sftp = connect(&state, &target).await?;
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

/// 下載回應共用的標頭：檔名（RFC 6266）、不讓中間的代理壓縮 / 改寫 / 先存成暫存檔。
/// Headers every download carries: the name (RFC 6266), and no compressing, transforming or spooling on the way.
fn download_response(body: Body, content_type: &'static str, name: &str, len: Option<u64>) -> Response {
    let mut resp = Response::new(body);
    let h = resp.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    if let Ok(v) = HeaderValue::from_str(&sftp::attachment(name)) {
        h.insert(header::CONTENT_DISPOSITION, v);
    }
    if let Some(l) = len {
        h.insert(header::CONTENT_LENGTH, HeaderValue::from(l));
    }
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store, no-transform"));
    h.insert(header::X_CONTENT_TYPE_OPTIONS, HeaderValue::from_static("nosniff"));
    // Nginx（Nginx Proxy Manager）別把大檔先寫進它自己的暫存檔。/ Nginx: don't spool a big download to disk.
    h.insert("x-accel-buffering", HeaderValue::from_static("no"));
    resp
}

/// 一個檔案：照開檔時的大小送（`take`），下載途中長大的部分不送，Content-Length 才對得上。
/// One file, sent at the size it had when opened (`take`), so Content-Length holds even if it grows meanwhile.
async fn file_response<S>(sftp: S, path: &str, name: &str) -> Result<Response, SftpError>
where
    S: std::ops::Deref<Target = russh_sftp::client::SftpSession> + Send + Sync + 'static,
{
    let len = sftp.metadata(path).await?.size.unwrap_or(0);
    let file = sftp.open(path).await?;
    let stream = ReaderStream::with_capacity(file.take(len), sftp::zipstream::CHUNK);
    // SFTP channel（與它的 lease）要活到串流結束。/ Keep the SFTP channel for the duration of the stream.
    // fuse：壓縮層（br / gzip）在串流結束後還會再 poll 一次，沒 fuse 的 unfold 會 panic、連線被砍（瀏覽器下載卡住）。
    // fuse: the compression layer polls once more after the end; an unfused unfold panics and the download hangs.
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
    Ok(download_response(Body::from_stream(guarded), "application/octet-stream", name, Some(len)))
}

/// 資料夾 / 好幾個東西：邊打包邊送，沒有 Content-Length。/ A folder or several paths, zipped as it streams.
fn zip_response<S>(state: &AppState, sftp: S, paths: Vec<String>, name: &str) -> Response
where
    S: std::ops::Deref<Target = russh_sftp::client::SftpSession> + Send + Sync + 'static,
{
    let stream = sftp::zipstream::zip_stream(sftp, paths, state.config.tz_offset_minutes);
    download_response(Body::from_stream(stream), "application/zip", name, None)
}

/// zip 的檔名：一個 = 它的名字，好幾個 = 所在資料夾的名字。/ The zip's name: the item's, or the folder's for several.
fn zip_name(paths: &[String]) -> String {
    let name = if paths.len() == 1 { sftp::basename(&paths[0]) } else { sftp::basename(&ops::parent(&paths[0])) };
    let name = if name.is_empty() || name == "/" || name.ends_with(':') { "files".to_string() } else { name };
    format!("{name}.zip")
}

/// 大量傳輸用的 SFTP（自己的 channel，開不了就共用那條；見 `ssh::pool`）。/ SFTP for a bulk transfer (see `ssh::pool`).
async fn transfer(state: &AppState, target: &Target) -> ApiResult<Bulk> {
    target.bulk(state).await.map_err(|e| ApiError::bad_request(format!("{e:#}")))
}

#[utoipa::path(get, path = "/api/sftp/download/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = String, Query, description = "File or directory (directories are zipped as they stream)")), responses((status = 200, description = "Streamed file (application/octet-stream, with Content-Length) or zip (application/zip, streamed while it is built) with Content-Disposition", content_type = "application/octet-stream"), (status = 400, body = super::schemas::ErrorBody), (status = 404, body = super::schemas::ErrorBody)))]
async fn download(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let (_t, target) = access(&state, &user, id, &username, &headers).await?;
    let raw = q.get("path").cloned().filter(|p| !p.is_empty()).ok_or_else(|| ApiError::bad_request("path is required"))?;
    let sftp = connect(&state, &target).await?;
    let home = sftp::home(&sftp).await;
    let path = sftp::resolve_path(&raw, &home);
    let meta = sftp.metadata(&path).await.map_err(|_| ApiError::bad_request("Failed to download file or directory"))?;
    drop(sftp);
    let bulk = transfer(&state, &target).await?;
    if meta.is_dir() {
        let name = zip_name(std::slice::from_ref(&path));
        Ok(zip_response(&state, bulk, vec![path], &name))
    } else {
        let name = sftp::basename(&path);
        file_response(bulk, &path, &name).await.map_err(|_| ApiError::bad_request("Failed to download file or directory"))
    }
}

#[utoipa::path(post, path = "/api/sftp/download-link/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpPathsRequest, responses((status = 200, description = "A one-time link (60 s) the browser opens itself: one file = the file, a folder or several paths = one zip", body = super::schemas::SftpDownloadLink), (status = 400, description = "code = path_required", body = super::schemas::SftpError), (status = 403, body = super::schemas::SftpError), (status = 404, description = "code = not_found", body = super::schemas::SftpError)))]
async fn download_link(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let paths = op.paths(&body)?;
    let mut file_size = None;
    for p in &paths {
        let m = op.sftp.metadata(p.as_str()).await.map_err(|e| sftp_error(&e, p))?;
        if paths.len() == 1 && !m.is_dir() {
            file_size = Some(m.size.unwrap_or(0));
        }
    }
    let zip = file_size.is_none();
    let name = if zip { zip_name(&paths) } else { sftp::basename(&paths[0]) };
    let token = state.downloads.issue(Link { user_id: user.id, tunnel_id: op.t.id, username: op.username.clone(), paths, zip, name: name.clone() });
    Ok(Json(json!({
        "url": format!("/api/sftp/fetch/{token}"),
        "name": name,
        "zip": zip,
        "size": file_size,
        "expires_in": links::TTL.as_secs(),
    })))
}

/// 一次性連結打開時再檢查一次：帳號、功能、還看得到這條隧道、還能用這個帳號。失敗 = 純文字（瀏覽器的下載列顯示失敗）。
/// Checked again when the link is opened; a failure is plain text (the browser shows the download as failed).
async fn fetch_link(state: &AppState, token: &str) -> Result<Response, (StatusCode, String)> {
    let gone = || (StatusCode::NOT_FOUND, "This download link has expired or was already used. Start the download again in Telepy.".to_string());
    let link = state.downloads.take(token).ok_or_else(gone)?;
    let user = db::users::by_id(&state.db, link.user_id).await.ok().flatten().filter(|u| u.is_active).ok_or_else(gone)?;
    if !state.features.allowed(&user, crate::features::Feature::Files).await.unwrap_or(false) {
        return Err((StatusCode::FORBIDDEN, crate::features::disabled_message(crate::features::Feature::Files)));
    }
    let t = db::tunnels::by_id(&state.db, link.tunnel_id).await.ok().flatten().ok_or_else(gone)?;
    let target = Target::of(state, user.id, t.reverse_port, &link.username).filter(|g| g.lan().is_none_or(|f| f.tunnel_id == t.id)).ok_or_else(gone)?;
    let account = match &target {
        Target::Device { username, .. } => username.clone(),
        Target::Lan(f) => {
            if !state.features.allowed(&user, crate::features::Feature::Network).await.unwrap_or(false) {
                return Err((StatusCode::FORBIDDEN, crate::features::disabled_message(crate::features::Feature::Network)));
            }
            f.account.clone()
        }
    };
    let can_view = permissions::check_access(&state.db, user.id, &t, Permission::View).await.unwrap_or(false);
    let allowed = can_view && permissions::allowed_usernames(&state.db, user.id, &t).await.is_ok_and(|a| a.iter().any(|u| u.username == account));
    if !allowed {
        return Err(gone());
    }
    let sftp = target.bulk(state).await.map_err(|e| (StatusCode::BAD_GATEWAY, format!("{e:#}")))?;
    let failed = |e: SftpError| {
        let (status, _) = ops::classify(&e);
        (StatusCode::from_u16(status).unwrap_or(StatusCode::BAD_GATEWAY), e.to_string())
    };
    if link.zip {
        for p in &link.paths {
            sftp.metadata(p.as_str()).await.map_err(failed)?;
        }
        Ok(zip_response(state, sftp, link.paths, &link.name))
    } else {
        file_response(sftp, &link.paths[0], &link.name).await.map_err(failed)
    }
}

#[utoipa::path(get, path = "/api/sftp/fetch/{token}", tag = "SFTP", params(("token" = String, Path, description = "One-time token from download-link (60 s, single use)")), responses((status = 200, description = "The file (with Content-Length) or the zip (streamed)", content_type = "application/octet-stream"), (status = 403, description = "Files are turned off for this account (text)"), (status = 404, description = "Expired, used, or access is gone (text)"), (status = 502, description = "The device could not be reached (text)")))]
async fn fetch(State(state): State<AppState>, Path(token): Path<String>) -> Response {
    match fetch_link(&state, &token).await {
        Ok(r) => r,
        Err((status, msg)) => (status, [(header::CONTENT_TYPE, "text/plain; charset=utf-8")], msg).into_response(),
    }
}

/// 暫存檔（`part`）完成後放到 `target`：已經有同名的就照 `overwrite`（覆蓋時沿用原本的權限；symlink 改的是它指到的
/// 檔案，連結還在，跟編輯器存檔一樣）。
/// Put a finished part file at `target`; an existing file is replaced only with `overwrite` (keeping its mode; through
/// a symlink the file it points to is replaced and the link stays, like the editor's save).
/// `keep` = 同名衝突時留著暫存檔（使用者可以選擇取代，不必重傳）。/ `keep` = keep the part file on a name clash.
async fn finish_part(state: &AppState, op: &Op, part: &str, target: &str, overwrite: bool, keep: bool) -> ApiResult<()> {
    let real = match op.sftp.symlink_metadata(target).await {
        Ok(m) if m.is_symlink() && overwrite => op.sftp.canonicalize(target).await.unwrap_or_else(|_| target.to_string()),
        _ => target.to_string(),
    };
    let target = real.as_str();
    match op.sftp.metadata(target).await {
        Ok(m) if m.is_dir() => {
            let _ = op.sftp.remove_file(part).await;
            Err(coded(StatusCode::CONFLICT, "is_directory", format!("{target} is a folder")))
        }
        Ok(m) => {
            if !overwrite {
                // 上傳途中別人放了同名的檔案：留著傳好的部分，讓使用者決定要不要取代。
                // Someone put a same-name file there meanwhile: keep what was uploaded and let the person decide.
                if keep {
                    return Err(ApiError::new(StatusCode::CONFLICT, json!({ "error": format!("{target} already exists"), "code": "exists", "kept": true })));
                }
                let _ = op.sftp.remove_file(part).await;
                return Err(coded(StatusCode::CONFLICT, "exists", format!("{target} already exists")));
            }
            if let Some(mode) = m.permissions {
                let _ = op.sftp.set_metadata(part, ops::mode_attrs(mode)).await;
            }
            replace_file(state, op, part, target).await.map_err(|e| sftp_error(&e, "save"))
        }
        Err(_) => op.sftp.rename(part, target).await.map_err(|e| sftp_error(&e, "rename")),
    }
}

/// 建暫存檔的錯誤：資料夾不能寫 = `dir_not_writable`。/ Creating the part file: an unwritable folder is its own code.
fn create_error(op: &Op, e: &SftpError, target: &str) -> ApiError {
    match ops::classify(e) {
        (403, _) => coded(StatusCode::FORBIDDEN, "dir_not_writable", format!("{} can't create files in {}", op.target.label(), ops::parent(target))),
        _ => sftp_error(e, "upload"),
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
    let (t, target) = access(&state, &user, id, &username, &headers).await?;
    let Some(destination) = q.get("destination_path").cloned().filter(|p| !p.is_empty()) else {
        return Err(ApiError::bad_request("File and destination path required"));
    };
    let sftp = connect(&state, &target).await?;
    let home = sftp::home(&sftp).await;
    let dest = sftp::resolve_path(&destination, &home);
    let op = Op { t, username: username.clone(), by: user.username.clone(), sftp, home, target };
    // multipart 的 Field 借用 Multipart，所以在迴圈內直接串流寫入。/ Stream the field inside the loop.
    // 先寫到旁邊的暫存檔、完成才改名：上傳失敗不會弄壞原本的檔案。/ Write next to it, rename when complete.
    while let Ok(Some(mut field)) = multipart.next_field().await {
        if field.name() != Some("file") {
            continue;
        }
        let filename = field.file_name().map(str::to_string).unwrap_or_else(|| "upload".to_string());
        let target = sftp::upload_target(&op.sftp, &dest, &filename).await;
        let upload = crate::util::random_alnum(16);
        let part = ops::part_path(&target, &upload);
        let mut file = op.sftp.create(&part).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
        let row = record_part(&state, &op, user.id, &upload, &target, &part, 0, None, None).await?;
        let written = async {
            while let Some(chunk) = field.chunk().await.map_err(|e| ApiError::bad_request(e.to_string()))? {
                file.write_all(&chunk).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
            }
            file.shutdown().await.map_err(|e| ApiError::bad_request(e.to_string()))
        };
        if let Err(e) = written.await {
            let _ = op.sftp.remove_file(part.as_str()).await;
            let _ = upload_parts::remove(&state.db, row).await;
            return Err(e);
        }
        finish_part(&state, &op, &part, &target, true, false).await?;
        let _ = upload_parts::remove(&state.db, row).await;
        return Ok(Json(json!({ "success": "File uploaded successfully", "path": target })));
    }
    Err(ApiError::bad_request("File and destination path required"))
}

fn number(q: &HashMap<String, String>, key: &str) -> ApiResult<Option<u64>> {
    match q.get(key) {
        None => Ok(None),
        Some(v) => v.parse().map(Some).map_err(|_| coded(StatusCode::BAD_REQUEST, "bad_offset", format!("{key} must be a whole number"))),
    }
}

fn flag(q: &HashMap<String, String>, key: &str) -> bool {
    matches!(q.get(key).map(String::as_str), Some("1" | "true"))
}

/// 帳本記一筆（`crate::uploads`）。/ Record a part file in the ledger.
#[allow(clippy::too_many_arguments)]
async fn record_part(state: &AppState, op: &Op, user_id: i64, upload: &str, target: &str, part: &str, total: u64, local: Option<(&str, i64)>, lease: Option<&str>) -> ApiResult<i64> {
    let now = crate::util::now_db();
    Ok(upload_parts::start(
        &state.db,
        NewPart {
            tunnel_id: op.t.id,
            username: &op.username,
            user_id,
            upload,
            target,
            part_path: part,
            total,
            local_name: local.map(|l| l.0),
            local_modified: local.map(|l| l.1),
            lease,
            now: &now,
        },
    )
    .await?)
}

/// 這個請求能寫這個上傳嗎：自己的，而且（有 lease 的話）是同一個視窗。/ May this request write this upload?
fn may_write(row: &PartRow, user_id: i64, lease: Option<&str>) -> bool {
    row.user_id == user_id && row.lease.as_deref().is_none_or(|l| Some(l) == lease)
}

fn taken() -> ApiError {
    coded(StatusCode::CONFLICT, "upload_taken", "This upload continued in another window")
}

/// 續傳前比對：裝置上暫存檔 `[from, to)` 的 SHA-256（十六進位）。/ SHA-256 of the part file's `[from, to)`, as hex.
async fn part_digest(sftp: &russh_sftp::client::SftpSession, part: &str, from: u64, to: u64) -> Result<String, SftpError> {
    use sha2::Digest;
    let mut f = sftp.open(part).await?;
    f.seek(std::io::SeekFrom::Start(from)).await.map_err(SftpError::from)?;
    let mut buf = vec![0u8; usize::try_from(to.saturating_sub(from)).unwrap_or(0)];
    f.read_exact(&mut buf).await.map_err(SftpError::from)?;
    Ok(sha2::Sha256::digest(&buf).iter().map(|b| format!("{b:02x}")).collect())
}

#[utoipa::path(post, path = "/api/sftp/upload-start/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpUploadStart, responses((status = 200, description = "An upload id + lease; `resumed` = continue at `offset` (send `check` = SHA-256 of the local `[check_from, offset)` with the first part)", body = super::schemas::SftpUploadStarted), (status = 400, description = "code = invalid_name | path_required | bad_offset", body = super::schemas::SftpError), (status = 409, description = "code = exists | is_directory | upload_busy (another window is uploading this file right now)", body = super::schemas::SftpError)))]
async fn upload_start(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let target = op.path(str_field(&body, "path"))?;
    check_name(&target)?;
    let total = body.get("total").and_then(Value::as_u64).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "bad_offset", "total is required"))?;
    let overwrite = body.get("overwrite").and_then(Value::as_bool).unwrap_or(false);
    if let Ok(m) = op.sftp.metadata(target.as_str()).await {
        if m.is_dir() {
            return Err(coded(StatusCode::CONFLICT, "is_directory", format!("{target} is a folder")));
        }
        if !overwrite {
            return Err(coded(StatusCode::CONFLICT, "exists", format!("{target} already exists")));
        }
    }
    let local_name = body.pointer("/local/name").and_then(Value::as_str).filter(|n| !n.is_empty() && n.len() <= 1024);
    let local_modified = body.pointer("/local/modified").and_then(Value::as_i64);
    let resume = body.get("resume").and_then(Value::as_bool).unwrap_or(true);
    let previous = str_field(&body, "lease").filter(|l| !l.is_empty());
    let lease = crate::util::random_alnum(24);
    let now = chrono::Utc::now();
    if let (true, Some(name), Some(modified)) = (resume, local_name, local_modified) {
        for row in upload_parts::resumable(&state.db, op.t.id, &op.username, user.id, &target, total, name, modified).await? {
            let size = ops::size_of(&op.sftp, &row.part_path).await.map_err(|e| sftp_error(&e, "stat"))?;
            let same_window = previous.is_some() && row.lease.as_deref() == previous;
            match uploads::decide(uploads::idle_for(&row.updated_at, now), same_window, size, total) {
                Resume::Busy => {
                    return Err(ApiError::new(
                        StatusCode::CONFLICT,
                        json!({ "error": "This file is being uploaded here from another window right now", "code": "upload_busy", "received": row.received }),
                    ));
                }
                Resume::Continue { offset, check_from } => {
                    upload_parts::take_lease(&state.db, row.id, &lease, &crate::util::db_time(now)).await?;
                    return Ok(Json(json!({ "upload": row.upload, "lease": lease, "offset": offset, "check_from": check_from, "resumed": true })));
                }
                Resume::Stale => {
                    // 暫存檔不見了（有人刪了、裝置清過）或大小不對：帳本那筆丟掉，有檔案就一起刪。
                    // The part file is gone (removed on the device) or the wrong size: drop the entry and the file.
                    if size.is_some() {
                        let _ = op.sftp.remove_file(row.part_path.as_str()).await;
                    }
                    upload_parts::remove(&state.db, row.id).await?;
                }
            }
        }
    }
    let upload = crate::util::random_alnum(16);
    let part = ops::part_path(&target, &upload);
    record_part(&state, &op, user.id, &upload, &target, &part, total, local_name.zip(local_modified), Some(&lease)).await?;
    Ok(Json(json!({ "upload": upload, "lease": lease, "offset": 0, "check_from": null, "resumed": false })))
}

#[utoipa::path(get, path = "/api/sftp/uploads/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("dir" = Option<String>, Query, description = "Folder; default the home folder")), responses((status = 200, description = "Unfinished uploads into this folder (Telepy's own part files), kept for 24 h after their last activity", body = super::schemas::SftpUnfinished), (status = 404, body = super::schemas::SftpError)))]
async fn unfinished_uploads(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let dir = q.get("dir").map(|d| sftp::resolve_path(d, &op.home)).unwrap_or_else(|| op.home.clone());
    let dir = dir.trim_end_matches('/');
    let manage = permissions::check_access(&state.db, user.id, &op.t, Permission::Admin).await?;
    let now = chrono::Utc::now();
    let tz = state.config.tz_offset_minutes;
    let mut items: Vec<Value> = Vec::new();
    for (row, by) in upload_parts::for_account(&state.db, op.t.id, &op.username).await? {
        if ops::parent(&row.target).trim_end_matches('/') != dir {
            continue;
        }
        let idle = uploads::idle_for(&row.updated_at, now);
        let active = idle < uploads::BUSY_FOR;
        // 照裝置上實際的樣子：暫存檔不見了（有人刪了、裝置清過）就把帳本那筆拿掉；大小以裝置上的為準。
        // As the device has it: a part file that is gone (removed there) drops its entry; the size is the device's.
        let received = match ops::size_of(&op.sftp, &row.part_path).await {
            Ok(Some(size)) => size as i64,
            Ok(None) if !active => {
                upload_parts::remove(&state.db, row.id).await?;
                continue;
            }
            _ => row.received,
        };
        let mine = row.user_id == user.id;
        items.push(json!({
                "upload": row.upload,
                "name": sftp::basename(&row.target),
                "target": row.target,
                "part_name": sftp::basename(&row.part_path),
                "total": row.total,
                "received": received,
                "by": by,
                "mine": mine,
                "updated_at": crate::util::db_to_iso(&row.updated_at, tz),
                "active": active,
                "removed_in": uploads::RETENTION.saturating_sub(idle).as_secs(),
                "local_name": row.local_name,
                "local_modified": row.local_modified,
                "can_discard": mine || manage,
        }));
    }
    Ok(Json(json!({ "dir": dir, "uploads": items, "retention_secs": uploads::RETENTION.as_secs() })))
}

/// 從多大的一段起寫在自己的 sftp channel 上。/ Parts from this size get their own SFTP channel.
const BULK_PART: u64 = 1024 * 1024;

fn part_done(target: &str, total: u64) -> Json<Value> {
    Json(json!({ "received": total, "done": true, "path": target }))
}

#[utoipa::path(put, path = "/api/sftp/upload-part/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = String, Query, description = "Full target path"), ("upload" = String, Query, description = "Upload id (from upload-start, or chosen by the client: 8–64 letters or digits)"), ("offset" = u64, Query, description = "Where this part starts (0 = the first part; creates or restarts the upload)"), ("total" = u64, Query, description = "The file's size; the part that reaches it renames the upload onto the target"), ("lease" = Option<String>, Query, description = "The lease from upload-start (required once the upload has one)"), ("check" = Option<String>, Query, description = "First part after resuming: SHA-256 (hex) of the local bytes [check_from, offset)"), ("overwrite" = Option<bool>, Query, description = "1 = replace an existing file (its mode is kept)"), ("parents" = Option<bool>, Query, description = "1 = create missing folders above the target (first part)"), ("retry" = Option<bool>, Query, description = "1 = this part is being sent again after a lost answer")), request_body(content = Vec<u8>, content_type = "application/octet-stream", description = "The part's bytes (≤ 32 MiB)"), responses((status = 200, body = super::schemas::SftpUploadPart), (status = 400, description = "code = bad_upload | bad_offset | invalid_name | path_required", body = super::schemas::SftpError), (status = 403, description = "code = dir_not_writable | permission_denied | step_up_required", body = super::schemas::SftpError), (status = 409, description = "code = exists (`kept`: the uploaded part waits; resend the last part with overwrite=1 to replace) | is_directory | upload_offset (carries `received`: resume from there) | upload_gone (start again) | upload_mismatch (the device's part file differs from the local file: start again) | upload_taken (another window continued this upload)", body = super::schemas::SftpError), (status = 413, description = "code = too_large", body = super::schemas::SftpError)))]
async fn upload_part(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    headers: HeaderMap,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    body: Body,
) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let target = op.path(q.get("path").map(String::as_str))?;
    check_name(&target)?;
    let upload = q.get("upload").map(String::as_str).filter(|u| ops::valid_upload_id(u)).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "bad_upload", "upload must be 8–64 letters or digits"))?;
    let offset = number(&q, "offset")?.unwrap_or(0);
    let total = number(&q, "total")?.ok_or_else(|| coded(StatusCode::BAD_REQUEST, "bad_offset", "total is required"))?;
    if offset > total {
        return Err(coded(StatusCode::BAD_REQUEST, "bad_offset", "offset is past the end of the file"));
    }
    let overwrite = flag(&q, "overwrite");
    let lease = q.get("lease").map(String::as_str).filter(|l| !l.is_empty());
    let part = ops::part_path(&target, upload);
    // 帳本：別人的、或已經被另一個視窗接手的，不能寫。/ The ledger: someone else's, or taken over by another window, can't be written.
    let row = upload_parts::by_part(&state.db, op.t.id, &op.username, &part).await?;
    if row.as_ref().is_some_and(|r| !may_write(r, user.id, lease)) {
        return Err(taken());
    }
    let part_size = ops::size_of(&op.sftp, &part).await.map_err(|e| sftp_error(&e, "stat"))?;
    // 目標現在的樣子（只有需要時才問）。/ The target as it is now (asked only when needed).
    let target_now = || async { op.sftp.metadata(target.as_str()).await.ok() };
    // 大的一段寫在自己的 sftp channel 上（列目錄不必排在後面、慢的裝置也不會逾時）；小的走共用那條，省掉開 channel。
    // A big part is written on its own SFTP channel; small ones (most files of a folder) use the shared one.
    let big = headers.get(header::CONTENT_LENGTH).and_then(|v| v.to_str().ok()).and_then(|v| v.parse::<u64>().ok()).is_some_and(|n| n >= BULK_PART);
    let mut bulk: Option<Bulk> = None;
    let row_id;
    let mut file = match ops::part_step(offset, part_size) {
        PartStep::Start => {
            if let Some(m) = target_now().await {
                if m.is_dir() {
                    return Err(coded(StatusCode::CONFLICT, "is_directory", format!("{target} is a folder")));
                }
                if !overwrite {
                    // 只有一段的檔案：上一次其實傳完了，只是回覆沒收到。/ A one-part file whose answer was lost.
                    if flag(&q, "retry") && part_size.is_none() && m.size == Some(total) {
                        return Ok(part_done(&target, total));
                    }
                    return Err(coded(StatusCode::CONFLICT, "exists", format!("{target} already exists")));
                }
            }
            if flag(&q, "parents") {
                ops::mkdir_all(&op.sftp, &ops::parent(&target)).await.map_err(|e| sftp_error(&e, "mkdir"))?;
            }
            if big {
                bulk = Some(transfer(&state, &op.target).await?);
            }
            let writer: &russh_sftp::client::SftpSession = bulk.as_deref().unwrap_or(&op.sftp);
            let f = writer.create(part.as_str()).await.map_err(|e| create_error(&op, &e, &target))?;
            row_id = record_part(&state, &op, user.id, upload, &target, &part, total, None, lease).await?;
            f
        }
        PartStep::Append => {
            // 續傳後的第一段：裝置上暫存檔最後那一段要跟本機檔案一樣，不然（有人動過暫存檔、或本機是另一個檔案）從頭來。
            // The first part after resuming: the end of the part file must match the local file, else start over.
            if let Some(check) = q.get("check") {
                let from = offset.saturating_sub(uploads::CHECK_LEN);
                let have = part_digest(&op.sftp, &part, from, offset).await.map_err(|e| sftp_error(&e, "read"))?;
                if !have.eq_ignore_ascii_case(check) {
                    let _ = op.sftp.remove_file(part.as_str()).await;
                    let _ = upload_parts::remove_part(&state.db, op.t.id, &op.username, &part).await;
                    return Err(coded(StatusCode::CONFLICT, "upload_mismatch", "The unfinished upload on the device doesn't match this file; it starts over"));
                }
            }
            if big {
                bulk = Some(transfer(&state, &op.target).await?);
            }
            let writer: &russh_sftp::client::SftpSession = bulk.as_deref().unwrap_or(&op.sftp);
            let mut f = writer.open_with_flags(part.as_str(), russh_sftp::protocol::OpenFlags::WRITE).await.map_err(|e| sftp_error(&e, "open"))?;
            f.seek(std::io::SeekFrom::Start(offset)).await.map_err(|e| sftp_error(&SftpError::from(e), "seek"))?;
            row_id = match &row {
                Some(r) => r.id,
                // 這個版本之前開始的上傳：補記一筆。/ An upload begun before the ledger existed: record it now.
                None => record_part(&state, &op, user.id, upload, &target, &part, total, None, lease).await?,
            };
            f
        }
        PartStep::Resume(received) => {
            return Err(ApiError::new(StatusCode::CONFLICT, json!({ "error": format!("The device has {received} bytes of this upload; continue from there"), "code": "upload_offset", "received": received })));
        }
        PartStep::Gone => {
            // 暫存檔不見了：帳本那筆也拿掉。最後一段其實已經完成改名（回覆沒收到）就算完成。
            // The part file is gone: drop its entry. If the last part already renamed it (answer lost), it's done.
            if row.is_some() {
                let _ = upload_parts::remove_part(&state.db, op.t.id, &op.username, &part).await;
            }
            if matches!(target_now().await, Some(m) if !m.is_dir() && m.size == Some(total)) {
                return Ok(part_done(&target, total));
            }
            return Err(coded(StatusCode::CONFLICT, "upload_gone", "This upload was interrupted on the device; start it again"));
        }
    };
    let mut written = 0u64;
    let mut beat = std::time::Instant::now();
    let mut stream = body.into_data_stream();
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| coded(StatusCode::BAD_REQUEST, "interrupted", format!("The upload was cut off: {e}")))?;
        written += chunk.len() as u64;
        if written > ops::MAX_PART {
            return Err(coded(StatusCode::PAYLOAD_TOO_LARGE, "too_large", format!("A part may be at most {} MiB", ops::MAX_PART / 1024 / 1024)));
        }
        if offset + written > total {
            return Err(coded(StatusCode::BAD_REQUEST, "bad_offset", "More data than the file's size"));
        }
        file.write_all(&chunk).await.map_err(|e| sftp_error(&SftpError::from(e), "write"))?;
        // 慢的裝置一段要寫很久：途中也說「還在寫」，另一個視窗才不會以為沒人在傳。
        // On a slow device a part takes a while: keep saying "still writing" so another window doesn't take over.
        if beat.elapsed() >= uploads::HEARTBEAT {
            beat = std::time::Instant::now();
            let _ = upload_parts::touch(&state.db, row_id, offset + written, &crate::util::now_db()).await;
        }
    }
    file.shutdown().await.map_err(|e| sftp_error(&SftpError::from(e), "write"))?;
    drop(bulk);
    let received = offset + written;
    upload_parts::touch(&state.db, row_id, received, &crate::util::now_db()).await?;
    if received < total {
        return Ok(Json(json!({ "received": received, "done": false })));
    }
    let have = ops::size_of(&op.sftp, &part).await.map_err(|e| sftp_error(&e, "stat"))?.unwrap_or(0);
    if have != total {
        return Err(ApiError::new(StatusCode::CONFLICT, json!({ "error": format!("The device has {have} of {total} bytes; continue from there"), "code": "upload_offset", "received": have.min(total) })));
    }
    // 同名衝突時留著暫存檔與帳本（使用者可以選擇取代）；其他結果都把帳本那筆拿掉。
    // On a name clash the part file and its entry stay (the person may replace); otherwise the entry goes.
    match finish_part(&state, &op, &part, &target, overwrite, true).await {
        Err(e) if e.body.get("kept").is_some() => Err(e),
        done => {
            let _ = upload_parts::remove(&state.db, row_id).await;
            done.map(|_| part_done(&target, total))
        }
    }
}

#[utoipa::path(delete, path = "/api/sftp/upload-part/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username"), ("path" = String, Query, description = "Full target path"), ("upload" = String, Query, description = "Upload id")), responses((status = 200, description = "{removed}: the unfinished part file is gone (yours; the owner and Admins may discard anyone's)", body = super::schemas::SftpUploadCancel), (status = 400, body = super::schemas::SftpError), (status = 403, description = "code = not_yours", body = super::schemas::SftpError)))]
async fn upload_part_cancel(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, Query(q): Query<HashMap<String, String>>) -> ApiResult<Json<Value>> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let target = op.path(q.get("path").map(String::as_str))?;
    let upload = q.get("upload").map(String::as_str).filter(|u| ops::valid_upload_id(u)).ok_or_else(|| coded(StatusCode::BAD_REQUEST, "bad_upload", "upload must be 8–64 letters or digits"))?;
    let part = ops::part_path(&target, upload);
    if let Some(row) = upload_parts::by_part(&state.db, op.t.id, &op.username, &part).await? {
        if row.user_id != user.id && !permissions::check_access(&state.db, user.id, &op.t, Permission::Admin).await? {
            return Err(coded(StatusCode::FORBIDDEN, "not_yours", "Only the person uploading it, the owner or an Admin can discard this upload"));
        }
        upload_parts::remove(&state.db, row.id).await?;
    }
    // 只刪一般檔案（被換成資料夾或連結就不碰）。/ Only a regular file is removed.
    let removed = match op.sftp.symlink_metadata(part.as_str()).await {
        Ok(m) if !m.is_dir() && !m.is_symlink() => op.sftp.remove_file(part.as_str()).await.is_ok(),
        _ => false,
    };
    Ok(Json(json!({ "removed": removed })))
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

/// 一次操作要的東西：隧道、共用 SFTP、家目錄。`username` = URL 的帳號位置（上傳帳本用；區網主機 = `~<代號>`）。
/// What one operation needs. `username` = the URL's account segment (the upload ledger's key; `~<id>` for a LAN host).
struct Op {
    t: Tunnel,
    username: String,
    by: String,
    sftp: Shared,
    home: String,
    target: Target,
}

impl Op {
    async fn open(state: &AppState, user: &crate::db::users::User, id: i64, username: &str, headers: &HeaderMap) -> ApiResult<Self> {
        let (t, target) = access(state, user, id, username, headers).await?;
        let sftp = target.sftp(state).await.map_err(|e| coded(StatusCode::BAD_GATEWAY, "device", format!("{e:#}")))?;
        let home = sftp::home(&sftp).await;
        Ok(Self { t, username: username.to_string(), by: user.username.clone(), sftp, home, target })
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
        op.event(&state, "files_delete", format!("{} deleted {removed} entr{} as {}: {what}", op.by, if removed == 1 { "y" } else { "ies" }, op.target.label())).await;
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
        let (_keep, channel) = op.target.session_channel(state).await?;
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

#[utoipa::path(post, path = "/api/sftp/zip/{id}/{username}", tag = "SFTP", security(("bearer" = [])), params(("id" = i64, Path, description = "Tunnel id"), ("username" = String, Path, description = "Target username")), request_body = super::schemas::SftpPathsRequest, responses((status = 200, description = "application/zip with every path at the top level (folders whole), streamed while it is built", content_type = "application/zip"), (status = 400, body = super::schemas::SftpError), (status = 404, body = super::schemas::SftpError)))]
async fn zip(State(state): State<AppState>, AuthUser(user): AuthUser, headers: HeaderMap, Path((id, username)): Path<(i64, String)>, AppJson(body): AppJson<Value>) -> ApiResult<Response> {
    let op = Op::open(&state, &user, id, &username, &headers).await?;
    let paths = op.paths(&body)?;
    // 開始串流之後就不能回錯誤碼了：先確認每個都在。/ Check every path before streaming starts.
    for p in &paths {
        op.sftp.metadata(p.as_str()).await.map_err(|e| sftp_error(&e, p))?;
    }
    let name = zip_name(&paths);
    let bulk = transfer(&state, &op.target).await?;
    Ok(zip_response(&state, bulk, paths, &name))
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
    let (_keep, channel) = op.target.session_channel(state).await?;
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
            (403, _) => coded(StatusCode::FORBIDDEN, "dir_not_writable", format!("{} can't create files in {}", op.target.label(), ops::parent(&target))),
            _ => sftp_error(&e, "save"),
        });
    }
    if let Err(e) = replace_file(&state, &op, &tmp, &target).await {
        let _ = op.sftp.remove_file(tmp.as_str()).await;
        return Err(sftp_error(&e, "save"));
    }
    let after = op.sftp.metadata(target.as_str()).await.map_err(|e| sftp_error(&e, "stat"))?;
    op.event(&state, "files_edit", format!("{} edited {target} as {} ({})", op.by, op.target.label(), crate::ws::filemanager::format_size(content.len() as f64))).await;
    Ok(Json(json!({
        "path": target,
        "name": sftp::basename(&target),
        "size": after.size.unwrap_or(0),
        "mtime_epoch": after.mtime,
        "mode": ops::mode_octal(after.permissions.unwrap_or(mode)),
    })))
}
