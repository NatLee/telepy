//! `telepy login` 換到 token 之後，瀏覽器那一頁要看到什麼：伺服器有完成頁（metadata 的 `telepy_cli_done_page`）
//! 就把瀏覽器導過去（跟著網站的語言、主題與授權頁的樣子，還列出這個 CLI 能做什麼）；舊伺服器沒有，就畫 CLI 自己的一頁
//! （照 Accept-Language 選英文 / 繁中 / 日文、跟著系統深淺色）。這裡都是純函式。
//! What the browser shows once `telepy login` has its token: when the server has a done page (`telepy_cli_done_page`
//! in its metadata) the browser is sent there (in the site's language, theme and approval-page look, with what the
//! CLI may do now); an older server has none, so the CLI draws its own page (English / Traditional Chinese /
//! Japanese from Accept-Language, light or dark from the system). Pure functions only.

/// 登入的結果。/ How the sign-in ended.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Ok,
    /// 在同意頁按了拒絕。/ Denied on the approval page.
    Denied,
    Failed(Failure),
}

/// 沒完成的原因（只有這幾個固定的字，頁面不顯示任意文字）。/ Why it failed (fixed words, never free text on the page).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Failure {
    /// 回呼的 state 對不上（別的登入、或被動過手腳）。/ The callback's state did not match.
    State,
    /// 授權碼換不到 token。/ The code could not be exchanged for a token.
    Exchange,
    /// 伺服器回了別的 OAuth 錯誤。/ Another OAuth error from the server.
    Error,
}

impl Outcome {
    fn query(self) -> (&'static str, Option<&'static str>) {
        match self {
            Outcome::Ok => ("ok", None),
            Outcome::Denied => ("denied", None),
            Outcome::Failed(Failure::State) => ("failed", Some("state")),
            Outcome::Failed(Failure::Exchange) => ("failed", Some("exchange")),
            Outcome::Failed(Failure::Error) => ("failed", Some("error")),
        }
    }
}

/// 伺服器完成頁的完整網址（`?client_id=&result=[&reason=]`）；網址怪怪的 = None（改畫自己的頁）。
/// The server's done page with `?client_id=&result=[&reason=]`; an odd URL = None (draw our own page instead).
pub fn done_location(page: &str, client_id: &str, outcome: Outcome) -> Option<String> {
    let mut url = url::Url::parse(page).ok()?;
    if !matches!(url.scheme(), "http" | "https") {
        return None;
    }
    let (result, reason) = outcome.query();
    {
        let mut q = url.query_pairs_mut();
        q.append_pair("client_id", client_id).append_pair("result", result);
        if let Some(r) = reason {
            q.append_pair("reason", r);
        }
    }
    Some(url.into())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Lang {
    En,
    ZhTw,
    Ja,
}

/// Accept-Language → 頁面語言：照順序第一個認得的（zh* → 繁中、ja* → 日文、en* → 英文，跟網站一樣），q=0 不算。
/// Accept-Language → the page language: the first known tag in order (zh* → zh-TW, ja* → ja, en* → en, like the
/// site); q=0 entries are skipped.
pub fn page_lang(accept_language: &str) -> Lang {
    for part in accept_language.split(',') {
        let mut bits = part.split(';');
        let tag = bits.next().unwrap_or("").trim().to_ascii_lowercase();
        let refused = bits.any(|b| matches!(b.trim().strip_prefix("q="), Some(q) if q.trim().parse::<f32>().is_ok_and(|q| q <= 0.0)));
        if refused {
            continue;
        }
        if tag.starts_with("zh") {
            return Lang::ZhTw;
        }
        if tag.starts_with("ja") {
            return Lang::Ja;
        }
        if tag.starts_with("en") {
            return Lang::En;
        }
    }
    Lang::En
}

/// 請求標頭裡的 Accept-Language（沒有 = 空字串）。/ The request's Accept-Language header (none = empty).
pub fn accept_language<'a>(headers: impl IntoIterator<Item = &'a str>) -> String {
    headers
        .into_iter()
        .find_map(|h| {
            let (name, value) = h.split_once(':')?;
            name.trim().eq_ignore_ascii_case("accept-language").then(|| value.trim().to_string())
        })
        .unwrap_or_default()
}

struct Text {
    lang: &'static str,
    title: &'static str,
    body: &'static str,
    try_label: &'static str,
}

