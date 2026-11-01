//! IP 與網卡廠商資料（GeoIP 的 DB-IP Lite、IEEE OUI）的管理（管理員）：伺服器健康頁的面板。
//! `GET /api/site/datasets` 列出三項資料（哪個月的、多大、後端在用哪個檔、自動更新會不會去抓）、自動更新開關與最近一次更新；
//! `POST /api/site/datasets/update`（`{items?}`）立刻下載（沒指定 = 三項都看：DB-IP 抓比裝的新的那個月，廠商表重抓），
//! 換上後馬上重讀、寫稽核事件。
//! Managing the IP and NIC vendor data (superusers): the Server health page's panel. `GET /api/site/datasets` lists
//! the three datasets (which month, size, the file in use, whether the automatic update would fetch it), the
//! auto-update switch and the last run; `POST /api/site/datasets/update` (`{items?}`) downloads now (none given = all
//! three), reloads at once and writes an audit event.

use axum::extract::State;
use axum::http::{header, StatusCode};
use axum::response::IntoResponse;
use axum::Json;
use serde::Deserialize;
use serde_json::{json, Value};
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::auth::AuthUser;
use crate::datasets::{self, Trigger};
use crate::error::{ApiError, ApiResult};
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(list)).routes(routes!(update))
}

fn admin_only(me: &crate::db::users::User) -> ApiResult<()> {
    if me.is_superuser {
        Ok(())
    } else {
        Err(ApiError::new(StatusCode::FORBIDDEN, json!({ "error": "Only administrators can manage the IP and vendor data.", "code": "admin_only" })))
    }
}

/// 面板的樣子 + 自動更新開關（網站設定）。/ The view plus the auto-update site setting.
async fn view(state: &AppState) -> ApiResult<Value> {
    // 順便看一下檔案有沒有被別人換掉（子指令、手動放的）。/ Pick up files someone else replaced meanwhile.
    state.datasets.pick_up_changes(&state.geoip, &state.oui);
    let mut v = state.datasets.view(&state.geoip, &state.oui);
    v["auto_update"] = json!(crate::db::settings::get_solo(&state.db).await?.datasets_auto_update);
    Ok(v)
}

#[utoipa::path(get, path = "/api/site/datasets", tag = "Site Settings", security(("bearer" = [])), responses(
    (status = 200, description = "The GeoIP (DB-IP Lite country + ASN) and NIC vendor (IEEE OUI) data: which month, the file in use, whether the automatic update would fetch it, the auto-update switch and the last run (superusers)", body = super::schemas::DatasetsView),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody)
))]
async fn list(State(state): State<AppState>, AuthUser(me): AuthUser) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    Ok(([(header::CACHE_CONTROL, "no-store")], Json(view(&state).await?)))
}

#[derive(Deserialize, Default)]
struct UpdateBody {
    /// 只更新這幾項（country / asn / oui）；沒給 = 全部。/ Only these items; omitted = all three.
    #[serde(default)]
    items: Option<Vec<String>>,
}

#[utoipa::path(post, path = "/api/site/datasets/update", tag = "Site Settings", security(("bearer" = [])), request_body = super::schemas::DatasetsUpdateRequest, responses(
    (status = 200, description = "Downloaded what was newer (DB-IP: the newest month after the installed one; the vendor table: fetched again), reloaded it and wrote an audit event; `run` says what happened, `datasets` is the view after it", body = super::schemas::DatasetsUpdateResponse),
    (status = 400, description = "items lists something that is not country / asn / oui", body = super::schemas::ErrorBody),
    (status = 403, description = "code = admin_only", body = super::schemas::ErrorBody),
    (status = 409, description = "code = busy: an update is running", body = super::schemas::ErrorBody)
))]
async fn update(State(state): State<AppState>, AuthUser(me): AuthUser, raw: axum::body::Bytes) -> ApiResult<impl IntoResponse> {
    admin_only(&me)?;
    // 空的 body = 全部。/ An empty body = all three.
    let body: UpdateBody = if raw.iter().all(u8::is_ascii_whitespace) { UpdateBody::default() } else { serde_json::from_slice(&raw).map_err(|e| ApiError::bad_request(format!("Invalid JSON: {e}")))? };
    let mut wanted: Vec<&'static str> = Vec::new();
    match &body.items {
        None => wanted.extend(datasets::ITEMS),
        Some(items) => {
            for i in items {
                let Some(id) = datasets::ITEMS.into_iter().find(|x| x == i) else {
                    return Err(ApiError::field("items", format!("There is no dataset called {i}.")));
                };
                wanted.push(id);
            }
        }
    }
    // 在自己的 task 裡跑：管理員關掉分頁（請求被取消）時下載照樣做完、照樣記稽核事件。
    // Run in its own task, so closing the tab (which cancels the request) still finishes the download and the audit event.
    let st = state.clone();
    let by = Some((me.id, me.username.clone()));
    let task = tokio::spawn(async move {
        let guard = st.datasets.begin()?;
        let run = st.datasets.update(&wanted, Trigger::Manual, by, &st.geoip, &st.oui, chrono::Utc::now()).await;
        drop(guard);
        st.datasets.pick_up_changes(&st.geoip, &st.oui);
        datasets::announce(&st, &run).await;
        Some(run)
    });
    let run = task
        .await
        .map_err(|e| ApiError::detail(StatusCode::INTERNAL_SERVER_ERROR, format!("the update stopped: {e}")))?
        .ok_or_else(|| ApiError::new(StatusCode::CONFLICT, json!({ "error": "The IP and vendor data are being updated right now. Try again in a moment.", "code": "busy" })))?;
    Ok(Json(json!({ "run": run, "datasets": view(&state).await? })))
}
