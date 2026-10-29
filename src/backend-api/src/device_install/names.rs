//! 裝置上的名稱：每條隧道一個隨機的安裝代號（`k7m2q9xd`），所有裝在裝置上的東西都從它取名。
//!
//! 代號不含使用者名稱、伺服器網域或隧道名稱（隧道可以改名，裝置上的名稱不必跟著改），而且記在隧道上
//! （`telepy_device_install`），所以清理時知道確切的名稱，不用猜。為什麼不用雜湊：沒有紀錄就算不出原本的
//! 名稱，`SECRET_KEY` 一換也全變了；隨機 + 紀錄一樣乾淨，裝置管理員在 Telepy 搜尋這個代號就找得到隧道。
//!
//! Names on the device: every tunnel gets a random install id and everything Telepy puts on a device is named
//! after it. The id carries no user name, server domain or tunnel name (renaming a tunnel never touches the
//! device), and it is recorded on the tunnel, so cleanup knows the exact names. A hash was rejected: without the
//! record nobody can recompute it either, and rotating `SECRET_KEY` would change every name.

use rand::Rng;

/// 不易看錯的字元（沒有 0 / 1 / l / o）。/ Unambiguous characters (no 0 / 1 / l / o).
const ALPHABET: &[u8] = b"abcdefghijkmnpqrstuvwxyz23456789";
pub const ID_LEN: usize = 8;

pub fn new_id() -> String {
    let mut rng = rand::thread_rng();
    (0..ID_LEN).map(|_| ALPHABET[rng.gen_range(0..ALPHABET.len())] as char).collect()
}

/// 形狀對不對（腳本、路徑裡會用到，只收小寫英數）。/ Shape check: it goes into scripts and paths.
pub fn is_id(s: &str) -> bool {
    (6..=16).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// 一條隧道在裝置上的所有名稱。/ Every name a tunnel uses on a device.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Names {
    pub id: String,
}

impl Names {
    pub fn new(id: &str) -> Self {
        Self { id: id.to_string() }
    }
    /// `telepy-k7m2q9xd`：systemd unit、迴圈腳本、容器、log 目錄的主幹。/ The stem of units, runners, containers, log dirs.
    pub fn base(&self) -> String {
        format!("telepy-{}", self.id)
    }
    pub fn unit(&self) -> String {
        format!("{}.service", self.base())
    }
    pub fn launchd_label(&self) -> String {
        format!("com.telepy.tunnel.{}", self.id)
    }
    pub fn known_hosts(&self) -> String {
        format!("{}.known_hosts", self.base())
    }
    pub fn runner(&self) -> String {
        format!("{}.sh", self.base())
    }
    pub fn log(&self) -> String {
        format!("{}.log", self.base())
    }
    pub fn uninstall(&self) -> String {
        format!("{}-uninstall.sh", self.base())
    }
    pub fn ws_py(&self) -> String {
        format!("{}-ws.py", self.base())
    }
    pub fn ws_sh(&self) -> String {
        format!("{}-ws.sh", self.base())
    }
    /// unit / plist 的說明：只有代號。/ The unit's description: the id only.
    pub fn description(&self) -> String {
        format!("Telepy reverse tunnel {}", self.id)
    }
    /// 這個名稱（unit、label、路徑、指令列）是不是用這個代號取的。/ Was this name (unit, label, path, command) made from the id.
    pub fn owns(&self, name: &str) -> bool {
        name.contains(&self.base()) || name.contains(&self.launchd_label())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_short_lowercase_and_unambiguous() {
        for _ in 0..200 {
            let id = new_id();
            assert_eq!(id.len(), ID_LEN);
            assert!(is_id(&id), "{id}");
            assert!(!id.contains(['0', '1', 'l', 'o']), "{id}");
        }
        assert_ne!(new_id(), new_id());
        for bad in ["", "abc", "ABCDEFGH", "abcd efg", "abc-defg", "abcdefgh/", "a".repeat(17).as_str()] {
            assert!(!is_id(bad), "{bad}");
        }
    }

    #[test]
    fn names_carry_only_the_id() {
        let n = Names::new("k7m2q9xd");
        assert_eq!(n.unit(), "telepy-k7m2q9xd.service");
        assert_eq!(n.launchd_label(), "com.telepy.tunnel.k7m2q9xd");
        assert_eq!(n.known_hosts(), "telepy-k7m2q9xd.known_hosts");
        assert_eq!(n.runner(), "telepy-k7m2q9xd.sh");
        assert_eq!(n.log(), "telepy-k7m2q9xd.log");
        assert_eq!(n.uninstall(), "telepy-k7m2q9xd-uninstall.sh");
        assert_eq!((n.ws_py(), n.ws_sh()), ("telepy-k7m2q9xd-ws.py".into(), "telepy-k7m2q9xd-ws.sh".into()));
        assert_eq!(n.description(), "Telepy reverse tunnel k7m2q9xd");
        assert!(n.owns("/etc/systemd/system/telepy-k7m2q9xd.service"));
        assert!(n.owns("/Library/LaunchDaemons/com.telepy.tunnel.k7m2q9xd.plist"));
        assert!(n.owns("ssh -o UserKnownHostsFile=/root/.ssh/telepy-k7m2q9xd.known_hosts -R 0:localhost:22 x"));
        for other in ["telepy-natlee.service", "info.natlee.telepy", "telepy-tunnel-12.service", "com.telepy.tunnel.12", "telepy-k7m2q9xe.service"] {
            assert!(!n.owns(other), "{other}");
        }
    }
}