fn text(lang: Lang, outcome: Outcome) -> Text {
    match (lang, outcome) {
        (Lang::En, Outcome::Ok) => Text { lang: "en", title: "You're signed in", body: "The telepy CLI on this computer is signed in. Go back to the terminal — you can close this tab.", try_label: "Try" },
        (Lang::En, Outcome::Denied) => Text { lang: "en", title: "Sign-in cancelled", body: "The request was denied, so the CLI isn't signed in. Run telepy login again in the terminal when you're ready.", try_label: "" },
        (Lang::En, Outcome::Failed(_)) => Text { lang: "en", title: "The sign-in didn't finish", body: "The terminal says what went wrong. You can close this tab and run telepy login again.", try_label: "" },
        (Lang::ZhTw, Outcome::Ok) => Text { lang: "zh-Hant-TW", title: "已登入", body: "這台電腦上的 telepy CLI 已經登入。回到終端機就可以了，這個分頁可以關掉。", try_label: "試試看" },
        (Lang::ZhTw, Outcome::Denied) => Text { lang: "zh-Hant-TW", title: "已取消登入", body: "這個請求被拒絕了，所以 CLI 沒有登入。準備好時再到終端機執行一次 telepy login。", try_label: "" },
        (Lang::ZhTw, Outcome::Failed(_)) => Text { lang: "zh-Hant-TW", title: "登入沒有完成", body: "終端機會說明哪裡出了問題。這個分頁可以關掉，再執行一次 telepy login。", try_label: "" },
        (Lang::Ja, Outcome::Ok) => Text { lang: "ja", title: "サインインしました", body: "このコンピューターの telepy CLI はサインイン済みです。ターミナルに戻ってください。このタブは閉じてかまいません。", try_label: "試す" },
        (Lang::Ja, Outcome::Denied) => Text { lang: "ja", title: "サインインを取り消しました", body: "リクエストが拒否されたため、CLI はサインインしていません。準備ができたらターミナルで telepy login をもう一度実行してください。", try_label: "" },
        (Lang::Ja, Outcome::Failed(_)) => Text { lang: "ja", title: "サインインが完了しませんでした", body: "何が起きたかはターミナルに表示されます。このタブを閉じて、telepy login をもう一度実行してください。", try_label: "" },
    }
}

