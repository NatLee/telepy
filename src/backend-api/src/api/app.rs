//! `GET /api/app/manifest.webmanifest`：裝成 app（PWA）用的 manifest。公開——瀏覽器抓 manifest 不帶登入，登入頁的 HTML
//! 也連著它。名稱怎麼來見 [`crate::app_manifest`]；`domain` 用 `PUBLIC_URL` 的主機，沒設就是這次請求的主機，再沒有就是
//! `SERVER_DOMAIN`。`no-cache`：管理員改了名稱，瀏覽器下次檢查就拿到新的。
//! The manifest for installing Telepy as an app (PWA). Public: browsers fetch manifests without credentials, and the
//! sign-in page's HTML links to it. The name is explained in [`crate::app_manifest`]; `domain` = PUBLIC_URL's host,
//! else this request's host, else SERVER_DOMAIN. `no-cache`, so a renamed app shows up on the browser's next check.

use axum::extract::State;
use axum::http::{header, HeaderMap};
use axum::response::IntoResponse;
use utoipa_axum::{router::OpenApiRouter, routes};

use crate::app_manifest;
use crate::db::{self, settings::SiteSettings};
use crate::error::ApiResult;
use crate::state::AppState;

pub fn router() -> OpenApiRouter<AppState> {
    OpenApiRouter::new().routes(routes!(manifest))
}

/// 這次請求看到的 app 名稱。/ The app name as seen by this request.
pub fn app_name(state: &AppState, settings: &SiteSettings, headers: &HeaderMap) -> String {
    let host = crate::ssh_host::web_host(state.config.public_base().as_deref())
        .or_else(|| crate::ssh_host::request_host(headers))
        .or_else(|| state.config.server_domain.clone());
    app_manifest::effective_name(&settings.app_name_mode, &settings.app_name, host.as_deref())
}

#[utoipa::path(get, path = "/api/app/manifest.webmanifest", tag = "App", responses((status = 200, description = "The web app manifest (public): the name from the site settings (Telepy, the web's domain, or the admin's name), standalone display, icons. Carries no product description.", content_type = "application/manifest+json", body = Object)))]
async fn manifest(State(state): State<AppState>, headers: HeaderMap) -> ApiResult<impl IntoResponse> {
    let settings = db::settings::get_solo(&state.db).await?;
    let body = app_manifest::manifest(&app_name(&state, &settings, &headers));
    Ok(([(header::CONTENT_TYPE, "application/manifest+json"), (header::CACHE_CONTROL, "no-cache")], body.to_string()))
}
