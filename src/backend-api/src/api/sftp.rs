//! `/api/sftp/{shell,list,download,upload}/{id}/{username}`（web_sftp app），改走原生 SFTP：
//! 下載串流、目錄打包、上傳串流；沒有 `shell=True`、沒有把使用者路徑拼進指令。

use axum::body::Body;
use axum::extract::{DefaultBodyLimit, Multipart, Path, Query, State};
use axum::http::{header, StatusCode};
use axum::response::{IntoResponse, Response};
use axum::routing::{get, post};
use axum::{Json, Router};
use serde_json::{json, Value};
use std::collections::HashMap;
use tokio::io::AsyncWriteExt;
use tokio_util::io::ReaderStream;

use crate::auth::AuthUser;
use crate::db::{self, tunnels::Tunnel};
use crate::error::{ApiError, ApiResult};
use crate::permissions::{self, Permission};
use crate::sftp;
use crate::ssh::device;
use crate::state::AppState;

pub fn router() -> Router<AppState> {
    Router::new()
        .route("/api/sftp/shell/{id}/{username}", get(shell))
        .route("/api/sftp/list/{id}/{username}", get(list))
        .route("/api/sftp/download/{id}/{username}", get(download))
        .route("/api/sftp/upload/{id}/{username}", post(upload))
        .layer(DefaultBodyLimit::disable())
}

/// 權限：VIEW（否則 404）+ username 在允許清單（否則 400），與 Django 版訊息相同。
async fn access(state: &AppState, user_id: i64, id: i64, username: &str) -> ApiResult<Tunnel> {
    let t = db::tunnels::by_id(&state.db, id).await?.ok_or_else(|| ApiError::not_found("Reverse server keys not found"))?;
    if !permissions::check_access(&state.db, user_id, &t, Permission::View).await? {
        return Err(ApiError::not_found("Reverse server keys not found"));
    }
    let allowed = permissions::allowed_usernames(&state.db, user_id, &t).await?;
    if !allowed.iter().any(|u| u.username == username) {
        return Err(ApiError::bad_request("Username not found"));
    }
    Ok(t)
}

async fn connect(state: &AppState, username: &str, t: &Tunnel) -> ApiResult<(device::DeviceConn, russh_sftp::client::SftpSession)> {
    let conn = device::connect(&state.config, username, t.reverse_port).await.map_err(|e| ApiError::bad_request(e.to_string()))?;
    let sftp = conn.sftp().await.map_err(|e| ApiError::bad_request(e.to_string()))?;
    Ok((conn, sftp))
}

async fn shell(State(state): State<AppState>, AuthUser(user): AuthUser, Path((id, username)): Path<(i64, String)>) -> ApiResult<Json<Value>> {
    let t = access(&state, user.id, id, &username).await?;
    let (_conn, sftp) = connect(&state, &username, &t).await?;
    Ok(Json(json!({ "shell": sftp::detect_shell(&sftp).await })))
}

async fn list(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Json<Value>> {
    let t = access(&state, user.id, id, &username).await?;
    let (_conn, sftp) = connect(&state, &username, &t).await?;
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

async fn download(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
) -> ApiResult<Response> {
    let t = access(&state, user.id, id, &username).await?;
    let raw = q.get("path").cloned().filter(|p| !p.is_empty()).ok_or_else(|| ApiError::bad_request("path is required"))?;
    let (conn, sftp) = connect(&state, &username, &t).await?;
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
        // conn/sftp 要活到串流結束。/ Keep the connection alive for the duration of the stream.
        let stream = ReaderStream::new(file);
        let guarded = futures::stream::unfold((stream, Some((conn, sftp))), |(mut s, guard)| async move {
            use futures::StreamExt;
            match s.next().await {
                Some(item) => Some((item, (s, guard))),
                None => {
                    drop(guard);
                    None
                }
            }
        });
        let mut resp = Response::new(Body::from_stream(guarded));
        *resp.status_mut() = StatusCode::OK;
        resp.headers_mut().insert(header::CONTENT_TYPE, "application/octet-stream".parse().unwrap());
        resp.headers_mut().insert(header::CONTENT_DISPOSITION, format!("attachment; filename=\"{name}\"").parse().unwrap());
        resp.headers_mut().insert(header::CONTENT_LENGTH, meta.len().to_string().parse().unwrap());
        Ok(resp)
    }
}

async fn upload(
    State(state): State<AppState>,
    AuthUser(user): AuthUser,
    Path((id, username)): Path<(i64, String)>,
    Query(q): Query<HashMap<String, String>>,
    mut multipart: Multipart,
) -> ApiResult<Json<Value>> {
    let t = access(&state, user.id, id, &username).await?;
    let Some(destination) = q.get("destination_path").cloned().filter(|p| !p.is_empty()) else {
        return Err(ApiError::bad_request("File and destination path required"));
    };
    let (_conn, sftp) = connect(&state, &username, &t).await?;
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