/// CLI 自己畫的那一頁（舊伺服器沒有完成頁時）：自成一檔的 HTML，沒有外部資源，深淺色跟著系統。
/// The CLI's own page (an older server has no done page): self-contained HTML, no external resources, light or dark
/// following the system.
pub fn fallback_page(lang: Lang, outcome: Outcome) -> String {
    let t = text(lang, outcome);
    let ok = matches!(outcome, Outcome::Ok);
    let (tone, mark) = if ok {
        ("ok", r#"<path d="M7 12.5l3.2 3.2L17 9"/>"#)
    } else {
        ("off", r#"<path d="M9 9l6 6M15 9l-6 6"/>"#)
    };
    let try_block = if ok {
        format!(r#"<div class="term"><span class="lbl">{}</span><code><span class="p">$</span> telepy ls</code><code><span class="p">$</span> telepy ssh &lt;tunnel&gt;</code></div>"#, t.try_label)
    } else {
        String::new()
    };
    format!(
        r##"<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light dark">
<title>telepy · {title}</title>
<style>
:root{{--bg:#f6f5f3;--card:#fff;--fg:#1f1d1b;--muted:#6b665f;--line:#e4e1dc;--ok:#2f8a4c;--off:#7a746c;--term:#1d1c1a;--term-fg:#ecebe8}}
@media (prefers-color-scheme:dark){{:root{{--bg:#151413;--card:#1d1c1a;--fg:#ecebe8;--muted:#a39e96;--line:#34322f;--ok:#55c27a;--off:#a39e96;--term:#0f0e0d}}}}
*{{box-sizing:border-box}}
body{{margin:0;min-height:100vh;display:grid;place-items:center;padding:16px;background:var(--bg);color:var(--fg);font:16px/1.6 ui-sans-serif,system-ui,-apple-system,"Segoe UI","PingFang TC","Hiragino Sans","Noto Sans CJK TC",sans-serif}}
main{{width:100%;max-width:27rem;background:var(--card);border:1px solid var(--line);border-radius:12px;padding:28px}}
.brand{{display:flex;align-items:center;gap:10px;color:var(--muted);font-size:14px}}
.brand svg{{width:28px;height:28px;flex:none}}
.state{{margin-top:28px;width:44px;height:44px;border-radius:12px;display:grid;place-items:center;border:1px solid var(--line)}}
.state svg{{width:24px;height:24px;fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}}
.ok{{color:var(--ok);border-color:color-mix(in srgb,var(--ok) 35%,transparent);background:color-mix(in srgb,var(--ok) 10%,transparent)}}
.off{{color:var(--off)}}
h1{{margin:16px 0 6px;font-size:22px;font-weight:600;letter-spacing:-.01em}}
p{{margin:0;color:var(--muted);font-size:15px}}
.term{{margin-top:22px;padding:12px 14px;border-radius:8px;background:var(--term);color:var(--term-fg);font:13px/1.7 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}}
.term code{{display:block;font:inherit}}
.lbl{{display:block;margin-bottom:2px;color:#a39e96;font-family:ui-sans-serif,system-ui,sans-serif;font-size:12px}}
.p{{color:#f88a3d}}
</style>
</head>
<body>
<main>
<div class="brand"><svg viewBox="0 0 64 64" aria-hidden="true"><defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#e3770e"/><stop offset="1" stop-color="#c04815"/></linearGradient></defs><rect width="64" height="64" rx="15" fill="url(#g)"/><g fill="none" stroke="#fff" stroke-width="8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 16H38a12 12 0 0 1 0 24H20"/><path d="M26 32l-8 8 8 8"/></g><circle cx="16" cy="16" r="7" fill="#fff"/></svg>telepy CLI</div>
<div class="state {tone}"><svg viewBox="0 0 24 24" aria-hidden="true">{mark}</svg></div>
<h1>{title}</h1>
<p>{body}</p>
{try_block}
</main>
</body>
</html>
"##,
        lang = t.lang,
        title = t.title,
        body = t.body,
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_done_page_gets_the_client_and_the_result() {
        let base = "https://t.example/oauth/done";
        assert_eq!(done_location(base, "abc", Outcome::Ok).as_deref(), Some("https://t.example/oauth/done?client_id=abc&result=ok"));
        assert_eq!(done_location(base, "a b", Outcome::Denied).as_deref(), Some("https://t.example/oauth/done?client_id=a+b&result=denied"));
        assert_eq!(done_location(base, "abc", Outcome::Failed(Failure::State)).as_deref(), Some("https://t.example/oauth/done?client_id=abc&result=failed&reason=state"));
        assert_eq!(done_location(base, "abc", Outcome::Failed(Failure::Exchange)).as_deref(), Some("https://t.example/oauth/done?client_id=abc&result=failed&reason=exchange"));
        // 不是 http(s) 或不是網址：不導。/ Not http(s) or not a URL: no redirect.
        assert_eq!(done_location("javascript:alert(1)", "abc", Outcome::Ok), None);
        assert_eq!(done_location("/oauth/done", "abc", Outcome::Ok), None);
    }

    #[test]
    fn the_language_follows_the_browser_like_the_site() {
        assert_eq!(page_lang("zh-TW,zh;q=0.9,en;q=0.8"), Lang::ZhTw);
        assert_eq!(page_lang("zh-CN"), Lang::ZhTw, "any Chinese gets the Traditional page, as on the site");
        assert_eq!(page_lang("ja-JP,ja;q=0.9"), Lang::Ja);
        assert_eq!(page_lang("fr-FR, ja;q=0.5, en;q=0.3"), Lang::Ja, "the first known tag in order");
        assert_eq!(page_lang("ja;q=0, en"), Lang::En, "q=0 means no");
        assert_eq!(page_lang(""), Lang::En);
        assert_eq!(accept_language(["Host: 127.0.0.1", "accept-language:  ja,en;q=0.5 "]), "ja,en;q=0.5");
        assert_eq!(accept_language(["Host: 127.0.0.1"]), "");
    }

    #[test]
    fn the_fallback_page_is_self_contained_and_says_what_happened() {
        let ok = fallback_page(Lang::En, Outcome::Ok);
        assert!(ok.contains("You're signed in") && ok.contains("telepy ls") && ok.contains(r#"lang="en""#), "{ok}");
        assert!(!ok.contains("http://") && !ok.contains("https://") && !ok.contains("<script"), "no external resources or scripts");
        let no = fallback_page(Lang::ZhTw, Outcome::Denied);
        assert!(no.contains("已取消登入") && !no.contains("telepy ls"), "{no}");
        let failed = fallback_page(Lang::Ja, Outcome::Failed(Failure::Exchange));
        assert!(failed.contains("サインインが完了しませんでした"), "{failed}");
        // 每一種都是完整的 HTML。/ Every variant is a whole document.
        for lang in [Lang::En, Lang::ZhTw, Lang::Ja] {
            for o in [Outcome::Ok, Outcome::Denied, Outcome::Failed(Failure::State)] {
                let p = fallback_page(lang, o);
                assert!(p.starts_with("<!doctype html>") && p.trim_end().ends_with("</html>"));
            }
        }
    }
}
