//! 「這台是什麼機器」（純函式）：把一台區網主機的線索——網頁標題、`Server`、憑證、realm、banner、開著的 port、網卡廠商——
//! 對一張產品表，給出產品名稱、類型（路由器 / NAS / 虛擬化…）、作業系統提示，以及「憑什麼這樣認為」。認不出來就
//! 回 None，畫面照舊用 port 分類。表是給人讀的：每一列是一個產品和它會留下的痕跡。
//! "What is this machine" (pure): a host's clues — page titles, `Server`, certificates, realms, banners, open ports,
//! the NIC vendor — matched against a product table: the product, its type (router / NAS / hypervisor…), an OS hint,
//! and which clue gave it away. None when nothing matches (the UI keeps its port-based kind). The table is meant to be
//! read: one row per product and the traces it leaves.

use serde::Serialize;

use super::fingerprint::Service;

/// 機器的類型（決定圖示與「網路上有什麼」的分組）。前端 `lib/lanIdentity.ts` 有同一份清單。
/// The machine type (the icon and the "what's on the network" groups). The frontend's `lib/lanIdentity.ts` mirrors it.
pub const KINDS: &[&str] = &["router", "network", "nas", "hypervisor", "server", "computer", "printer", "camera", "media", "iot", "phone"];

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Identity {
    /// 產品名稱（不翻譯）；只認得類型時是 None。/ The product name (untranslated); None when only the type is known.
    pub product: Option<String>,
    pub kind: &'static str,
    /// 作業系統提示（Ubuntu、Windows…）。/ An OS hint.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub os: Option<String>,
    /// 憑什麼：`title` / `server` / `cert` / `realm` / `banner` / `vendor` / `ports` 加上那段文字。
    /// Which clue: `title` / `server` / `cert` / `realm` / `banner` / `vendor` / `ports`, with the text.
    pub by: Clue,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct Clue {
    pub source: &'static str,
    pub text: String,
}

/// 一列產品：名稱、類型，以及要在哪些線索裡找哪些字（小寫比對、任一個中就算）。
/// One product row: name, type, and the words to look for in which clues (lower-case, any match counts).
struct Rule {
    product: &'static str,
    kind: &'static str,
    titles: &'static [&'static str],
    servers: &'static [&'static str],
    certs: &'static [&'static str],
    realms: &'static [&'static str],
}

const fn rule(product: &'static str, kind: &'static str, titles: &'static [&'static str]) -> Rule {
    Rule { product, kind, titles, servers: &[], certs: &[], realms: &[] }
}

