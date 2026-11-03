//! 區網主機的網頁 port（純函式、沒有相依）：哪些 port 通常是網頁、http 還是 https、網址怎麼寫。後端的主機 JSON
//! （`web`）、CLI 的 `telepy forward`（`#[path]` 共用這個檔）與前端 `lib/lanWeb.ts`（測試讀這個檔比對）都用同一張表。
//! LAN hosts' web ports (pure, no dependencies): which ports usually serve web pages, http or https, and how the URL
//! reads. The host JSON (`web`), the CLI's `telepy forward` (`#[path]`-shared) and the frontend's `lib/lanWeb.ts`
//! (its test reads this file) all use this one table.

/// 通常是 HTTPS 網頁介面的 port（Synology 5001、Proxmox 8006、Portainer 9443…）。
/// Ports that usually serve an HTTPS web interface. The frontend's `lib/lanWeb.ts` mirrors this table.
pub const WEB_HTTPS_PORTS: &[u16] = &[443, 5001, 8006, 8443, 9443, 10443];
/// 通常是 HTTP 網頁介面的 port（Home Assistant 8123、Plex 32400…）。/ Ports that usually serve plain HTTP.
pub const WEB_HTTP_PORTS: &[u16] = &[80, 3000, 5000, 8000, 8008, 8080, 8081, 8123, 8888, 9000, 9090, 32400];

/// 這個 port 通常是哪種網頁（不是網頁 = None）。/ The usual web scheme on this port (None = not a web port).
pub fn web_scheme(port: u16) -> Option<&'static str> {
    if WEB_HTTPS_PORTS.contains(&port) {
        Some("https")
    } else if WEB_HTTP_PORTS.contains(&port) {
        Some("http")
    } else {
        None
    }
}

/// 打開這台主機某個網頁 port 的網址（預設 port 不寫出來）。/ The URL of a web port on a host (default ports omitted).
pub fn web_url(address: &str, port: u16, scheme: &str) -> String {
    let host = if address.contains(':') { format!("[{address}]") } else { address.to_string() };
    let default = matches!((scheme, port), ("http", 80) | ("https", 443));
    if default {
        format!("{scheme}://{host}/")
    } else {
        format!("{scheme}://{host}:{port}/")
    }
}

/// 一台主機開著的網頁 port 與網址（照 port 排序）。/ A host's open web ports with their URLs, by port.
pub fn web_links(address: &str, ports: &[u16]) -> Vec<(u16, &'static str, String)> {
    let mut v: Vec<(u16, &'static str, String)> = ports.iter().filter_map(|&p| web_scheme(p).map(|s| (p, s, web_url(address, p, s)))).collect();
    v.sort_by_key(|x| x.0);
    v.dedup_by_key(|x| x.0);
    v
}

#[cfg(test)]
mod tests {
    #[test]
    fn web_links_pick_the_scheme_by_port() {
        let v = super::web_links("192.168.1.10", &[22, 8080, 443, 80, 8006, 445]);
        let urls: Vec<&str> = v.iter().map(|x| x.2.as_str()).collect();
        assert_eq!(urls, ["http://192.168.1.10/", "https://192.168.1.10/", "https://192.168.1.10:8006/", "http://192.168.1.10:8080/"]);
        assert!(super::web_links("10.0.0.2", &[22, 3389]).is_empty());
        assert_eq!(super::web_url("fd00::1", 8080, "http"), "http://[fd00::1]:8080/");
    }
}
