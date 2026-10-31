//! 離線 IP 地理資訊（國家 + ISP / ASN），以及位址範圍（公網 / 私有 / loopback…）。
//! 讀 `GEOIP_DIR`（預設 `<DATA_DIR>/geoip`）裡的 DB-IP Lite（`telepy-server geoip` 下載）或 MaxMind GeoLite2 mmdb；
//! 沒有檔案就只回位址範圍。不打任何外部服務：裝置與使用者的 IP 不會送給第三方。
//! 裝置 IP 落在私有範圍，通常代表 SSH 埠前面有 proxy / LB / Docker 轉發把真實來源吃掉了。
//! Offline IP geolocation (country + network owner) from DB-IP Lite or MaxMind GeoLite2 files in
//! GEOIP_DIR, plus the address scope. Nothing is sent to an outside service. A private-scope device
//! address usually means a proxy / load balancer / Docker port forward hides the real source.

use std::net::IpAddr;
use std::path::Path;

use maxminddb::Reader;
use serde::Deserialize;
use serde_json::{json, Value};

/// (檔名, 來源) 依序找第一個存在的。City 版也含國家。/ First existing file wins; City databases include the country.
const COUNTRY_FILES: [(&str, &str); 4] = [
    ("dbip-country-lite.mmdb", "DB-IP"),
    ("dbip-city-lite.mmdb", "DB-IP"),
    ("GeoLite2-Country.mmdb", "MaxMind"),
    ("GeoLite2-City.mmdb", "MaxMind"),
];
const ASN_FILES: [(&str, &str); 2] = [("dbip-asn-lite.mmdb", "DB-IP"), ("GeoLite2-ASN.mmdb", "MaxMind")];

