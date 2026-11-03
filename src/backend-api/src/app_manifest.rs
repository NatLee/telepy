//! 裝成 app（PWA）用的 web app manifest。名稱照網站設定 `app_name_mode`：`telepy` = 「Telepy」（預設）、`domain` = 網頁的
//! 網域、`custom` = 管理員取的 `app_name`，同一台電腦或手機裝了兩台 Telepy 時才分得出來；通知的標題也用它。manifest 是公開的
//! （登入頁的 HTML 也帶著它的連結），所以只寫名字與圖示，不寫產品在做什麼——跟低調登入頁同一個原則。純函式，端點在 `api/app.rs`。
//! The web app manifest for installing Telepy as an app (PWA). The name follows the site setting `app_name_mode`:
//! `telepy` = "Telepy" (the default), `domain` = the web's domain, `custom` = the admin's `app_name` — so two Telepy
//! servers installed on one computer or phone can be told apart; notification titles use it too. The manifest is public
//! (the sign-in page's HTML links to it), so it carries only the name and icons, never what the product does — the same
//! rule as the discreet sign-in page. Pure functions; the endpoint is in `api/app.rs`.

use serde_json::{json, Value};

/// `app_name_mode` 的值。/ The values of `app_name_mode`.
pub const MODES: [&str; 3] = ["telepy", "domain", "custom"];
/// 預設的名稱，也是其他選項沒有值時的退路。/ The default name, and the fallback when another choice has no value.
pub const DEFAULT_NAME: &str = "Telepy";
/// 自訂名稱的長度上限（主畫面通常只顯示前 12 個字左右，前端會提醒）。/ The custom name's limit (home screens show about 12 characters; the page says so).
pub const NAME_MAX: usize = 30;

/// 頁面底色（`globals.css` 的 `--background`，亮 / 暗）：啟動畫面與視窗標題列。/ The page background (light / dark): splash screen and title bar.
pub const BACKGROUND_LIGHT: &str = "#fbf9f8";
pub const BACKGROUND_DARK: &str = "#110f0d";

/**
 * 自訂名稱：去頭尾空白、中間連續空白（含換行、tab）縮成一個空格；不能有其他控制字元、不能超過 [`NAME_MAX`] 字。空白可以
 * （= 還沒取）。
 * A custom name: trimmed, inner runs of whitespace (newlines and tabs included) collapsed to one space; no other control
 * characters, at most [`NAME_MAX`] characters.
 * Blank is allowed (= not chosen yet).
 */
pub fn check_name(raw: &str) -> Result<String, String> {
    if raw.chars().any(|c| c.is_control() && !c.is_whitespace()) {
        return Err("Use plain text without control characters.".into());
    }
    let name = raw.split_whitespace().collect::<Vec<_>>().join(" ");
    if name.chars().count() > NAME_MAX {
        return Err(format!("Keep the name to {NAME_MAX} characters or fewer."));
    }
    Ok(name)
}

/**
 * 實際用的名稱。`domain` 用網頁的網域（沒有 = 預設）；`custom` 用自訂名稱（空白 = 預設）；其他 = 預設。
 * The name in use. `domain` = the web's domain (none = the default); `custom` = the custom name (blank = the
 * default); anything else = the default.
 */
pub fn effective_name(mode: &str, custom: &str, host: Option<&str>) -> String {
    let pick = match mode {
        "domain" => host.map(str::trim).filter(|h| !h.is_empty()),
        "custom" => Some(custom.trim()).filter(|n| !n.is_empty()),
        _ => None,
    };
    pick.unwrap_or(DEFAULT_NAME).to_string()
}

/**
 * manifest 本體。`id` / `scope` = 整個網站，從 `/` 開始（沒登入就到登入頁，登入了就到通道清單）；`standalone` = 自己的
 * 視窗，沒有網址列。圖示在前端的 `public/icons/`（由 `scripts/app-icons.mjs` 從 `icon.svg` 產生）。不寫 `description`。
 * The manifest. `id` / `scope` = the whole site, starting at `/` (the sign-in page when signed out, the tunnel list
 * when signed in); `standalone` = its own window without an address bar. The icons live in the frontend's
 * `public/icons/` (made from `icon.svg` by `scripts/app-icons.mjs`). No `description`.
 */
pub fn manifest(name: &str) -> Value {
    json!({
        "id": "/",
        "name": name,
        "short_name": name,
        "start_url": "/",
        "scope": "/",
        "display": "standalone",
        "background_color": BACKGROUND_LIGHT,
        "theme_color": BACKGROUND_LIGHT,
        "icons": [
            { "src": "/icons/icon-192.png", "sizes": "192x192", "type": "image/png", "purpose": "any" },
            { "src": "/icons/icon-512.png", "sizes": "512x512", "type": "image/png", "purpose": "any" },
            { "src": "/icons/icon-maskable-512.png", "sizes": "512x512", "type": "image/png", "purpose": "maskable" },
        ],
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_name_follows_the_mode_and_falls_back_to_telepy() {
        assert_eq!(effective_name("telepy", "Lab", Some("telepy.example.com")), "Telepy");
        assert_eq!(effective_name("domain", "Lab", Some("telepy.example.com")), "telepy.example.com");
        assert_eq!(effective_name("domain", "", None), "Telepy", "no domain known");
        assert_eq!(effective_name("domain", "", Some("  ")), "Telepy");
        assert_eq!(effective_name("custom", "  Lab servers ", None), "Lab servers");
        assert_eq!(effective_name("custom", "", Some("x.example")), "Telepy", "a blank custom name is the default");
        assert_eq!(effective_name("neon", "Lab", Some("x.example")), "Telepy", "an unknown mode is the default");
    }

    #[test]
    fn custom_names_are_tidied_and_limited() {
        assert_eq!(check_name("  Lab \t  servers  ").unwrap(), "Lab servers");
        assert_eq!(check_name("").unwrap(), "");
        assert_eq!(check_name("實驗室").unwrap(), "實驗室");
        assert_eq!(check_name(&"字".repeat(NAME_MAX)).unwrap().chars().count(), NAME_MAX, "characters, not bytes");
        assert!(check_name(&"a".repeat(NAME_MAX + 1)).is_err());
        assert!(check_name("Lab\u{0}").is_err());
        assert_eq!(check_name("Lab\nservers").unwrap(), "Lab servers", "a pasted newline becomes a space");
    }

    #[test]
    fn the_manifest_says_only_the_name_and_icons() {
        let m = manifest("Lab");
        assert_eq!(m["name"], "Lab");
        assert_eq!(m["short_name"], "Lab");
        assert_eq!(m["display"], "standalone");
        assert_eq!(m["start_url"], "/");
        assert!(m.get("description").is_none(), "the manifest is public: no product copy");
        let icons = m["icons"].as_array().unwrap();
        assert!(icons.iter().any(|i| i["sizes"] == "192x192"));
        assert!(icons.iter().any(|i| i["sizes"] == "512x512" && i["purpose"] == "any"));
        assert!(icons.iter().any(|i| i["purpose"] == "maskable"), "Android needs a maskable icon");
    }
}