/// 產品表：先比較具體的，後面是一般的。/ The product table, specific rows first.
const RULES: &[Rule] = &[
    Rule { product: "Proxmox VE", kind: "hypervisor", titles: &["proxmox virtual environment"], servers: &["pve-api-daemon"], certs: &["proxmox"], realms: &[] },
    Rule { product: "Proxmox Backup Server", kind: "server", titles: &["proxmox backup server"], servers: &[], certs: &[], realms: &[] },
    Rule { product: "VMware ESXi", kind: "hypervisor", titles: &["vmware esxi", "vmware host client"], servers: &[], certs: &["vmware"], realms: &[] },
    rule("XCP-ng", "hypervisor", &["xcp-ng", "xen orchestra"]),
    Rule { product: "Synology DSM", kind: "nas", titles: &["synology", "diskstation", "synology router manager"], servers: &[], certs: &["synology"], realms: &[] },
    rule("QNAP QTS", "nas", &["qnap", "qts"]),
    rule("TrueNAS", "nas", &["truenas", "freenas"]),
    rule("Unraid", "nas", &["unraid"]),
    rule("OpenMediaVault", "nas", &["openmediavault"]),
    rule("UGREEN NAS", "nas", &["ugreen"]),
    Rule { product: "OpenWrt", kind: "router", titles: &["luci", "openwrt"], servers: &[], certs: &["openwrt", "luci"], realms: &[] },
    rule("GL.iNet", "router", &["gl.inet", "glinet"]),
    rule("pfSense", "router", &["pfsense"]),
    rule("OPNsense", "router", &["opnsense"]),
    Rule { product: "MikroTik RouterOS", kind: "router", titles: &["routeros", "mikrotik"], servers: &[], certs: &[], realms: &[] },
    rule("ASUS router", "router", &["asuswrt", "asus wireless router", "asus login"]),
    Rule { product: "TP-Link", kind: "router", titles: &["tp-link", "tplink", "opengl tp-link"], servers: &[], certs: &[], realms: &["tp-link", "tl-"] },
    rule("Ubiquiti UniFi", "network", &["unifi"]),
    rule("Ubiquiti EdgeOS", "router", &["edgeos", "edgerouter"]),
    rule("Fortinet FortiGate", "router", &["fortigate"]),
    rule("Pi-hole", "network", &["pi-hole"]),
    rule("AdGuard Home", "network", &["adguard home"]),
    rule("Home Assistant", "iot", &["home assistant"]),
    rule("Node-RED", "iot", &["node-red"]),
    rule("Zigbee2MQTT", "iot", &["zigbee2mqtt"]),
    rule("Plex", "media", &["plex"]),
    rule("Jellyfin", "media", &["jellyfin"]),
    rule("Emby", "media", &["emby"]),
    Rule { product: "Dell iDRAC", kind: "server", titles: &["idrac", "integrated dell remote access"], servers: &[], certs: &["idrac"], realms: &[] },
    Rule { product: "HPE iLO", kind: "server", titles: &["ilo ", "integrated lights-out"], servers: &[], certs: &["ilo"], realms: &[] },
    rule("Supermicro IPMI", "server", &["supermicro"]),
    rule("Grafana", "server", &["grafana"]),
    rule("Portainer", "server", &["portainer"]),
    rule("Jenkins", "server", &["jenkins"]),
    rule("Gitea", "server", &["gitea"]),
    rule("GitLab", "server", &["gitlab"]),
    rule("Cockpit", "server", &["cockpit"]),
    rule("Webmin", "server", &["webmin"]),
    Rule { product: "Hikvision", kind: "camera", titles: &["hikvision"], servers: &["hikvision", "app-webs"], certs: &["hikvision"], realms: &[] },
    Rule { product: "Dahua", kind: "camera", titles: &["dahua"], servers: &["dahua"], certs: &[], realms: &[] },
    rule("Reolink", "camera", &["reolink"]),
    rule("Frigate", "camera", &["frigate"]),
    Rule { product: "CUPS", kind: "printer", titles: &["cups"], servers: &["cups"], certs: &[], realms: &[] },
    rule("HP printer", "printer", &["hp laserjet", "hp officejet", "hp deskjet", "hp color laserjet"]),
    rule("Brother printer", "printer", &["brother "]),
    rule("Epson printer", "printer", &["epson"]),
    rule("Canon printer", "printer", &["canon"]),
];

/// 從廠商名稱猜類型（沒有更具體的線索時）。/ A type from the NIC vendor alone (when nothing more specific matched).
const VENDOR_KINDS: &[(&str, &str, Option<&str>)] = &[
    ("raspberry pi", "computer", Some("Raspberry Pi")),
    ("synology", "nas", Some("Synology")),
    ("qnap", "nas", Some("QNAP")),
    ("hikvision", "camera", Some("Hikvision")),
    ("dahua", "camera", Some("Dahua")),
    ("ubiquiti", "network", Some("Ubiquiti")),
    ("mikrotik", "router", Some("MikroTik")),
    ("gl technologies", "router", Some("GL.iNet")),
    ("espressif", "iot", Some("ESP32 / ESP8266")),
    ("tuya", "iot", Some("Tuya")),
    ("sonos", "media", Some("Sonos")),
    ("seiko epson", "printer", Some("Epson")),
    ("brother", "printer", Some("Brother")),
    ("vmware", "hypervisor", None),
];

