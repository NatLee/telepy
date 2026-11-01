//! 網卡廠商（IEEE OUI，MA-L：MAC 的前 24 位元）。讀 `<DATA_DIR>/oui/oui.csv`（`telepy-server oui` 從 IEEE 下載），
//! 沒有檔案就不顯示廠商。查詢完全在本機。另外辨識「私有（隨機）MAC」：第一個位元組的 locally administered
//! 位元為 1，手機與新版作業系統連 Wi-Fi 時常用，這種位址查不到廠商。
//! NIC vendors from IEEE's public OUI registry (MA-L, the first 24 bits of a MAC) in `<DATA_DIR>/oui/oui.csv`;
//! no file = no vendors. Also flags locally administered ("private", randomized) MACs.

use std::collections::HashMap;
use std::path::Path;
use std::sync::RwLock;

pub const FILE: &str = "oui.csv";

/// 表放在鎖裡：資料夾裡的檔案換了（自動更新、`telepy-server oui`）就整張換掉，不必重啟。
/// The table sits behind a lock, so a new file (automatic update, `telepy-server oui`) replaces it without a restart.
#[derive(Default)]
pub struct Oui {
    map: RwLock<HashMap<u32, Box<str>>>,
}

/// 一行 CSV（支援雙引號與 `""` 跳脫）。/ Split one CSV line (quotes and `""` escapes).
fn csv_fields(line: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quoted = false;
    let mut chars = line.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '"' if quoted && chars.peek() == Some(&'"') => {
                cur.push('"');
                chars.next();
            }
            '"' => quoted = !quoted,
            ',' if !quoted => out.push(std::mem::take(&mut cur)),
            _ => cur.push(c),
        }
    }
    out.push(cur);
    out
}

/// IEEE 的 `oui.csv`（Registry,Assignment,Organization Name,…）→ 前綴 → 廠商。純函式。
/// Parse IEEE's oui.csv into prefix → organisation. Pure.
pub fn parse_csv(text: &str) -> HashMap<u32, Box<str>> {
    let mut map = HashMap::new();
    for line in text.lines().skip(1) {
        let f = csv_fields(line);
        if f.len() < 3 || f[0] != "MA-L" {
            continue;
        }
        let Ok(prefix) = u32::from_str_radix(f[1].trim(), 16) else { continue };
        let name = f[2].trim();
        if f[1].trim().len() == 6 && !name.is_empty() {
            map.insert(prefix, name.into());
        }
    }
    map
}

/// MAC（`aa:bb:cc:…`、`aa-bb-…`、`aabb.cc…`）的前三個位元組。/ The first three bytes of a MAC, any separator.
pub fn prefix(mac: &str) -> Option<u32> {
    let hex: String = mac.chars().filter(|c| c.is_ascii_hexdigit()).take(6).collect();
    if hex.len() < 6 {
        return None;
    }
    u32::from_str_radix(&hex, 16).ok()
}

/// 本地管理（隨機 / 私有）位址。/ Locally administered ("private", randomized) address.
pub fn is_private(mac: &str) -> bool {
    prefix(mac).is_some_and(|p| (p >> 16) & 0x02 != 0)
}

fn read(dir: &Path) -> HashMap<u32, Box<str>> {
    let path = dir.join(FILE);
    match std::fs::read_to_string(&path) {
        Ok(text) => {
            let map = parse_csv(&text);
            tracing::info!(path = %path.display(), vendors = map.len(), "OUI vendor table loaded");
            map
        }
        Err(_) => HashMap::new(),
    }
}

impl Oui {
    pub fn load(dir: &Path) -> Self {
        Self { map: RwLock::new(read(dir)) }
    }

    /// 重讀資料夾裡的檔案（沒有檔案 = 清空）。/ Read the folder again (no file = empty).
    pub fn reload(&self, dir: &Path) {
        let map = read(dir);
        *self.map.write().unwrap_or_else(|e| e.into_inner()) = map;
    }

    fn table(&self) -> std::sync::RwLockReadGuard<'_, HashMap<u32, Box<str>>> {
        self.map.read().unwrap_or_else(|e| e.into_inner())
    }

    pub fn enabled(&self) -> bool {
        !self.table().is_empty()
    }

    pub fn len(&self) -> usize {
        self.table().len()
    }

    pub fn is_empty(&self) -> bool {
        self.table().is_empty()
    }

    /// 廠商名稱；私有 MAC 或查不到時 None。/ Vendor name; None for private or unknown MACs.
    pub fn vendor(&self, mac: &str) -> Option<String> {
        if is_private(mac) {
            return None;
        }
        self.table().get(&prefix(mac)?).map(|s| s.to_string())
    }

    #[cfg(test)]
    pub fn from_csv(text: &str) -> Self {
        Self { map: RwLock::new(parse_csv(text)) }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "Registry,Assignment,Organization Name,Organization Address\n\
MA-L,286FB9,\"Nokia Shanghai Bell Co., Ltd.\",\"No.388 Ning Qiao Road,Jin Qiao Pudong Shanghai Shanghai   CN 201206 \"\n\
MA-L,B827EB,Raspberry Pi Foundation,Mitchell Wood House Caldecote Cambridgeshire GB CB23 7NU \n\
MA-L,001132,\"Synology \"\"Inc\"\"\",Taipei TW \n\
MA-M,286FB91,Somebody,Somewhere\n";

    #[test]
    fn parses_ieee_csv() {
        let oui = Oui::from_csv(SAMPLE);
        assert_eq!(oui.len(), 3);
        assert_eq!(oui.vendor("28:6f:b9:00:11:22").as_deref(), Some("Nokia Shanghai Bell Co., Ltd."));
        assert_eq!(oui.vendor("B8-27-EB-12-34-56").as_deref(), Some("Raspberry Pi Foundation"));
        assert_eq!(oui.vendor("0011.3200.0000").as_deref(), Some("Synology \"Inc\""));
        assert_eq!(oui.vendor("aa:bb:cc:dd:ee:ff"), None);
        assert_eq!(oui.vendor("b8:27"), None);
    }

    #[test]
    fn private_macs() {
        assert!(is_private("da:a1:19:00:00:01"), "d = 1101: the locally administered bit is set");
        assert!(is_private("02:00:00:00:00:00"));
        assert!(!is_private("b8:27:eb:00:00:01"));
        // 私有 MAC 不查廠商（就算前綴碰巧在表裡）。/ No vendor for private MACs.
        let oui = Oui::from_csv("Registry,Assignment,Organization Name\nMA-L,0A0000,Nope\n");
        assert_eq!(oui.vendor("0a:00:00:11:22:33"), None);
    }

    #[test]
    fn reload_picks_up_a_new_file() {
        let dir = tempfile::tempdir().unwrap();
        let oui = Oui::load(dir.path());
        assert!(!oui.enabled());
        std::fs::write(dir.path().join(FILE), SAMPLE).unwrap();
        oui.reload(dir.path());
        assert_eq!(oui.len(), 3);
        std::fs::remove_file(dir.path().join(FILE)).unwrap();
        oui.reload(dir.path());
        assert!(oui.is_empty());
    }
}
