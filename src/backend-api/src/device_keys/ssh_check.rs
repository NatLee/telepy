//! 「這台電腦的 ssh 進得去這台裝置嗎？」：照真正的路徑一關一關看——gateway 認不認得它送的金鑰（登記過、沒到期、
//! 「個人 SSH 金鑰」功能開著）、這個人能不能連這台裝置、這個帳號允不允許、要不要先在網頁確認身分（step-up）、
//! 裝置在不在線上、裝置那個帳號的 authorized_keys 有沒有那把金鑰。`telepy ssh / scp / sftp` 在交給 OpenSSH 之前問一次
//! （`POST /api/reverse/server/{id}/ssh-check`），被擋的時候就能說清楚為什麼、怎麼修，不是只剩一句
//! `Permission denied (publickey)`。這裡全是純函式；資料由 `api::device_keys::ssh_check` 準備。
//! "Will this computer's ssh get into this device?", checked hop by hop along the real path: does the gateway know a
//! key it offers (registered, unexpired, personal keys turned on), may this person reach the device, is the account
//! allowed, is a step-up confirmation needed, is the device online, and does that account's authorized_keys hold the
//! key. `telepy ssh / scp / sftp` asks once before handing over to OpenSSH, so a refusal comes with the reason and the
//! fix instead of a bare `Permission denied (publickey)`. Pure functions; `api::device_keys::ssh_check` gathers the data.

use serde::Serialize;

/// 一次最多檢查幾把（ssh 預設會送的檔案 + agent 裡的，很少超過十把）。/ At most this many offered keys per check.
pub const MAX_OFFERED: usize = 32;

/// gateway 那一關。/ The gateway hop.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum GatewayState {
    /// 至少一把送出的金鑰是這個人登記過、沒到期的。/ At least one offered key is this person's and unexpired.
    Ok,
    /// 送出的金鑰沒有一把登記在這個人名下。/ None of the offered keys is registered to this person.
    NoKey,
    /// 有登記，但都到期了（gateway 不認到期的金鑰）。/ Registered, but every one has expired.
    Expired,
    /// 「個人 SSH 金鑰」功能對這個人關掉了：gateway 不認他的任何金鑰。/ Personal SSH keys are turned off for this person.
    KeysOff,
}

/// 裝置那一關：一把金鑰在那個帳號上的狀況。/ The device hop: one key on that account.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DeviceState {
    /// Telepy 裝好了。/ Telepy installed it.
    Installed,
    /// 不在 Telepy 的清單上，但上次讀那個帳號的檔案時它在（別的方式加的）。/ Not on Telepy's list, but in the file when last read.
    AddedByHand,
    /// 在清單上，還沒裝上去（裝置離線或同步排隊中）。/ On the list, not installed yet (offline or queued).
    Pending,
    /// 在清單上，但同步那個帳號失敗了。/ On the list, but syncing that account failed.
    Error,
    /// 不在清單上，上次讀檔時也不在：裝置會拒絕。/ Not on the list and not in the file when last read: refused.
    NotOnDevice,
    /// 不在清單上；Telepy 這次啟動後沒讀過那個帳號的檔案，所以不確定有沒有別的方式加進去。
    /// Not on the list; Telepy hasn't read that account's file since it started, so it may have been added another way.
    NotListed,
    /// 沒有能過 gateway 的金鑰，裝置那一關無從看起。/ No key passes the gateway, so the device hop can't be judged.
    Unknown,
}

impl DeviceState {
    /// 越小越好：挑送出的金鑰裡最可能進得去的那把。/ Lower is better: picks the offered key most likely to get in.
    fn rank(self) -> u8 {
        match self {
            Self::Installed => 0,
            Self::AddedByHand => 1,
            Self::Pending => 2,
            Self::Error => 3,
            Self::NotListed => 4,
            Self::NotOnDevice => 5,
            Self::Unknown => 6,
        }
    }
}

/// 擋在路上的東西，照路徑順序（先修前面的）。/ What stands in the way, in path order (fix the first one first).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Problem {
    KeysOff,
    NoKey,
    KeyExpired,
    /// 看得到隧道，但沒有任何能用的帳號（只看狀態的分享）。/ Sees the tunnel, may use no account (status-only share).
    NoAccess,
    AccountNotAllowed,
    StepUp,
    Offline,
    NotOnDevice,
    /// 不確定（見 [`DeviceState::NotListed`]）。/ Uncertain (see [`DeviceState::NotListed`]).
    NotListed,
    Pending,
    SyncError,
}

/// 送出的金鑰裡、屬於這個人的那幾把（照送出的順序）。/ The offered keys that are this person's, in offered order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Mine {
    pub fingerprint: String,
    pub expired: bool,
}

