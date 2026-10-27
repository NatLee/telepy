//! 有人用個人金鑰直接 `ssh telepy@<伺服器>`（或 SSH config 的伺服器別名）時印的招呼：gateway 沒有 shell，
//! 告訴他怎麼連到自己的裝置、能連哪些，然後就結束（什麼都不執行）。純函式，`mod.rs` 負責查資料與送出。
//! The greeting printed when someone ssh-es straight into the gateway with a personal key: it has no shell, so say
//! how to reach their devices and which ones, then end (nothing is ever run). Pure; `mod.rs` looks things up and sends it.

use crate::mascot::{self, Paint};

/// 最多列幾台裝置。/ How many device names are listed at most.
pub const MAX_DEVICES: usize = 8;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Lang {
    En,
    ZhTw,
    Ja,
}

impl Lang {
    /// 使用者設定的 `language`（沒選過 / 不認得 = 英文）。/ The user's `language` setting (unset / unknown = English).
    pub fn from_setting(language: Option<&str>) -> Lang {
        match language {
            Some("zh-TW") => Lang::ZhTw,
            Some("ja") => Lang::Ja,
            _ => Lang::En,
        }
    }
}

struct Words {
    hello: &'static str,
    no_shell: &'static str,
    ways: &'static str,
    via_config: &'static str,
    via_cli: &'static str,
    device: &'static str,
    tunnel: &'static str,
    reach: &'static str,
    more: &'static str,
    none: &'static str,
    none_url: &'static str,
    sign_off: &'static str,
}

fn words(lang: Lang) -> Words {
    match lang {
        Lang::En => Words {
            hello: "Hi {user} — this is Telepy's gateway.",
            no_shell: "It has no shell of its own; it is the way through to your devices.",
            ways: "Two ways in:",
            via_config: "Set up the SSH config once (Tunnels page → \"SSH config\", or `telepy config install`), then:",
            via_cli: "With the telepy CLI:",
            device: "<device>",
            tunnel: "<tunnel>",
            reach: "Devices you can reach:",
            more: "(+{n} more)",
            none: "There are no devices for you to reach yet. Create one on the web first.",
            none_url: "There are no devices for you to reach yet. Create one on the web first: {url}",
            sign_off: "— Tapi, Telepy's little ghost",
        },
        Lang::ZhTw => Words {
            hello: "嗨 {user}，這裡是 Telepy 的 gateway。",
            no_shell: "它自己沒有 shell，是通往你的裝置的那條路。",
            ways: "兩種連法：",
            via_config: "先設定一次 SSH 設定（通道頁 →「SSH 設定」，或 `telepy config install`），之後：",
            via_cli: "用 telepy CLI：",
            device: "<裝置>",
            tunnel: "<通道>",
            reach: "你可以連的裝置：",
            more: "（還有 {n} 台）",
            none: "目前還沒有你可以連的裝置，先到網頁上建立一台吧。",
            none_url: "目前還沒有你可以連的裝置，先到網頁上建立一台吧：{url}",
            sign_off: "— Tapi，Telepy 的小幽靈",
        },
        Lang::Ja => Words {
            hello: "こんにちは、{user} さん。ここは Telepy のゲートウェイです。",
            no_shell: "ゲートウェイ自体にシェルはありません。あなたのデバイスへ通じる道です。",
            ways: "つなぎ方は 2 つ：",
            via_config: "SSH 設定を一度入れておく（トンネル画面 →「SSH 設定」、または `telepy config install`）と：",
            via_cli: "telepy CLI なら：",
            device: "<デバイス>",
            tunnel: "<トンネル>",
            reach: "接続できるデバイス：",
            more: "（ほか {n} 台）",
            none: "接続できるデバイスはまだありません。まず Web で作成してください。",
            none_url: "接続できるデバイスはまだありません。まず Web で作成してください：{url}",
            sign_off: "— Tapi（Telepy の小さなおばけ）",
        },
    }
}

/// 裝置名稱清單：照名稱排序後最多 [`MAX_DEVICES`] 個，其餘說「還有 N 台」。
/// The device list: at most [`MAX_DEVICES`] names, the rest summed up as "+N more".
fn device_list(lang: Lang, devices: &[String]) -> String {
    let c = words(lang);
    let sep = if lang == Lang::En { ", " } else { "、" };
    let shown: Vec<&str> = devices.iter().take(MAX_DEVICES).map(String::as_str).collect();
    let mut out = shown.join(sep);
    if devices.len() > MAX_DEVICES {
        if lang == Lang::En {
            out.push(' ');
        }
        out.push_str(&c.more.replace("{n}", &(devices.len() - MAX_DEVICES).to_string()));
    }
    out
}