#[derive(Default)]
pub struct GeoIp {
    country: Option<(Reader<Vec<u8>>, &'static str)>,
    asn: Option<(Reader<Vec<u8>>, &'static str)>,
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Geo {
    /// ISO 3166-1 alpha-2
    pub country: Option<String>,
    pub org: Option<String>,
    pub asn: Option<u32>,
    pub source: Option<&'static str>,
}

#[derive(Deserialize)]
struct CountryRecord {
    country: Option<IsoCode>,
    registered_country: Option<IsoCode>,
}

#[derive(Deserialize)]
struct IsoCode {
    iso_code: Option<String>,
}

#[derive(Deserialize)]
struct AsnRecord {
    autonomous_system_number: Option<u32>,
    autonomous_system_organization: Option<String>,
}

fn open(dir: &Path, files: &[(&str, &'static str)]) -> Option<(Reader<Vec<u8>>, &'static str)> {
    for (name, source) in files {
        let path = dir.join(name);
        if !path.is_file() {
            continue;
        }
        match Reader::open_readfile(&path) {
            Ok(r) => {
                tracing::info!(path = %path.display(), source, "geoip database loaded");
                return Some((r, source));
            }
            Err(e) => tracing::warn!(path = %path.display(), error = %e, "geoip database cannot be read"),
        }
    }
    None
}

impl GeoIp {
    pub fn load(dir: &Path) -> Self {
        Self { country: open(dir, &COUNTRY_FILES), asn: open(dir, &ASN_FILES) }
    }

    pub fn enabled(&self) -> bool {
        self.country.is_some() || self.asn.is_some()
    }

    /// 只查公網位址；查不到或沒有資料庫回 None。/ Public addresses only; None without data.
    pub fn lookup(&self, ip: IpAddr) -> Option<Geo> {
        if scope(ip) != Scope::Public || !self.enabled() {
            return None;
        }
        let mut geo = Geo::default();
        if let Some((r, source)) = &self.country {
            if let Ok(Some(rec)) = r.lookup(ip).and_then(|l| l.decode::<CountryRecord>()) {
                geo.country = rec.country.or(rec.registered_country).and_then(|c| c.iso_code);
                geo.source = Some(source);
            }
        }
        if let Some((r, source)) = &self.asn {
            if let Ok(Some(rec)) = r.lookup(ip).and_then(|l| l.decode::<AsnRecord>()) {
                geo.asn = rec.autonomous_system_number;
                geo.org = rec.autonomous_system_organization;
                geo.source.get_or_insert(source);
            }
        }
        (geo.country.is_some() || geo.org.is_some()).then_some(geo)
    }

    /// API 用的 `geo` 物件：`{scope, country, org, asn, source}`；ip 無法解析回 null。
    /// The `geo` object attached next to an `ip` in API responses.
    pub fn json(&self, ip: Option<&str>) -> Value {
        let Some(addr) = ip.and_then(|s| s.parse::<IpAddr>().ok()) else { return Value::Null };
        let g = self.lookup(addr).unwrap_or_default();
        json!({ "scope": scope(addr).as_str(), "country": g.country, "org": g.org, "asn": g.asn, "source": g.source })
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Public,
    /// RFC 1918 / IPv6 ULA
    Private,
    Loopback,
    LinkLocal,
    /// 100.64.0.0/10（電信商級 NAT）。/ Carrier-grade NAT.
    SharedNat,
    /// unspecified / multicast / broadcast / 保留段。/ Everything else that is not routable.
    Reserved,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Scope::Public => "public",
            Scope::Private => "private",
            Scope::Loopback => "loopback",
            Scope::LinkLocal => "link_local",
            Scope::SharedNat => "shared_nat",
            Scope::Reserved => "reserved",
        }
    }
}

pub fn scope(ip: IpAddr) -> Scope {
    match ip.to_canonical() {
        IpAddr::V4(v4) => {
            let o = v4.octets();
            if v4.is_loopback() {
                Scope::Loopback
            } else if v4.is_private() {
                Scope::Private
            } else if v4.is_link_local() {
                Scope::LinkLocal
            } else if o[0] == 100 && (o[1] & 0xc0) == 64 {
                Scope::SharedNat
            } else if v4.is_unspecified() || v4.is_multicast() || v4.is_broadcast() || o[0] == 0 || o[0] >= 240 {
                Scope::Reserved
            } else {
                Scope::Public
            }
        }
        IpAddr::V6(v6) => {
            let first = v6.segments()[0];
            if v6.is_loopback() {
                Scope::Loopback
            } else if (first & 0xfe00) == 0xfc00 {
                Scope::Private
            } else if (first & 0xffc0) == 0xfe80 {
                Scope::LinkLocal
            } else if v6.is_unspecified() || v6.is_multicast() {
                Scope::Reserved
            } else {
                Scope::Public
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn s(ip: &str) -> &'static str {
        scope(ip.parse().unwrap()).as_str()
    }

    #[test]
    fn classifies_address_scopes() {
        assert_eq!(s("127.0.0.1"), "loopback");
        assert_eq!(s("::1"), "loopback");
        assert_eq!(s("10.1.2.3"), "private");
        assert_eq!(s("172.18.0.1"), "private");
        assert_eq!(s("192.168.65.1"), "private");
        assert_eq!(s("fd12:3456::1"), "private");
        assert_eq!(s("169.254.1.1"), "link_local");
        assert_eq!(s("fe80::1"), "link_local");
        assert_eq!(s("100.64.0.1"), "shared_nat");
        assert_eq!(s("100.127.255.254"), "shared_nat");
        assert_eq!(s("100.128.0.1"), "public");
        assert_eq!(s("0.0.0.0"), "reserved");
        assert_eq!(s("224.0.0.1"), "reserved");
        assert_eq!(s("8.8.8.8"), "public");
        assert_eq!(s("2001:4860:4860::8888"), "public");
        assert_eq!(s("::ffff:10.0.0.1"), "private", "IPv4-mapped is unmapped first");
    }

    #[test]
    fn without_databases_only_the_scope_is_known() {
        let g = GeoIp::load(Path::new("/nonexistent"));
        assert!(!g.enabled());
        assert_eq!(g.lookup("8.8.8.8".parse().unwrap()), None);
        assert_eq!(g.json(Some("8.8.8.8")), json!({"scope": "public", "country": null, "org": null, "asn": null, "source": null}));
        assert_eq!(g.json(Some("172.18.0.1"))["scope"], "private");
        assert_eq!(g.json(Some("not-an-ip")), Value::Null);
        assert_eq!(g.json(None), Value::Null);
    }

    /// 有下載好的 DB-IP Lite 時（`GEOIP_TEST_DIR`）才跑。/ Runs only when GEOIP_TEST_DIR points at real databases.
    #[test]
    fn looks_up_real_databases_when_available() {
        let Ok(dir) = std::env::var("GEOIP_TEST_DIR") else { return };
        let g = GeoIp::load(Path::new(&dir));
        assert!(g.enabled());
        let google = g.lookup("8.8.8.8".parse().unwrap()).expect("8.8.8.8 is in every database");
        assert_eq!(google.country.as_deref(), Some("US"));
        assert_eq!(google.asn, Some(15169));
        assert!(google.source.is_some());
        assert_eq!(g.lookup("10.0.0.1".parse().unwrap()), None, "private addresses are never looked up");
    }
}
