//! 「新裝置登入」的純邏輯：把 User-Agent 縮成「瀏覽器 · 作業系統」（與前端 `lib/userAgent.ts` 同一張表），
//! 以及這次登入的國家或瀏覽器是不是 90 天內沒出現過。
//! Pure helpers for the new-device sign-in alert: shorten a User-Agent to "browser · OS" (the same table as the
//! frontend's `lib/userAgent.ts`) and decide whether a sign-in's country or browser is new for the account.

/// 多久以內的成功登入算「見過」。/ Successful sign-ins within this many days count as seen.
pub const SEEN_WINDOW_DAYS: i64 = 90;

fn browser(ua: &str) -> Option<&'static str> {
    let has = |s: &str| ua.contains(s);
    if has("Edg/") || has("EdgA/") || has("EdgiOS/") || has("Edge/") {
        Some("Edge")
    } else if has("OPR/") || has("Opera") {
        Some("Opera")
    } else if has("SamsungBrowser/") {
        Some("Samsung Internet")
    } else if has("Firefox/") || has("FxiOS/") {
        Some("Firefox")
    } else if has("Chrome/") || has("CriOS/") || has("Chromium/") {
        Some("Chrome")
    } else if has("Version/") && has("Safari/") {
        Some("Safari")
    } else if ua.starts_with("curl/") {
        Some("curl")
    } else {
        None
    }
}

fn system(ua: &str) -> Option<&'static str> {
    let has = |s: &str| ua.contains(s);
    if has("iPhone") || has("iPad") || has("iPod") {
        Some("iOS")
    } else if has("Android") {
        Some("Android")
    } else if has("CrOS") {
        Some("ChromeOS")
    } else if has("Windows") {
        Some("Windows")
    } else if has("Mac OS X") || has("Macintosh") {
        Some("macOS")
    } else if has("Linux") {
        Some("Linux")
    } else {
        None
    }
}

/// 「瀏覽器 · 作業系統」；認不出來回 None（不拿原字串比，版本號每次更新都會變）。
/// "browser · OS"; None when unrecognised (the raw string changes with every version update).
pub fn ua_family(ua: Option<&str>) -> Option<String> {
    let ua = ua?;
    let parts: Vec<&str> = [browser(ua), system(ua)].into_iter().flatten().collect();
    (!parts.is_empty()).then(|| parts.join(" · "))
}

/// 一次登入看起來的樣子：國家（GeoIP；沒有資料庫或私有位址 = None）與瀏覽器家族。
/// What a sign-in looks like: its country (None without GeoIP or for private addresses) and browser family.
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Seen {
    pub country: Option<String>,
    pub family: Option<String>,
}

/// 這次登入的國家或瀏覽器家族，在 `history`（90 天內的成功登入）裡沒出現過 → 新裝置。
/// 沒有任何紀錄（第一次登入）不算：沒東西可比，也不該在註冊當下就發警示。認不出來的欄位不比。
/// 國家只在紀錄裡**曾經**看過國家時才比：紀錄全是內部位址（代理設錯、剛修好 `TRUSTED_PROXY_HOPS`）或剛裝上 GeoIP
/// 時，第一筆有國家的登入不是「新國家」，只是第一次看得到——否則修好代理那天每個人都會收到新裝置警示。
/// New device = this sign-in's country or browser family does not appear in `history` (successful sign-ins of
/// the last 90 days). An empty history (the first sign-in) is never new; unknown fields are not compared. The
/// country counts only once the history has ever shown one: with a history of internal addresses only (a
/// misconfigured proxy, `TRUSTED_PROXY_HOPS` just fixed) or GeoIP just installed, the first sign-in with a
/// country is merely the first visible one — otherwise everyone would get a new-device alert the day the
/// proxy is fixed.
pub fn is_new_device(history: &[Seen], current: &Seen) -> bool {
    if history.is_empty() {
        return false;
    }
    let country_known = history.iter().any(|h| h.country.is_some());
    let new_country = country_known && current.country.as_ref().is_some_and(|c| !history.iter().any(|h| h.country.as_ref() == Some(c)));
    let new_family = current.family.as_ref().is_some_and(|f| !history.iter().any(|h| h.family.as_ref() == Some(f)));
    new_country || new_family
}

#[cfg(test)]
mod tests {
    use super::*;

    const MAC_CHROME: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
    const MAC_SAFARI: &str = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Safari/605.1.15";
    const WIN_EDGE: &str = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36 Edg/130.0.0.0";
    const IPHONE_FIREFOX: &str = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/130.0 Mobile/15E148 Safari/605.1.15";
    const ANDROID_CHROME: &str = "Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

    #[test]
    fn families() {
        assert_eq!(ua_family(Some(MAC_CHROME)).as_deref(), Some("Chrome · macOS"));
        assert_eq!(ua_family(Some(MAC_SAFARI)).as_deref(), Some("Safari · macOS"));
        assert_eq!(ua_family(Some(WIN_EDGE)).as_deref(), Some("Edge · Windows"));
        assert_eq!(ua_family(Some(IPHONE_FIREFOX)).as_deref(), Some("Firefox · iOS"));
        assert_eq!(ua_family(Some(ANDROID_CHROME)).as_deref(), Some("Chrome · Android"));
        assert_eq!(ua_family(Some("curl/8.4.0")).as_deref(), Some("curl"));
        assert_eq!(ua_family(Some("something")), None);
        assert_eq!(ua_family(None), None);
        // 版本號不同仍是同一家族。/ Another version is the same family.
        assert_eq!(ua_family(Some(&MAC_CHROME.replace("130.0", "131.0"))), ua_family(Some(MAC_CHROME)));
    }

    fn seen(country: Option<&str>, ua: &str) -> Seen {
        Seen { country: country.map(str::to_string), family: ua_family(Some(ua)) }
    }

    #[test]
    fn new_device() {
        let history = vec![seen(Some("TW"), MAC_CHROME), seen(Some("TW"), IPHONE_FIREFOX), seen(None, MAC_CHROME)];
        // 同國家、同瀏覽器 → 不是新的。/ Same country and browser: not new.
        assert!(!is_new_device(&history, &seen(Some("TW"), MAC_CHROME)));
        // 沒有國家資料（私有位址 / 沒有 GeoIP）只比瀏覽器。/ Without a country only the browser counts.
        assert!(!is_new_device(&history, &seen(None, IPHONE_FIREFOX)));
        // 新國家。/ A new country.
        assert!(is_new_device(&history, &seen(Some("JP"), MAC_CHROME)));
        // 新瀏覽器家族。/ A new browser family.
        assert!(is_new_device(&history, &seen(Some("TW"), WIN_EDGE)));
        assert!(is_new_device(&history, &seen(None, MAC_SAFARI)));
        // 認不出來的瀏覽器不算新的。/ An unrecognised browser is not new by itself.
        assert!(!is_new_device(&history, &Seen { country: Some("TW".into()), family: None }));
        // 第一次登入不警示。/ The first sign-in never alerts.
        assert!(!is_new_device(&[], &seen(Some("JP"), WIN_EDGE)));
        // 紀錄裡從沒有國家（代理把位址換成內部位址、或 GeoIP 剛裝好）：第一筆看得到國家的登入不是新國家，
        // 瀏覽器還是照比。/ A history without any country: the first country seen is not new; the browser still counts.
        let internal = vec![seen(None, MAC_CHROME), seen(None, MAC_CHROME)];
        assert!(!is_new_device(&internal, &seen(Some("TW"), MAC_CHROME)));
        assert!(is_new_device(&internal, &seen(Some("TW"), WIN_EDGE)));
    }
}