pub fn gateway_state(keys_off: bool, mine: &[Mine]) -> GatewayState {
    if keys_off {
        GatewayState::KeysOff
    } else if mine.iter().any(|k| !k.expired) {
        GatewayState::Ok
    } else if mine.is_empty() {
        GatewayState::NoKey
    } else {
        GatewayState::Expired
    }
}

/// 一把金鑰在那個帳號上：`listed` = 它在 Telepy 清單上的狀態（`installed` / `pending` / `error`，不在清單 = None），
/// `in_file` = 這次啟動後讀過那個帳號的檔案時它在不在（沒讀過 = None）。
/// One key on that account: `listed` = its status on Telepy's list (None = not listed), `in_file` = whether the
/// account's file held it when last read (None = not read since start).
pub fn device_state(listed: Option<&str>, in_file: Option<bool>) -> DeviceState {
    match (listed, in_file) {
        (Some("installed"), _) => DeviceState::Installed,
        (Some("error"), _) => DeviceState::Error,
        // 清單上的還沒裝好，但檔案裡已經有（手動加過）：照樣進得去。/ Listed, not installed, yet in the file: it works.
        (Some(_), Some(true)) => DeviceState::AddedByHand,
        (Some(_), _) => DeviceState::Pending,
        (None, Some(true)) => DeviceState::AddedByHand,
        (None, Some(false)) => DeviceState::NotOnDevice,
        (None, None) => DeviceState::NotListed,
    }
}

/// 最好的那把（同樣好時取先送出的）。/ The best of the candidates (the first offered on a tie).
pub fn best(states: &[DeviceState]) -> Option<usize> {
    states.iter().enumerate().min_by_key(|(i, s)| (s.rank(), *i)).map(|(i, _)| i)
}

/// 判斷要的事實。/ The facts the verdict needs.
#[derive(Debug, Clone, Copy)]
pub struct Facts {
    pub gateway: GatewayState,
    /// `permissions::can_reach_device`：擁有者 / ADMIN / 至少一個允許的帳號。/ Owner, ADMIN or ≥ 1 allowed account.
    pub reach: bool,
    pub account_allowed: bool,
    /// 敏感隧道而且這個人最近沒在網頁確認過。/ A step-up tunnel without a recent web confirmation.
    pub step_up: bool,
    pub online: bool,
    pub device: DeviceState,
}

/// 照路徑順序列出擋路的東西；空的 = Telepy 知道的部分都沒問題。
/// What stands in the way, in path order; empty = nothing Telepy knows of.
pub fn problems(f: &Facts) -> Vec<Problem> {
    let mut out = Vec::new();
    match f.gateway {
        GatewayState::Ok => {}
        GatewayState::KeysOff => out.push(Problem::KeysOff),
        GatewayState::NoKey => out.push(Problem::NoKey),
        GatewayState::Expired => out.push(Problem::KeyExpired),
    }
    if !f.reach {
        out.push(Problem::NoAccess);
    } else if !f.account_allowed {
        out.push(Problem::AccountNotAllowed);
    }
    if f.step_up {
        out.push(Problem::StepUp);
    }
    if !f.online {
        out.push(Problem::Offline);
    }
    if f.gateway == GatewayState::Ok && f.account_allowed {
        match f.device {
            DeviceState::NotOnDevice => out.push(Problem::NotOnDevice),
            DeviceState::NotListed => out.push(Problem::NotListed),
            DeviceState::Pending => out.push(Problem::Pending),
            DeviceState::Error => out.push(Problem::SyncError),
            DeviceState::Installed | DeviceState::AddedByHand | DeviceState::Unknown => {}
        }
    }
    out
}

/// 讓這把金鑰進到那個帳號，清單那一列要選哪些帳號：不在清單上（或只經由金鑰群組）= 只有這個帳號；
/// 已經直接在清單上但只選了別的帳號 = 原本的加上這個；選「全部」= 不用改（None）。跟網頁「加我的金鑰」一樣，
/// 絕不擴大成「每個帳號」。
/// The accounts the list entry should name so the key reaches this account: not listed directly = only this account;
/// listed for other accounts = those plus this one; listed for all = nothing to change (None). Like the web's "Add my
/// keys", never widened to every account.
pub fn place_accounts(direct: Option<Option<&[i64]>>, account_id: i64) -> Option<Vec<i64>> {
    match direct {
        None => Some(vec![account_id]),
        Some(None) => None,
        Some(Some(ids)) if ids.contains(&account_id) => None,
        Some(Some(ids)) => {
            let mut v: Vec<i64> = ids.to_vec();
            v.push(account_id);
            v.sort_unstable();
            v.dedup();
            Some(v)
        }
    }
}

/// `SHA256:<43 個 base64 字>`（OpenSSH 的指紋格式；`=` 可有可無）。/ An OpenSSH SHA256 fingerprint.
pub fn valid_fingerprint(fp: &str) -> bool {
    let Some(b64) = fp.strip_prefix("SHA256:") else { return false };
    let b64 = b64.trim_end_matches('=');
    b64.len() == 43 && b64.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'+' || c == b'/')
}

