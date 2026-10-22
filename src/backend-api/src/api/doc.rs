//! OpenAPI 文件的根：info、tags、Bearer 安全方案。各端點的 path item 由 `utoipa_axum` 的 `routes!` 收集。
//! Root of the OpenAPI document; path items are collected by the `routes!` macro in each api module.

use utoipa::openapi::security::{HttpAuthScheme, HttpBuilder, SecurityScheme};
use utoipa::{Modify, OpenApi};

pub const SWAGGER_PATH: &str = "/api/__hidden_swagger";
pub const OPENAPI_JSON_PATH: &str = "/api/openapi.json";

#[derive(OpenApi)]
#[openapi(
    info(
        title = "Telepy API",
        version = "v1",
        description = "REST API of Telepy. Authenticate with `POST /api/auth/token` and send the access token as `Authorization: Bearer <token>`. WebSocket endpoints (`/ws/*`) are documented in CLAUDE.md; they authenticate with a first JSON frame `{\"type\":\"auth\",\"token\":\"<access>\"}`."
    ),
    modifiers(&SecurityAddon),
    tags(
        (name = "Login", description = "Obtain, refresh and verify tokens; registration; Google login"),
        (name = "Authentication", description = "The current user"),
        (name = "Reverse Server Keys", description = "Tunnels (reverse server keys), target usernames, live status"),
        (name = "Service Keys", description = "Public keys of the Telepy service itself"),
        (name = "Tunnel Sharing", description = "Share tunnels with other users (view / edit / admin)"),
        (name = "Script", description = "Connection scripts and ssh config for a tunnel"),
        (name = "SFTP", description = "File manager REST endpoints"),
        (name = "Remote Browser", description = "KasmVNC proxy browser sessions"),
        (name = "User Management", description = "Personal settings and user administration"),
        (name = "Site Settings", description = "Site-wide settings (admins)"),
        (name = "Logs", description = "SSH gateway events"),
        (name = "Internal", description = "Service-to-service endpoints (Bearer INTERNAL_API_TOKEN)")
    )
)]
pub struct ApiDoc;

pub struct SecurityAddon;

impl Modify for SecurityAddon {
    fn modify(&self, openapi: &mut utoipa::openapi::OpenApi) {
        let components = openapi.components.get_or_insert_with(Default::default);
        components.add_security_scheme(
            "bearer",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).bearer_format("JWT").build()),
        );
        components.add_security_scheme(
            "internal",
            SecurityScheme::Http(HttpBuilder::new().scheme(HttpAuthScheme::Bearer).bearer_format("INTERNAL_API_TOKEN").build()),
        );
    }
}