fn found(hay: &str, words: &[&str]) -> bool {
    let h = hay.to_ascii_lowercase();
    words.iter().any(|w| h.contains(w))
}

/// SSH 版本行裡的作業系統（`OpenSSH_9.6p1 Ubuntu-3ubuntu13` → Ubuntu）。/ The OS in an SSH version line.
pub fn os_from_ssh(banner: &str) -> Option<String> {
    let b = banner.to_ascii_lowercase();
    for (word, os) in [("ubuntu", "Ubuntu"), ("raspbian", "Raspberry Pi OS"), ("debian", "Debian"), ("freebsd", "FreeBSD"), ("openbsd", "OpenBSD"), ("dropbear", "embedded Linux (Dropbear)"), ("windows", "Windows"), ("rosssh", "RouterOS")] {
        if b.contains(word) {
            return Some(os.into());
        }
    }
    None
}

/// 一台主機的線索 → 它是什麼。`gateway` = 它是裝置的預設閘道（就算認不出產品也是路由器）。
/// A host's clues → what it is. `gateway` = it is the device's default gateway (a router even when the product is unknown).
pub fn identify(services: &[Service], vendor: Option<&str>, ports: &[u16], gateway: bool) -> Option<Identity> {
    let ssh_os = services.iter().filter(|s| s.proto == "ssh").find_map(|s| s.banner.as_deref().and_then(os_from_ssh));
    let iis = services.iter().any(|s| s.server.as_deref().is_some_and(|v| v.to_ascii_lowercase().contains("microsoft-iis")));
    let os = ssh_os.or_else(|| iis.then(|| "Windows".to_string()));
    // 1) 產品表：標題 → Server → 憑證 → realm。/ The product table: title, Server, certificate, realm.
    for r in RULES {
        for s in services {
            let hits: [(&'static str, Option<String>, &[&str]); 4] = [
                ("title", s.title.clone(), r.titles),
                ("server", s.server.clone(), r.servers),
                ("cert", s.cert.as_ref().map(|c| [c.subject.clone(), c.issuer.clone(), c.org.clone()].into_iter().flatten().collect::<Vec<_>>().join(" ")), r.certs),
                ("realm", s.realm.clone(), r.realms),
            ];
            for (source, text, words) in hits {
                if let Some(t) = text.filter(|t| !words.is_empty() && found(t, words)) {
                    return Some(Identity { product: Some(r.product.into()), kind: r.kind, os, by: Clue { source, text: t } });
                }
            }
        }
    }
    // 2) 服務本身就說明類型：IPP / 原始列印 = 印表機、RTSP = 攝影機。/ Services that imply a type.
    if ports.contains(&631) && ports.contains(&9100) || services.iter().any(|s| s.server.as_deref().is_some_and(|v| v.to_ascii_lowercase().contains("ipp"))) {
        return Some(Identity { product: None, kind: "printer", os, by: Clue { source: "ports", text: "631 + 9100".into() } });
    }
    if ports.contains(&554) || services.iter().any(|s| s.proto == "rtsp") {
        let by = Clue { source: "ports", text: "554 (RTSP)".into() };
        return Some(Identity { product: vendor.and_then(|v| VENDOR_KINDS.iter().find(|(w, k, _)| *k == "camera" && found(v, &[w])).and_then(|x| x.2.map(str::to_string))), kind: "camera", os, by });
    }
    // 3) 網卡廠商。/ The NIC vendor.
    if let Some(v) = vendor {
        if let Some((_, kind, product)) = VENDOR_KINDS.iter().find(|(w, _, _)| found(v, &[w])) {
            return Some(Identity { product: product.map(str::to_string), kind, os, by: Clue { source: "vendor", text: v.to_string() } });
        }
    }
    // 4) 閘道 = 路由器。/ The gateway is a router.
    if gateway {
        return Some(Identity { product: None, kind: "router", os, by: Clue { source: "gateway", text: String::new() } });
    }
    // 5) 只有作業系統：Windows（3389 / 445+135）或看得出系統的 SSH = 電腦 / 伺服器。/ An OS only.
    if ports.contains(&3389) || (ports.contains(&445) && ports.contains(&135)) {
        return Some(Identity { product: None, kind: "computer", os: os.or_else(|| Some("Windows".into())), by: Clue { source: "ports", text: if ports.contains(&3389) { "3389 (RDP)".into() } else { "135 + 445".into() } } });
    }
    let ssh_banner = services.iter().filter(|s| s.proto == "ssh").find_map(|s| s.banner.clone());
    if let (Some(o), Some(b)) = (os.clone(), ssh_banner) {
        return Some(Identity { product: None, kind: "server", os: Some(o), by: Clue { source: "banner", text: b } });
    }
    None
}

#[cfg(test)]
mod tests {
    use super::super::fingerprint::{CertInfo, Service};
    use super::*;

    fn web(port: u16, title: &str) -> Service {
        Service { port, proto: "https".into(), status: Some(200), title: Some(title.into()), ..Default::default() }
    }

    #[test]
    fn products_from_titles_servers_and_certs() {
        let pve = identify(&[web(8006, "pve - Proxmox Virtual Environment")], None, &[22, 8006], false).unwrap();
        assert_eq!((pve.product.as_deref(), pve.kind, pve.by.source), (Some("Proxmox VE"), "hypervisor", "title"));
        let syn = identify(&[Service { port: 5001, proto: "https".into(), cert: Some(CertInfo { subject: Some("synology".into()), self_signed: true, ..Default::default() }), ..Default::default() }], None, &[5001], false).unwrap();
        assert_eq!((syn.product.as_deref(), syn.by.source), (Some("Synology DSM"), "cert"));
        let tp = identify(&[Service { port: 80, proto: "http".into(), status: Some(401), realm: Some("TL-WR841N".into()), ..Default::default() }], None, &[80], false).unwrap();
        assert_eq!((tp.product.as_deref(), tp.kind), (Some("TP-Link"), "router"));
        let ha = identify(&[web(8123, "Home Assistant")], Some("Raspberry Pi Trading Ltd"), &[8123], false).unwrap();
        assert_eq!(ha.product.as_deref(), Some("Home Assistant"), "a product beats the vendor");
    }

    #[test]
    fn types_without_a_product() {
        assert_eq!(identify(&[], None, &[631, 9100], false).unwrap().kind, "printer");
        assert_eq!(identify(&[], Some("Hangzhou Hikvision Digital Technology"), &[554, 80], false).unwrap().product.as_deref(), Some("Hikvision"));
        assert_eq!(identify(&[], Some("Raspberry Pi Trading Ltd"), &[22], false).unwrap().product.as_deref(), Some("Raspberry Pi"));
        assert_eq!(identify(&[], None, &[80], true).unwrap().kind, "router");
        let win = identify(&[], None, &[3389, 445], false).unwrap();
        assert_eq!((win.kind, win.os.as_deref()), ("computer", Some("Windows")));
        let ssh = Service { port: 22, proto: "ssh".into(), banner: Some("SSH-2.0-OpenSSH_9.6p1 Ubuntu-3ubuntu13".into()), ..Default::default() };
        let u = identify(&[ssh], None, &[22], false).unwrap();
        assert_eq!((u.kind, u.os.as_deref()), ("server", Some("Ubuntu")));
        assert_eq!(identify(&[], None, &[22], false), None);
        assert_eq!(identify(&[web(80, "Welcome to nginx!")], None, &[80], false), None);
    }

    #[test]
    fn every_rule_uses_a_known_kind() {
        for r in RULES {
            assert!(KINDS.contains(&r.kind), "{}", r.product);
        }
        for (_, k, _) in VENDOR_KINDS {
            assert!(KINDS.contains(k));
        }
    }
}