/// 招呼全文（行尾 `\r\n`）。`tty` = 客戶端要了 pty：上面畫 Tapi、指令上一點顏色；沒有 pty（exec）= 純文字、沒有任何跳脫碼。
/// `devices` 已照名稱排序；`clip` = Tapi 十字髮夾的顏色（None = 預設）。/ The whole greeting with `\r\n` line ends. With a pty: Tapi on top and a little colour;
/// without one (exec): plain text, no escape codes at all. `devices` are sorted by name already.
pub fn text(lang: Lang, username: &str, devices: &[String], tty: bool, public_url: Option<&str>, clip: Option<[u8; 3]>) -> String {
    let c = words(lang);
    // 只有 pty 時才上色：指令粗體、裝置名稱用品牌橘。/ Colour only with a pty: commands bold, device names in the brand orange.
    let cmd = |s: &str| if tty { format!("\x1b[1m{s}\x1b[0m") } else { s.to_string() };
    let name = |s: &str| if tty { format!("\x1b[38;5;172m{s}\x1b[0m") } else { s.to_string() };
    let mut lines: Vec<String> = Vec::new();
    if tty {
        // 十字髮夾是這個人在「關於 Telepy」選的顏色。/ The clips wear the colour this person picked.
        for row in mascot::render_with(mascot::WAVE, Paint::Ansi256, clip) {
            lines.push(format!("  {row}"));
        }
        lines.push(String::new());
    }
    lines.push(c.hello.replace("{user}", username));
    lines.push(c.no_shell.to_string());
    lines.push(String::new());
    lines.push(c.ways.to_string());
    lines.push(format!("  1. {}", c.via_config));
    lines.push(format!("       {}", cmd(&format!("ssh {}", c.device))));
    lines.push(format!("  2. {}", c.via_cli));
    lines.push(format!("       {}", cmd(&format!("telepy ssh {}", c.tunnel))));
    lines.push(String::new());
    if devices.is_empty() {
        lines.push(match public_url.filter(|u| !u.is_empty()) {
            Some(url) => c.none_url.replace("{url}", url),
            None => c.none.to_string(),
        });
    } else {
        let list = device_list(lang, devices);
        lines.push(format!("{} {}", c.reach, name(&list)));
    }
    lines.push(String::new());
    lines.push(c.sign_off.to_string());
    let mut out = lines.join("\r\n");
    out.push_str("\r\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn names(n: usize) -> Vec<String> {
        (0..n).map(|i| format!("dev{i:02}")).collect()
    }

    #[test]
    fn every_language_names_the_devices_and_the_ways_in() {
        for lang in [Lang::En, Lang::ZhTw, Lang::Ja] {
            let t = text(lang, "alice", &["db".into(), "web".into()], false, None, None);
            assert!(t.contains("alice") && t.contains("Telepy"), "{t}");
            assert!(t.contains("db") && t.contains("web"), "{t}");
            assert!(t.contains("ssh <") && t.contains("telepy ssh <") && t.contains("telepy config install"), "{t}");
            assert!(t.contains("Tapi"), "{t}");
            assert!(t.ends_with("\r\n") && !t.replace("\r\n", "").contains('\n'), "only CRLF line ends: {t:?}");
        }
        assert!(text(Lang::ZhTw, "a", &[], false, None, None).contains("通道頁"));
        assert!(text(Lang::Ja, "a", &[], false, None, None).contains("トンネル画面"));
    }

    #[test]
    fn languages_come_from_the_setting() {
        assert_eq!(Lang::from_setting(Some("zh-TW")), Lang::ZhTw);
        assert_eq!(Lang::from_setting(Some("ja")), Lang::Ja);
        assert_eq!(Lang::from_setting(Some("fr")), Lang::En);
        assert_eq!(Lang::from_setting(None), Lang::En);
    }

    #[test]
    fn at_most_eight_names_then_a_count() {
        let t = text(Lang::En, "alice", &names(11), false, None, None);
        assert!(t.contains("dev07") && !t.contains("dev08"), "{t}");
        assert!(t.contains("dev06, dev07 (+3 more)"), "{t}");
        let t = text(Lang::ZhTw, "alice", &names(9), false, None, None);
        assert!(t.contains("dev07（還有 1 台）"), "{t}");
        let t = text(Lang::Ja, "alice", &names(8), false, None, None);
        assert!(t.contains("dev07") && !t.contains("ほか"), "{t}");
    }

    #[test]
    fn no_devices_points_to_the_web() {
        let t = text(Lang::En, "alice", &[], false, Some("https://telepy.example"), None);
        assert!(t.contains("no devices") && t.contains("https://telepy.example"), "{t}");
        let t = text(Lang::En, "alice", &[], false, None, None);
        assert!(t.contains("Create one on the web first.") && !t.contains("http"), "{t}");
    }

    #[test]
    fn plain_without_a_pty_and_tapi_with_one() {
        for lang in [Lang::En, Lang::ZhTw, Lang::Ja] {
            let plain = text(lang, "alice", &names(3), false, None, None);
            assert!(!plain.contains('\x1b') && !plain.contains('▀'), "{plain}");
            let tty = text(lang, "alice", &names(3), true, None, None);
            assert!(tty.contains('\x1b') && tty.contains('▀'), "{tty}");
            assert!(tty.lines().count() > plain.lines().count() + mascot::rows(mascot::WAVE) - 1);
        }
    }
}