#[cfg(test)]
mod tests {
    use super::*;

    fn mine(expired: &[bool]) -> Vec<Mine> {
        expired.iter().enumerate().map(|(i, e)| Mine { fingerprint: format!("fp{i}"), expired: *e }).collect()
    }

    #[test]
    fn the_gateway_hop() {
        assert_eq!(gateway_state(false, &[]), GatewayState::NoKey);
        assert_eq!(gateway_state(false, &mine(&[true])), GatewayState::Expired);
        assert_eq!(gateway_state(false, &mine(&[true, false])), GatewayState::Ok);
        // 功能關掉：有金鑰也沒用。/ Feature off: keys don't help.
        assert_eq!(gateway_state(true, &mine(&[false])), GatewayState::KeysOff);
    }

    #[test]
    fn the_device_hop() {
        assert_eq!(device_state(Some("installed"), None), DeviceState::Installed);
        assert_eq!(device_state(Some("installed"), Some(false)), DeviceState::Installed, "Telepy's own record wins over an older read");
        assert_eq!(device_state(Some("pending"), None), DeviceState::Pending);
        assert_eq!(device_state(Some("pending"), Some(true)), DeviceState::AddedByHand);
        assert_eq!(device_state(Some("error"), Some(true)), DeviceState::Error);
        assert_eq!(device_state(None, Some(true)), DeviceState::AddedByHand);
        assert_eq!(device_state(None, Some(false)), DeviceState::NotOnDevice);
        assert_eq!(device_state(None, None), DeviceState::NotListed);
        use DeviceState::*;
        assert_eq!(best(&[NotListed, Pending, Installed]), Some(2));
        assert_eq!(best(&[Pending, Pending]), Some(0), "a tie goes to the key ssh offers first");
        assert_eq!(best(&[NotOnDevice, NotListed]), Some(1), "uncertain beats certainly refused");
        assert_eq!(best(&[]), None);
    }

    fn facts() -> Facts {
        Facts { gateway: GatewayState::Ok, reach: true, account_allowed: true, step_up: false, online: true, device: DeviceState::Installed }
    }

    #[test]
    fn problems_come_in_path_order() {
        assert!(problems(&facts()).is_empty());
        assert!(problems(&Facts { device: DeviceState::AddedByHand, ..facts() }).is_empty());
        assert_eq!(problems(&Facts { device: DeviceState::NotListed, ..facts() }), [Problem::NotListed]);
        assert_eq!(problems(&Facts { device: DeviceState::Error, ..facts() }), [Problem::SyncError]);
        // 沒有金鑰：裝置那一關不看（無從看起），其他獨立的照列。/ No key: the device hop is skipped, independent ones still listed.
        let f = Facts { gateway: GatewayState::NoKey, online: false, device: DeviceState::Unknown, ..facts() };
        assert_eq!(problems(&f), [Problem::NoKey, Problem::Offline]);
        let f = Facts { gateway: GatewayState::Expired, step_up: true, device: DeviceState::Unknown, ..facts() };
        assert_eq!(problems(&f), [Problem::KeyExpired, Problem::StepUp]);
        // 連不到裝置：帳號那一項不重複說。/ No access at all: the account isn't mentioned separately.
        let f = Facts { reach: false, account_allowed: false, device: DeviceState::Unknown, ..facts() };
        assert_eq!(problems(&f), [Problem::NoAccess]);
        let f = Facts { account_allowed: false, device: DeviceState::NotListed, ..facts() };
        assert_eq!(problems(&f), [Problem::AccountNotAllowed], "an account you may not use has no device hop to judge");
        // 離線又排隊中：兩個都說（上線後就會裝上）。/ Offline and queued: both (it installs once the device is back).
        let f = Facts { online: false, device: DeviceState::Pending, ..facts() };
        assert_eq!(problems(&f), [Problem::Offline, Problem::Pending]);
        assert_eq!(problems(&Facts { gateway: GatewayState::KeysOff, device: DeviceState::Unknown, ..facts() }), [Problem::KeysOff]);
    }

    #[test]
    fn placing_never_widens_to_every_account() {
        assert_eq!(place_accounts(None, 7), Some(vec![7]));
        assert_eq!(place_accounts(Some(None), 7), None);
        assert_eq!(place_accounts(Some(Some(&[7, 9])), 7), None);
        assert_eq!(place_accounts(Some(Some(&[9, 3])), 7), Some(vec![3, 7, 9]));
    }

    #[test]
    fn fingerprints() {
        assert!(valid_fingerprint("SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU"));
        assert!(valid_fingerprint("SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU="));
        assert!(!valid_fingerprint("MD5:aa:bb"));
        assert!(!valid_fingerprint("SHA256:short"));
        assert!(!valid_fingerprint("SHA256:47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSu\"U"));
    }
}
