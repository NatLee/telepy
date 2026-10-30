//! `telepy config tidy`：簡化 ~/.ssh/config，跟網頁的 SSH config 編輯器（`src/frontend/src/lib/sshConfigTidy.ts`）是同一套
//! 規則、同一個結果——`tests/tidy_cases.json` 是兩邊共用的案例（網頁的測試產生並檢查它，這裡的測試也逐字比對）。
//! 規則照 OpenSSH 原始碼（readconf.c / match.c / ssh.c）：每個選項用第一個讀到的值，只有 IdentityFile、CertificateFile、
//! Local- / Remote- / DynamicForward、SendEnv 照順序累加；ProxyJump 只在 ProxyCommand 和 ProxyJump 都還沒設定時才算；
//! `Host` 比對打進去的名稱、分大小寫；HostName 的 `%h` 是打進去的名稱。改動只碰寫明名稱的區塊，每一步逐一驗證，
//! 不跨 Match / Include；最後整份再驗一次，不一樣就保留原文。
//!
//! `telepy config tidy`: simplifies ~/.ssh/config with exactly the rules and results of the web's SSH config editor
//! (`src/frontend/src/lib/sshConfigTidy.ts`) — `tests/tidy_cases.json` holds cases both sides check byte for byte.
//! The rules follow OpenSSH (readconf.c / match.c / ssh.c); see the web module for the full description.

use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicUsize, Ordering};

// ── OpenSSH ──────────────────────────────────────────────────────────────────

const ACCUMULATE: &[&str] = &["identityfile", "certificatefile", "localforward", "remoteforward", "dynamicforward", "sendenv"];
const VERBATIM: &[&str] = &["proxycommand", "proxyjump", "localcommand", "remotecommand", "knownhostscommand"];
const SLOT_ALIASES: &[(&str, &str)] = &[
    ("identityfile2", "identityfile"),
    ("hostbasedkeytypes", "hostbasedacceptedalgorithms"),
    ("pubkeyacceptedkeytypes", "pubkeyacceptedalgorithms"),
    ("challengeresponseauthentication", "kbdinteractiveauthentication"),
    ("skeyauthentication", "kbdinteractiveauthentication"),
    ("tisauthentication", "kbdinteractiveauthentication"),
    ("smartcarddevice", "pkcs11provider"),
    ("dsaauthentication", "pubkeyauthentication"),
    ("keepalive", "tcpkeepalive"),
];
const KEYWORDS: &str = "addkeystoagent addressfamily afstokenpassing batchmode bindaddress bindinterface canonicaldomains canonicalizefallbacklocal \
canonicalizehostname canonicalizemaxdots canonicalizepermittedcnames casignaturealgorithms certificatefile \
challengeresponseauthentication channeltimeout checkhostip cipher ciphers clearallforwardings compression compressionlevel \
connectionattempts connecttimeout controlmaster controlpath controlpersist dsaauthentication dynamicforward \
enableescapecommandline enablesshkeysign escapechar exitonforwardfailure fallbacktorsh fingerprinthash forkafterauthentication \
forwardagent forwardx11 forwardx11timeout forwardx11trusted gatewayports globalknownhostsfile globalknownhostsfile2 \
gssapiauthentication gssapidelegatecredentials hashknownhosts host hostbasedacceptedalgorithms hostbasedauthentication \
hostbasedkeytypes hostkeyalgorithms hostkeyalias hostname identitiesonly identityagent identityfile identityfile2 ignoreunknown \
include ipqos kbdinteractiveauthentication kbdinteractivedevices keepalive kerberosauthentication kerberostgtpassing kexalgorithms \
knownhostscommand localcommand localforward loglevel logverbose macs match nohostauthenticationforlocalhost numberofpasswordprompts \
obscurekeystroketiming passwordauthentication permitlocalcommand permitremoteopen pkcs11provider port preferredauthentications \
protocol proxycommand proxyjump proxyusefdpass pubkeyacceptedalgorithms pubkeyacceptedkeytypes pubkeyauthentication \
refuseconnection rekeylimit remotecommand remoteforward requesttty requiredrsasize revokedhostkeys rhostsauthentication \
rhostsrsaauthentication rsaauthentication securitykeyprovider sendenv serveralivecountmax serveraliveinterval sessiontype setenv \
skeyauthentication smartcarddevice stdinnull streamlocalbindmask streamlocalbindunlink stricthostkeychecking syslogfacility tag \
tcpkeepalive tisauthentication tunnel tunneldevice updatehostkeys useprivilegedport user userknownhostsfile userknownhostsfile2 \
useroaming usersh verifyhostkeydns versionaddendum visualhostkey warnweakcrypto xauthlocation";
const IGNORED: &str = "afstokenpassing cipher compressionlevel fallbacktorsh globalknownhostsfile2 kerberosauthentication kerberostgtpassing protocol rhostsauthentication rhostsrsaauthentication rsaauthentication useprivilegedport userknownhostsfile2 useroaming usersh";
/// 一行 Host 最長寫多長。/ The longest Host line written.
const HOST_LINE_MAX: usize = 1000;
/// 至少省這麼多行才值得多一個區塊。/ A new block must save at least this many lines.
const MIN_SAVING: i64 = 2;
/// Telepy 裝置區塊裡不搬的選項。/ Options a Telepy device block always keeps.
const TELEPY_PINNED: &[&str] = &["proxycommand", "proxyjump", "hostkeyalias"];
/// 驗證用、誰都不是的名字。/ A name that is nobody, for verifying.
const NOBODY: &str = "telepy-tidy-nobody.invalid";

fn stacks(slot: &str) -> bool {
    ACCUMULATE.contains(&slot)
}

fn slot_of(lower: &str) -> String {
    SLOT_ALIASES.iter().find(|(a, _)| *a == lower).map(|(_, s)| s.to_string()).unwrap_or_else(|| lower.to_string())
}

static NEXT_ID: AtomicUsize = AtomicUsize::new(1);
fn next_id() -> usize {
    NEXT_ID.fetch_add(1, Ordering::Relaxed)
}

/// JavaScript 字串長度（UTF-16 單位），跟網頁版算法一致。/ A JavaScript string length (UTF-16 units), as the web counts.
fn js_len(s: &str) -> usize {
    s.encode_utf16().count()
}

// ── Lines and blocks ─────────────────────────────────────────────────────────

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum LineKind {
    Blank,
    Comment,
    Option,
    Invalid,
}

#[derive(Clone, Debug)]
pub struct Line {
    /// 這一行的身分（複製出來的新行會換一個）。/ This line's identity (a copy made for a new block gets a new one).
    uid: usize,
    /// 原檔的行號（1 起算）；新寫的行是 0。/ 1-based line in the source; 0 for lines tidy wrote.
    pub n: usize,
    pub raw: String,
    pub kind: LineKind,
    pub key: String,
    pub slot: String,
    pub args: Vec<String>,
    pub rest: String,
}

#[derive(Clone, PartialEq, Eq, Debug)]
enum Owner {
    User,
    Telepy(String),
    Shared(String),
    Frozen,
}

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Kind {
    Global,
    Host,
    Match,
}

#[derive(Clone, Debug)]
struct Block {
    /// 區塊的身分（改過的複本保留它）。/ The block's identity (an edited copy keeps it).
    id: usize,
    kind: Kind,
    lead: Vec<Line>,
    header: Option<Line>,
    body: Vec<Line>,
    tail: Vec<Line>,
    patterns: Vec<String>,
    owner: Owner,
    marker: Option<String>,
    barrier: bool,
    literal: bool,
    made: bool,
    dropped: bool,
}

struct Parsed {
    blocks: Vec<Block>,
    trailer: Vec<Line>,
    indent: String,
    newline: &'static str,
    ends_with_newline: bool,
    spaced: bool,
}

/// OpenSSH 的 argv_split：空白分隔、引號、反斜線跳脫，`#` 開頭的字之後是註解。None = 引號沒關。
fn argv_split(s: &str) -> Option<Vec<String>> {
    let c: Vec<char> = s.chars().collect();
    let mut out = Vec::new();
    let mut i = 0;
    while i < c.len() {
        if c[i] == ' ' || c[i] == '\t' {
            i += 1;
            continue;
        }
        if c[i] == '#' {
            break;
        }
        let mut arg = String::new();
        let mut quote: Option<char> = None;
        while i < c.len() {
            let ch = c[i];
            if ch == '\\' && i + 1 < c.len() && (c[i + 1] == '\'' || c[i + 1] == '"' || c[i + 1] == '\\' || (quote.is_none() && c[i + 1] == ' ')) {
                i += 1;
                arg.push(c[i]);
            } else if quote.is_none() && (ch == ' ' || ch == '\t') {
                break;
            } else if quote.is_none() && (ch == '"' || ch == '\'') {
                quote = Some(ch);
            } else if quote == Some(ch) {
                quote = None;
            } else {
                arg.push(ch);
            }
            i += 1;
        }
        if quote.is_some() {
            return None;
        }
        out.push(arg);
    }
    Some(out)
}

fn plain(n: usize, raw: &str, kind: LineKind) -> Line {
    Line { uid: next_id(), n, raw: raw.to_string(), kind, key: String::new(), slot: String::new(), args: Vec::new(), rest: String::new() }
}

/// 一行文字 → Line（關鍵字、引號、`Key=value` 照 OpenSSH）。/ One line of text, tokenised like OpenSSH.
fn parse_line(n: usize, raw: &str) -> Line {
    let s = raw.trim_end_matches([' ', '\t', '\r']).trim_start_matches([' ', '\t']);
    if s.is_empty() {
        return plain(n, raw, LineKind::Blank);
    }
    if s.starts_with('#') {
        return plain(n, raw, LineKind::Comment);
    }
    let end = s.find(|c: char| c.is_whitespace() || c == '=').unwrap_or(s.len());
    if end == 0 {
        return plain(n, raw, LineKind::Invalid);
    }
    let key = &s[..end];
    let mut rest = s[end..].trim_start_matches([' ', '\t']);
    if let Some(r) = rest.strip_prefix('=') {
        rest = r.trim_start_matches([' ', '\t']);
    }
    // JavaScript 的 `.` 不比對這些字元：網頁版把這種行當成讀不懂，這裡一樣。/ The web treats these as unreadable too.
    if rest.contains(['\r', '\u{2028}', '\u{2029}']) {
        return plain(n, raw, LineKind::Invalid);
    }
    let lower = key.to_lowercase();
    let mut l = plain(n, raw, LineKind::Option);
    l.key = key.to_string();
    l.rest = rest.to_string();
    match argv_split(rest) {
        Some(args) => {
            l.slot = slot_of(&lower);
            l.args = args;
        }
        None => {
            l.kind = LineKind::Invalid;
            l.slot = lower;
        }
    }
    l
}

fn is_wild(p: &str) -> bool {
    p.contains(['*', '?', '!'])
}

fn plain_name(p: &str) -> bool {
    !p.is_empty() && !p.chars().any(|c| c.is_whitespace() || matches!(c, '"' | '\'' | '\\' | '#' | '*' | '?' | '!'))
}

fn new_block(kind: Kind, header: Option<Line>, lead: Vec<Line>) -> Block {
    let patterns = match (&kind, &header) {
        (Kind::Host, Some(h)) => h.args.clone(),
        _ => Vec::new(),
    };
    let literal = kind == Kind::Host && !patterns.is_empty() && patterns.iter().all(|p| plain_name(p));
    Block { id: next_id(), kind, lead, header, body: Vec::new(), tail: Vec::new(), patterns, owner: Owner::User, marker: None, barrier: kind == Kind::Match, literal, made: false, dropped: false }
}

/// 區塊最後一個選項後面的行：結尾標記以前留在區塊，其餘交給下一個區塊。/ Split the lines after a block's last option.
fn close_block(b: &mut Block) -> Vec<Line> {
    let mut last = b.body.len();
    while last > 0 && matches!(b.body[last - 1].kind, LineKind::Blank | LineKind::Comment) {
        last -= 1;
    }
    let suffix = b.body.split_off(last);
    let at = b.marker.as_ref().and_then(|m| {
        let close = format!("# <<< telepy {m} <<<");
        suffix.iter().position(|l| l.raw.trim_end() == close)
    });
    match at {
        None => suffix,
        Some(at) => {
            let mut suffix = suffix;
            let rest = suffix.split_off(at + 1);
            b.tail = suffix;
            rest
        }
    }
}

fn open_marker(raw: &str) -> Option<String> {
    raw.trim_end().strip_prefix("# >>> telepy ").and_then(|r| r.strip_suffix(" >>>")).filter(|m| !m.is_empty()).map(str::to_string)
}

fn close_marker(raw: &str) -> Option<String> {
    raw.trim_end().strip_prefix("# <<< telepy ").and_then(|r| r.strip_suffix(" <<<")).filter(|m| !m.is_empty()).map(str::to_string)
}

/// Telepy 產生的裝置 ProxyCommand：`ssh … -W <x> <伺服器別名>`。/ The device ProxyCommand Telepy writes.
fn telepy_jump(cmd: &str) -> Option<String> {
    if !cmd.starts_with("ssh") || !cmd[3..].starts_with(char::is_whitespace) {
        return None;
    }
    let words: Vec<&str> = cmd.split_whitespace().collect();
    let n = words.len();
    if n < 4 || words[n - 3] != "-W" {
        return None;
    }
    // 正規式要求 `-W` 前面是空白（不是第一個字之後就緊接）且最後一個字只有別名字元。/ Alias characters only.
    let last = words[n - 1];
    if last.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-')) && cmd.trim_end() == cmd {
        Some(last.to_string())
    } else {
        None
    }
}

fn parse_config(text: &str) -> Parsed {
    let newline = if text.contains("\r\n") { "\r\n" } else { "\n" };
    let pieces: Vec<&str> = text.split('\n').collect();
    let count = pieces.len();
    let mut raw_lines: Vec<&str> = pieces.iter().enumerate().map(|(i, l)| if i + 1 < count { l.strip_suffix('\r').unwrap_or(l) } else { l }).collect();
    let ends_with_newline = raw_lines.len() > 1 && raw_lines.last() == Some(&"");
    if ends_with_newline {
        raw_lines.pop();
    }
    let mut blocks: Vec<Block> = vec![new_block(Kind::Global, None, Vec::new())];
    for (i, raw) in raw_lines.iter().enumerate() {
        let l = parse_line(i + 1, raw);
        if l.kind == LineKind::Option && (l.slot == "host" || l.slot == "match") {
            let cur = blocks.last_mut().unwrap();
            let lead = close_block(cur);
            let kind = if l.slot == "host" { Kind::Host } else { Kind::Match };
            let marker = lead.last().and_then(|x| open_marker(&x.raw));
            let mut b = new_block(kind, Some(l), lead);
            b.marker = marker;
            blocks.push(b);
        } else {
            blocks.last_mut().unwrap().body.push(l);
        }
    }
    let trailer = close_block(blocks.last_mut().unwrap());

    let mut open: Option<String> = None;
    for b in blocks.iter_mut() {
        let clean = b.marker.is_some() && !b.tail.is_empty();
        for l in &b.lead {
            if let Some(o) = open_marker(&l.raw) {
                open = Some(o);
            } else if let Some(c) = close_marker(&l.raw) {
                if open.as_deref() == Some(c.as_str()) {
                    open = None;
                }
            }
        }
        if clean {
            open = None;
            let marker = b.marker.clone().unwrap();
            let shared = marker.strip_prefix("shared ").filter(|s| !s.is_empty() && !s.contains(char::is_whitespace)).map(str::to_string);
            let jump = b.body.iter().find(|l| l.kind == LineKind::Option && (l.slot == "proxycommand" || l.slot == "proxyjump"));
            let via = jump.and_then(|j| if j.slot == "proxyjump" { j.args.first().cloned() } else { telepy_jump(j.rest.trim()) });
            b.owner = if let Some(s) = shared {
                Owner::Shared(s)
            } else if b.patterns.len() == 1 && b.patterns[0] == marker && via.as_ref().is_some_and(|v| !v.is_empty() && *v != marker) {
                Owner::Telepy(via.unwrap())
            } else {
                Owner::Frozen
            };
        } else if open.is_some() {
            b.owner = Owner::Frozen;
        }
        if b.body.iter().any(|l| l.kind == LineKind::Invalid || l.slot == "include") {
            b.barrier = true;
        }
    }

    let mut indents: Vec<(String, usize)> = Vec::new();
    for b in blocks.iter().filter(|b| b.kind != Kind::Global) {
        for l in &b.body {
            let ind: String = l.raw.chars().take_while(|c| *c == ' ' || *c == '\t').collect();
            if l.kind == LineKind::Option && !ind.is_empty() {
                match indents.iter_mut().find(|(i, _)| *i == ind) {
                    Some(e) => e.1 += 1,
                    None => indents.push((ind, 1)),
                }
            }
        }
    }
    indents.sort_by(|a, b| b.1.cmp(&a.1));
    let indent = indents.first().map(|(i, _)| i.clone()).unwrap_or_else(|| "    ".to_string());
    let headed: Vec<&Block> = blocks.iter().filter(|b| b.kind != Kind::Global).skip(1).collect();
    let spaced = !headed.is_empty() && headed.iter().filter(|b| b.lead.first().is_some_and(|l| l.kind == LineKind::Blank)).count() * 2 >= headed.len();
    Parsed { blocks, trailer, indent, newline, ends_with_newline, spaced }
}

// ── Matching and resolving ───────────────────────────────────────────────────

/// match.c 的 match_pattern：`*`、`?`，分大小寫。/ match_pattern: `*`, `?`, case-sensitive.
fn glob_match(s: &str, pattern: &str) -> bool {
    let s: Vec<char> = s.chars().collect();
    let p: Vec<char> = pattern.chars().collect();
    let (mut i, mut j) = (0, 0);
    let mut star: Option<(usize, usize)> = None;
    while i < s.len() {
        if j < p.len() && (p[j] == '?' || p[j] == s[i]) {
            i += 1;
            j += 1;
        } else if j < p.len() && p[j] == '*' {
            star = Some((j, i));
            j += 1;
        } else if let Some((sj, si)) = star {
            j = sj + 1;
            i = si + 1;
            star = Some((sj, si + 1));
        } else {
            return false;
        }
    }
    while j < p.len() && p[j] == '*' {
        j += 1;
    }
    j == p.len()
}

/// readconf.c 的 oHost：有一個正樣式比中、而且沒有 `!` 樣式比中。/ oHost.
fn host_matches(patterns: &[String], host: &str) -> bool {
    let mut active = false;
    for p in patterns {
        let (neg, pat) = match p.strip_prefix('!') {
            Some(r) => (true, r),
            None => (false, p.as_str()),
        };
        if glob_match(host, pat) {
            if neg {
                return false;
            }
            active = true;
        }
    }
    active
}

fn applies(b: &Block, host: &str, match_all: bool) -> bool {
    if b.dropped {
        return false;
    }
    match b.kind {
        Kind::Match => match_all,
        Kind::Global => true,
        Kind::Host => host_matches(&b.patterns, host),
    }
}

/// 比較用的值：HostName 把 `%h` 展開。/ The value compared; HostName expands `%h`.
fn value_text(l: &Line, host: &str) -> String {
    if VERBATIM.contains(&l.slot.as_str()) {
        return l.rest.trim().to_string();
    }
    if l.slot == "hostname" {
        let v = l.args.first().map(String::as_str).unwrap_or("");
        let mut out = String::new();
        let mut it = v.chars().peekable();
        while let Some(c) = it.next() {
            if c == '%' && matches!(it.peek(), Some('%') | Some('h')) {
                out.push_str(if it.next() == Some('%') { "%" } else { host });
            } else {
                out.push(c);
            }
        }
        return out;
    }
    l.args.join("\u{0}")
}

fn id_text(l: &Line) -> String {
    value_text(l, "\u{3}")
}

#[derive(PartialEq, Eq, Debug, Default)]
struct Effect {
    first: HashMap<String, String>,
    lists: HashMap<String, Vec<String>>,
}

fn resolve(blocks: &[Block], host: &str, match_all: bool) -> Effect {
    let mut eff = Effect::default();
    for b in blocks.iter().filter(|b| applies(b, host, match_all)) {
        for l in b.body.iter().filter(|l| l.kind == LineKind::Option && l.slot != "include") {
            let text = value_text(l, host);
            if stacks(&l.slot) {
                eff.lists.entry(l.slot.clone()).or_default().push(text);
            } else if l.slot == "proxyjump" {
                if !eff.first.contains_key("proxycommand") && !eff.first.contains_key("proxyjump") {
                    eff.first.insert("proxyjump".into(), text);
                }
            } else {
                eff.first.entry(l.slot.clone()).or_insert(text);
            }
        }
    }
    eff
}

fn segments(blocks: &[Block]) -> Vec<(usize, usize)> {
    let mut out = Vec::new();
    let mut start = 0;
    for (i, b) in blocks.iter().enumerate() {
        if b.barrier {
            if i > start {
                out.push((start, i));
            }
            start = i + 1;
        }
    }
    if blocks.len() > start {
        out.push((start, blocks.len()));
    }
    out
}

// ── Result ───────────────────────────────────────────────────────────────────

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Change {
    Duplicate { n: usize, key: String, host: String },
    Repeat { n: usize, key: String, host: String, by: usize },
    Shared { hosts: Vec<String>, keys: Vec<String>, removed: usize, telepy: bool },
    Wildcard { pattern: String, hosts: Vec<String> },
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Note {
    Shadowed { n: usize, key: String, host: String, by: usize, value: String, winner: String },
    Unknown { n: usize, key: String },
    Ignored { n: usize, key: String },
    Wall { n: usize, key: String },
    Invalid { n: usize },
}

impl Note {
    pub fn line(&self) -> usize {
        match self {
            Note::Shadowed { n, .. } | Note::Unknown { n, .. } | Note::Ignored { n, .. } | Note::Wall { n, .. } | Note::Invalid { n } => *n,
        }
    }
    /// 跟網頁版一樣的種類名稱。/ The kind, as the web names it.
    pub fn kind(&self) -> &'static str {
        match self {
            Note::Shadowed { .. } => "shadowed",
            Note::Unknown { .. } => "unknown",
            Note::Ignored { .. } => "ignored",
            Note::Wall { .. } => "wall",
            Note::Invalid { .. } => "invalid",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Stats {
    pub lines: usize,
    pub settings: usize,
    pub blocks: usize,
}

#[derive(Debug)]
pub struct TidyResult {
    pub text: String,
    /// 每一行輸出與它原本的行號（0 = 新寫的）。/ Every output line and its source line (0 = written by tidy).
    pub lines: Vec<(String, usize)>,
    pub before: Stats,
    pub after: Stats,
    pub changes: Vec<Change>,
    pub notes: Vec<Note>,
    pub checked: Vec<String>,
    pub failed: Vec<String>,
    pub widened: Vec<(String, Vec<String>)>,
}

// ── Tidy ─────────────────────────────────────────────────────────────────────

#[derive(Clone, Debug)]
struct Feature {
    id: String,
    slot: String,
    lines: Vec<Line>,
    template: Option<String>,
}

#[derive(Clone, Debug)]
struct Entry {
    feature: Feature,
    /// 區塊 id → 它自己的那幾行（照加入順序）。/ Block id → its own lines (insertion order).
    holders: Vec<(usize, Feature)>,
}

impl Entry {
    fn has(&self, id: usize) -> bool {
        self.holders.iter().any(|(b, _)| *b == id)
    }
    fn get(&self, id: usize) -> Option<&Feature> {
        self.holders.iter().find(|(b, _)| *b == id).map(|(_, f)| f)
    }
}

#[derive(Clone, Debug)]
struct Candidate {
    members: Vec<Block>,
    entries: Vec<Entry>,
    moves: HashMap<usize, HashSet<usize>>,
    saving: i64,
    key: String,
}

fn owner_key(o: &Owner) -> String {
    match o {
        Owner::Telepy(s) => format!("telepy:{s}"),
        Owner::User => "user".into(),
        Owner::Shared(_) => "shared".into(),
        Owner::Frozen => "frozen".into(),
    }
}

fn editable(b: &Block) -> bool {
    !b.barrier && !b.made && !b.dropped && b.literal && matches!(b.owner, Owner::User | Owner::Telepy(_))
}

fn options(b: &Block) -> impl Iterator<Item = &Line> {
    b.body.iter().filter(|l| l.kind == LineKind::Option)
}

/// `HostName <前綴><名稱><後綴>` → `<前綴>%h<後綴>`。/ HostName as a `%h` template.
fn hostname_template(b: &Block, l: &Line) -> Option<String> {
    if b.patterns.len() != 1 || l.args.len() != 1 {
        return None;
    }
    let name = &b.patterns[0];
    let value = &l.args[0];
    if value.contains('%') || name.contains('%') {
        return None;
    }
    let at = value.find(name.as_str())?;
    Some(format!("{}%h{}", &value[..at], &value[at + name.len()..]))
}

fn block_features(b: &Block, keep: &HashSet<usize>, templates: &HashMap<String, usize>) -> Vec<Feature> {
    let mut out = Vec::new();
    let mut seen: HashSet<String> = HashSet::new();
    let opts: Vec<&Line> = options(b).collect();
    for l in &opts {
        if keep.contains(&l.uid) || seen.contains(&l.slot) {
            continue;
        }
        if matches!(b.owner, Owner::Telepy(_)) && TELEPY_PINNED.contains(&l.slot.as_str()) {
            continue;
        }
        if stacks(&l.slot) {
            seen.insert(l.slot.clone());
            let all: Vec<Line> = opts.iter().filter(|x| x.slot == l.slot).map(|x| (*x).clone()).collect();
            if all.iter().any(|x| keep.contains(&x.uid)) {
                continue;
            }
            let id = format!("{}\u{1}{}", l.slot, all.iter().map(id_text).collect::<Vec<_>>().join("\u{2}"));
            out.push(Feature { id, slot: l.slot.clone(), lines: all, template: None });
            continue;
        }
        seen.insert(l.slot.clone());
        let tpl = if l.slot == "hostname" { hostname_template(b, l) } else { None };
        match tpl {
            Some(t) if templates.get(&t).copied().unwrap_or(0) >= 2 => {
                out.push(Feature { id: format!("hostname\u{1}%T{t}"), slot: l.slot.clone(), lines: vec![(*l).clone()], template: Some(t) });
            }
            _ => out.push(Feature { id: format!("{}\u{1}{}", l.slot, id_text(l)), slot: l.slot.clone(), lines: vec![(*l).clone()], template: None }),
        }
    }
    out
}

fn chunk_hosts(hosts: &[String]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = vec![Vec::new()];
    let mut len = 4;
    for h in hosts {
        if !out.last().unwrap().is_empty() && len + js_len(h) + 1 > HOST_LINE_MAX {
            out.push(Vec::new());
            len = 4;
        }
        out.last_mut().unwrap().push(h.clone());
        len += js_len(h) + 1;
    }
    out
}

fn hosts_of(members: &[Block]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for p in members.iter().flat_map(|m| m.patterns.iter()) {
        if !out.contains(p) {
            out.push(p.clone());
        }
    }
    out
}

fn header_n(b: &Block) -> usize {
    b.header.as_ref().map(|h| h.n).unwrap_or(0)
}

fn candidate(members: Vec<Block>, entries: &[Entry]) -> Option<Candidate> {
    let ids: HashSet<usize> = members.iter().map(|m| m.id).collect();
    let used: Vec<Entry> = entries.iter().filter(|e| e.holders.iter().any(|(b, _)| ids.contains(b))).cloned().collect();
    if members.len() < 2 || used.is_empty() {
        return None;
    }
    let per_member: usize = used.iter().map(|e| e.feature.lines.len()).sum();
    let telepy = matches!(members[0].owner, Owner::Telepy(_));
    let mut moves: HashMap<usize, HashSet<usize>> = HashMap::new();
    let mut removed = 0usize;
    let mut emptied = 0usize;
    for m in &members {
        let moved: HashSet<usize> = used.iter().filter_map(|e| e.get(m.id)).flat_map(|f| f.lines.iter().map(|l| l.uid)).collect();
        removed += moved.len();
        if !telepy && m.body.iter().all(|l| moved.contains(&l.uid) || l.kind == LineKind::Blank) {
            emptied += 1;
        }
        moves.insert(m.id, moved);
    }
    let added = chunk_hosts(&hosts_of(&members)).len() * (1 + per_member + if telepy { 2 } else { 0 });
    let mut feature_ids: Vec<&str> = used.iter().map(|e| e.feature.id.as_str()).collect();
    feature_ids.sort();
    let key = format!("{}|{}", members.iter().map(|m| header_n(m).to_string()).collect::<Vec<_>>().join(","), feature_ids.join("|"));
    Some(Candidate { members, entries: used, moves, saving: removed as i64 + emptied as i64 - added as i64, key })
}

fn candidates(seg: &[Block], keep: &HashSet<usize>, tried: &HashSet<String>) -> Vec<Candidate> {
    let mut out: Vec<Candidate> = Vec::new();
    let mut groups: Vec<(String, Vec<&Block>)> = Vec::new();
    for b in seg.iter().filter(|b| editable(b)) {
        let k = owner_key(&b.owner);
        match groups.iter_mut().find(|(g, _)| *g == k) {
            Some(g) => g.1.push(b),
            None => groups.push((k, vec![b])),
        }
    }
    for (_, blocks) in &groups {
        if blocks.len() < 2 {
            continue;
        }
        let mut templates: HashMap<String, usize> = HashMap::new();
        for b in blocks {
            for l in options(b) {
                if l.slot == "hostname" && !keep.contains(&l.uid) {
                    if let Some(t) = hostname_template(b, l) {
                        *templates.entry(t).or_default() += 1;
                    }
                }
            }
        }
        let mut entries: Vec<Entry> = Vec::new();
        let mut sets: HashMap<usize, HashSet<String>> = HashMap::new();
        for b in blocks {
            sets.insert(b.id, options(b).map(|l| l.slot.clone()).collect());
            for f in block_features(b, keep, &templates) {
                match entries.iter_mut().find(|e| e.feature.id == f.id) {
                    Some(e) => {
                        if let Some(h) = e.holders.iter_mut().find(|(id, _)| *id == b.id) {
                            h.1 = f;
                        } else {
                            e.holders.push((b.id, f));
                        }
                    }
                    None => entries.push(Entry { feature: f.clone(), holders: vec![(b.id, f)] }),
                }
            }
        }
        // 一個共用區塊裡每個選項只放一個值：有的區塊最多的那個。/ One value per option: the most common.
        // (成員的 Host 行號, 成員在 blocks 裡的位置, 選項 → entries 的位置) / (key, member positions, slot → entry)
        let mut by_set: Vec<(String, Vec<usize>, Vec<(String, usize)>)> = Vec::new();
        fn add(by_set: &mut Vec<(String, Vec<usize>, Vec<(String, usize)>)>, blocks: &[&Block], members: Vec<usize>, ei: usize, entries: &[Entry]) {
            let key = members.iter().map(|&m| header_n(blocks[m]).to_string()).collect::<Vec<_>>().join(",");
            let pos = match by_set.iter().position(|(k, _, _)| *k == key) {
                Some(p) => p,
                None => {
                    by_set.push((key, members, Vec::new()));
                    by_set.len() - 1
                }
            };
            let slot = entries[ei].feature.slot.clone();
            let g = &mut by_set[pos].2;
            match g.iter_mut().find(|(s, _)| *s == slot) {
                Some(had) => {
                    if entries[had.1].holders.len() < entries[ei].holders.len() {
                        had.1 = ei;
                    }
                }
                None => g.push((slot, ei)),
            }
        }
        for ei in 0..entries.len() {
            let e = &entries[ei];
            if e.holders.len() < 2 {
                continue;
            }
            let holders: Vec<usize> = (0..blocks.len()).filter(|&i| e.has(blocks[i].id)).collect();
            let held = holders.len();
            add(&mut by_set, blocks, holders, ei, &entries);
            let slot = e.feature.slot.clone();
            if stacks(&slot) {
                continue;
            }
            let wider: Vec<usize> = (0..blocks.len())
                .filter(|&i| {
                    let b = blocks[i];
                    entries[ei].has(b.id) || (sets[&b.id].contains(&slot) && !(slot == "proxycommand" && sets[&b.id].contains("proxyjump")))
                })
                .collect();
            if wider.len() > held {
                add(&mut by_set, blocks, wider, ei, &entries);
            }
        }
        for (_, members, slots) in by_set {
            let es: Vec<Entry> = slots.iter().map(|(_, ei)| entries[*ei].clone()).collect();
            if let Some(c) = candidate(members.into_iter().map(|i| blocks[i].clone()).collect(), &es) {
                if !tried.contains(&c.key) && c.saving >= MIN_SAVING {
                    out.push(c);
                }
            }
        }
    }
    // 省一樣多時選名稱少的。/ On a tie, fewer names.
    out.sort_by(|a, b| b.saving.cmp(&a.saving).then(a.members.len().cmp(&b.members.len())));
    out
}

fn made_line(indent: &str, key: &str, value: &str, slot: &str, args: Vec<String>, rest: &str) -> Line {
    Line { uid: next_id(), n: 0, raw: format!("{indent}{key} {value}"), kind: LineKind::Option, key: key.into(), slot: slot.into(), args, rest: rest.into() }
}

fn shared_blocks(cfg: &Parsed, members: &[Block], entries: &[Entry]) -> Vec<Block> {
    let owner = members[0].owner.clone();
    let mut body: Vec<Line> = Vec::new();
    for e in entries {
        let f = &e.feature;
        match &f.template {
            Some(t) => body.push(made_line(&cfg.indent, &f.lines[0].key, t, "hostname", vec![t.clone()], t)),
            None => {
                for l in &f.lines {
                    let mut c = l.clone();
                    c.uid = next_id();
                    c.n = 0;
                    c.raw = format!("{}{}", cfg.indent, l.raw.trim_start_matches([' ', '\t']));
                    body.push(c);
                }
            }
        }
    }
    let key = members[0].header.as_ref().map(|h| h.key.clone()).unwrap_or_else(|| "Host".into());
    chunk_hosts(&hosts_of(members))
        .into_iter()
        .map(|hosts| {
            let joined = hosts.join(" ");
            let header = made_line("", &key, &joined, "host", hosts, &joined);
            let mut b = new_block(Kind::Host, Some(header), Vec::new());
            b.made = true;
            b.owner = owner.clone();
            b.body = body.iter().map(|l| Line { uid: next_id(), ..l.clone() }).collect();
            if let Owner::Telepy(s) = &owner {
                let m = format!("shared {s}");
                b.lead = vec![plain(0, &format!("# >>> telepy {m} >>>"), LineKind::Comment)];
                b.tail = vec![plain(0, &format!("# <<< telepy {m} <<<"), LineKind::Comment)];
                b.marker = Some(m);
            } else if cfg.spaced {
                b.lead = vec![plain(0, "", LineKind::Blank)];
            }
            b
        })
        .collect()
}

fn apply_group(cfg: &Parsed, seg: &[Block], c: &Candidate, after: bool) -> Vec<Block> {
    let made = shared_blocks(cfg, &c.members, &c.entries);
    let idx: Vec<usize> = seg.iter().enumerate().filter(|(_, b)| c.moves.contains_key(&b.id)).map(|(i, _)| i).collect();
    let pos = if after { idx[idx.len() - 1] + 1 } else { idx[0] };
    let mut out: Vec<Block> = seg
        .iter()
        .map(|b| match c.moves.get(&b.id) {
            Some(moved) => {
                let mut n = b.clone();
                n.body.retain(|l| !moved.contains(&l.uid));
                n.dropped = n.owner == Owner::User && n.body.iter().all(|l| l.kind == LineKind::Blank);
                n
            }
            None => b.clone(),
        })
        .collect();
    out.splice(pos..pos, made);
    out
}

fn differing(before: &[Block], after: &[Block], hosts: &[String]) -> Vec<String> {
    hosts.iter().filter(|h| resolve(before, h, false) != resolve(after, h, false)).cloned().collect()
}

fn dead_lines(all: &[Block], changes: &mut Vec<Change>, notes: &mut Vec<Note>, keep: &mut HashSet<usize>) -> HashMap<usize, HashSet<usize>> {
    let mut drop: HashMap<usize, HashSet<usize>> = HashMap::new();
    for (i, b) in all.iter().enumerate() {
        if b.kind == Kind::Match || b.barrier {
            continue;
        }
        let opts: Vec<&Line> = options(b).collect();
        for (j, l) in opts.iter().enumerate() {
            if stacks(&l.slot) || l.slot == "include" {
                continue;
            }
            let sets = |x: &Line| if l.slot == "proxyjump" { x.slot == "proxycommand" || x.slot == "proxyjump" } else { x.slot == l.slot };
            let host = b.patterns.join(" ");
            if let Some(same_block) = opts[..j].iter().find(|x| sets(x)) {
                if id_text(same_block) != id_text(l) {
                    notes.push(Note::Shadowed { n: l.n, key: l.key.clone(), host, by: same_block.n, value: l.rest.trim().into(), winner: same_block.rest.trim().into() });
                    keep.insert(l.uid);
                } else if b.owner == Owner::User {
                    changes.push(Change::Duplicate { n: l.n, key: l.key.clone(), host });
                    drop.entry(b.id).or_default().insert(l.uid);
                } else {
                    keep.insert(l.uid);
                }
                continue;
            }
            if !b.literal {
                continue;
            }
            let mut by: Option<&Line> = None;
            let mut same = true;
            let mut covered = true;
            for h in &b.patterns {
                let mut setter: Option<&Line> = None;
                for e in &all[..i] {
                    if e.kind == Kind::Match || !applies(e, h, false) {
                        continue;
                    }
                    setter = options(e).find(|x| sets(x));
                    if setter.is_some() {
                        break;
                    }
                }
                let Some(s) = setter else {
                    covered = false;
                    break;
                };
                if by.is_none() {
                    by = Some(s);
                }
                if value_text(s, h) != value_text(l, h) {
                    same = false;
                }
            }
            let Some(by) = by.filter(|_| covered) else { continue };
            if !same {
                notes.push(Note::Shadowed { n: l.n, key: l.key.clone(), host, by: by.n, value: l.rest.trim().into(), winner: by.rest.trim().into() });
                keep.insert(l.uid);
            } else if b.owner == Owner::User {
                changes.push(Change::Repeat { n: l.n, key: l.key.clone(), host, by: by.n });
                drop.entry(b.id).or_default().insert(l.uid);
            }
        }
    }
    drop
}

fn common_prefix(xs: &[String]) -> String {
    let mut p: Vec<char> = xs.first().map(|x| x.chars().collect()).unwrap_or_default();
    for x in xs {
        while !x.starts_with(&p.iter().collect::<String>()) {
            p.pop();
        }
    }
    p.into_iter().collect()
}

fn common_suffix(xs: &[String]) -> String {
    let mut s: Vec<char> = xs.first().map(|x| x.chars().collect()).unwrap_or_default();
    for x in xs {
        while !x.ends_with(&s.iter().collect::<String>()) {
            s.remove(0);
        }
    }
    s.into_iter().collect()
}

/// 兩個萬用字元樣式有沒有共同符合的名稱。/ Whether two glob patterns can match the same name.
fn globs_intersect(a: &str, b: &str) -> bool {
    let a: Vec<char> = a.chars().collect();
    let b: Vec<char> = b.chars().collect();
    let mut seen: HashSet<(usize, usize)> = HashSet::new();
    fn close(i: usize, j: usize, a: &[char], b: &[char], seen: &mut HashSet<(usize, usize)>, acc: &mut Vec<(usize, usize)>) {
        if !seen.insert((i, j)) {
            return;
        }
        acc.push((i, j));
        if a.get(i) == Some(&'*') {
            close(i + 1, j, a, b, seen, acc);
        }
        if b.get(j) == Some(&'*') {
            close(i, j + 1, a, b, seen, acc);
        }
    }
    let mut states = Vec::new();
    close(0, 0, &a, &b, &mut seen, &mut states);
    let mut guard = 0;
    while guard <= a.len() + b.len() + 1 && !states.is_empty() {
        if states.iter().any(|&(i, j)| i == a.len() && j == b.len()) {
            return true;
        }
        let mut next = Vec::new();
        for &(i, j) in &states {
            if i >= a.len() || j >= b.len() {
                continue;
            }
            let (ca, cb) = (a[i], b[j]);
            if ca != '*' && ca != '?' && cb != '*' && cb != '?' && ca != cb {
                continue;
            }
            close(if ca == '*' { i } else { i + 1 }, if cb == '*' { j } else { j + 1 }, &a, &b, &mut seen, &mut next);
        }
        states = next;
        guard += 1;
    }
    states.iter().any(|&(i, j)| i == a.len() && j == b.len())
}

fn wildcard_for(hosts: &[String], all: &[&Block], group_id: usize) -> Option<String> {
    if hosts.len() < 2 {
        return None;
    }
    let pre = common_prefix(hosts);
    let pre_c: Vec<char> = pre.chars().collect();
    let cut = pre_c.iter().rposition(|c| matches!(c, '-' | '.' | '_'));
    let prefix = match cut {
        Some(c) if c >= 1 => pre_c[..=c].iter().collect::<String>(),
        _ if pre_c.len() >= 3 => pre.clone(),
        _ => String::new(),
    };
    let suf = common_suffix(hosts);
    let suf_c: Vec<char> = suf.chars().collect();
    let suffix = match suf_c.iter().position(|c| matches!(c, '-' | '.' | '_')) {
        Some(s) if suf_c.len() - s >= 3 => suf_c[s..].iter().collect::<String>(),
        _ => String::new(),
    };
    let in_group: HashSet<&str> = hosts.iter().map(String::as_str).collect();
    let joined = js_len(&hosts.join(" "));
    let tries = [
        if suffix.starts_with('.') { format!("*{suffix}") } else { String::new() },
        if prefix.is_empty() { String::new() } else { format!("{prefix}*") },
        if suffix.is_empty() { String::new() } else { format!("*{suffix}") },
    ];
    for pattern in tries {
        if pattern.is_empty() || js_len(&pattern) >= joined {
            continue;
        }
        let clash = all.iter().filter(|b| b.id != group_id && !b.dropped && b.kind == Kind::Host).any(|b| {
            b.patterns.iter().any(|p| {
                let q = p.strip_prefix('!').unwrap_or(p);
                if !is_wild(q) {
                    !in_group.contains(q) && glob_match(q, &pattern)
                } else {
                    q != "*" && globs_intersect(q, &pattern)
                }
            })
        });
        if !clash {
            return Some(pattern);
        }
    }
    None
}

fn stats(blocks: &[Block], text: &str) -> Stats {
    let live: Vec<&Block> = blocks.iter().filter(|b| !b.dropped).collect();
    let trimmed = text.strip_suffix('\n').map(|t| t.strip_suffix('\r').unwrap_or(t)).unwrap_or(text);
    Stats {
        lines: if text.is_empty() { 0 } else { trimmed.split('\n').count() },
        settings: live.iter().map(|b| usize::from(b.header.is_some()) + b.body.iter().filter(|l| l.kind == LineKind::Option).count()).sum(),
        blocks: live.iter().filter(|b| b.kind != Kind::Global).count(),
    }
}

fn render(cfg: &Parsed, blocks: &[Block]) -> (String, Vec<(String, usize)>) {
    let mut lines: Vec<(String, usize)> = Vec::new();
    let mut after_drop = false;
    let push = |l: &Line, after_drop: &mut bool, lines: &mut Vec<(String, usize)>| {
        let prev_blank = lines.last().is_none_or(|(t, _)| t.trim().is_empty());
        if l.kind == LineKind::Blank && prev_blank && (l.n == 0 || *after_drop) {
            return;
        }
        if l.kind != LineKind::Blank {
            *after_drop = false;
        }
        lines.push((l.raw.clone(), l.n));
    };
    for b in blocks {
        if b.dropped {
            after_drop = true;
            for l in &b.lead {
                push(l, &mut after_drop, &mut lines);
            }
            continue;
        }
        for l in b.lead.iter().chain(b.header.iter()).chain(b.body.iter()).chain(b.tail.iter()) {
            push(l, &mut after_drop, &mut lines);
        }
    }
    for l in &cfg.trailer {
        push(l, &mut after_drop, &mut lines);
    }
    let mut text = lines.iter().map(|(t, _)| t.as_str()).collect::<Vec<_>>().join(cfg.newline);
    if !lines.is_empty() && cfg.ends_with_newline {
        text.push_str(cfg.newline);
    }
    (text, lines)
}

fn probes(blocks: &[Block]) -> Vec<String> {
    let mut out: Vec<String> = vec![NOBODY.to_string()];
    for b in blocks.iter().filter(|b| b.kind == Kind::Host) {
        for p in &b.patterns {
            let q = p.strip_prefix('!').unwrap_or(p);
            let name = if is_wild(q) { q.replace('*', "zz").replace('?', "z") } else { q.to_string() };
            if !out.contains(&name) {
                out.push(name);
            }
        }
    }
    out
}

/// 簡化一份 ssh config（跟網頁版的 `tidyConfig` 同一個結果）。/ Simplify an ssh config (the web's `tidyConfig`, same result).
pub fn tidy(text: &str, wildcards: bool) -> TidyResult {
    let cfg = parse_config(text);
    let mut changes: Vec<Change> = Vec::new();
    let mut notes: Vec<Note> = Vec::new();
    let keywords: HashSet<&str> = KEYWORDS.split_whitespace().collect();
    let ignored: HashSet<&str> = IGNORED.split_whitespace().collect();
    for b in &cfg.blocks {
        for l in b.header.iter().chain(b.body.iter()) {
            match l.kind {
                LineKind::Invalid => notes.push(Note::Invalid { n: l.n }),
                LineKind::Option => {
                    let lower = l.key.to_lowercase();
                    if l.slot == "match" || l.slot == "include" {
                        notes.push(Note::Wall { n: l.n, key: l.key.clone() });
                    } else if ignored.contains(lower.as_str()) {
                        notes.push(Note::Ignored { n: l.n, key: l.key.clone() });
                    } else if !keywords.contains(lower.as_str()) {
                        notes.push(Note::Unknown { n: l.n, key: l.key.clone() });
                    }
                }
                _ => {}
            }
        }
    }
    let original = cfg.blocks.clone();
    let mut keep: HashSet<usize> = HashSet::new();
    let drop = dead_lines(&original, &mut changes, &mut notes, &mut keep);
    let blocks: Vec<Block> = original
        .iter()
        .map(|b| match drop.get(&b.id) {
            None => b.clone(),
            Some(d) => {
                let mut n = b.clone();
                n.body.retain(|l| !d.contains(&l.uid));
                n.dropped = n.kind == Kind::Host && n.owner == Owner::User && n.body.iter().all(|l| l.kind == LineKind::Blank);
                n
            }
        })
        .collect();

    let mut widened: Vec<(String, Vec<String>)> = Vec::new();
    let mut out: Vec<Block> = Vec::new();
    let mut start = 0;
    for (from, to) in segments(&blocks) {
        while start < from {
            out.push(blocks[start].clone());
            start += 1;
        }
        start = to;
        let seg: Vec<Block> = blocks[from..to].to_vec();
        let mut tried: HashSet<String> = HashSet::new();
        let mut cur = seg.clone();
        for _round in 0..500 {
            let list = candidates(&cur, &keep, &tried);
            let Some(first) = list.into_iter().next() else { break };
            let mut c = Some(first);
            let mut next: Option<Vec<Block>> = None;
            while let Some(cand) = c.as_ref() {
                tried.insert(cand.key.clone());
                let hosts = hosts_of(&cand.members);
                let mut bad: Vec<String> = Vec::new();
                for after in [true, false] {
                    let attempt = apply_group(&cfg, &cur, cand, after);
                    let diff = differing(&seg, &attempt, &hosts);
                    if diff.is_empty() {
                        next = Some(attempt);
                        break;
                    }
                    if after {
                        bad = diff;
                    }
                }
                if next.is_some() {
                    break;
                }
                let rest: Vec<Block> = cand.members.iter().filter(|m| !m.patterns.iter().any(|h| bad.contains(h))).cloned().collect();
                let smaller = if rest.len() < cand.members.len() { candidate(rest, &cand.entries) } else { None };
                c = smaller.filter(|s| s.saving >= MIN_SAVING && !tried.contains(&s.key));
            }
            let (Some(n), Some(cand)) = (next, c) else { continue };
            let removed: usize = cand.moves.values().map(HashSet::len).sum();
            changes.push(Change::Shared {
                hosts: hosts_of(&cand.members),
                keys: cand.entries.iter().map(|e| e.feature.lines[0].key.clone()).collect(),
                removed,
                telepy: matches!(cand.members[0].owner, Owner::Telepy(_)),
            });
            cur = n;
        }
        if wildcards {
            let mut i = 0;
            while i < cur.len() {
                let g = cur[i].clone();
                i += 1;
                if g.owner != Owner::User || !g.literal || g.dropped || g.patterns.len() < 2 {
                    continue;
                }
                let listed = g.patterns.iter().all(|h| cur.iter().any(|b| b.id != g.id && !b.dropped && b.kind == Kind::Host && b.patterns.contains(h)));
                if !listed {
                    continue;
                }
                let everything: Vec<&Block> = out.iter().chain(cur.iter()).chain(blocks[start..].iter()).collect();
                let Some(pattern) = wildcard_for(&g.patterns, &everything, g.id) else { continue };
                let key = g.header.as_ref().map(|h| h.key.clone()).unwrap_or_else(|| "Host".into());
                let mut next = cur.clone();
                let mut ng = g.clone();
                ng.header = Some(made_line("", &key, &pattern, "host", vec![pattern.clone()], &pattern));
                ng.patterns = vec![pattern.clone()];
                ng.literal = false;
                next[i - 1] = ng;
                if !differing(&seg, &next, &g.patterns).is_empty() {
                    continue;
                }
                changes.push(Change::Wildcard { pattern: pattern.clone(), hosts: g.patterns.clone() });
                widened.push((pattern, g.patterns.clone()));
                cur = next;
            }
        }
        out.extend(cur);
    }
    while start < blocks.len() {
        out.push(blocks[start].clone());
        start += 1;
    }

    let widen = |h: &str| widened.iter().any(|(p, hs)| glob_match(h, p) && !hs.iter().any(|x| x == h));
    let names: Vec<String> = probes(&original).into_iter().filter(|h| !widen(h)).collect();
    let mut failed: Vec<String> = names.iter().filter(|h| [false, true].iter().any(|&m| resolve(&original, h, m) != resolve(&out, h, m))).cloned().collect();
    if segments(&original).len() != segments(&out).len() {
        failed.push("*".into());
    }
    let result_blocks = if failed.is_empty() { &out } else { &original };
    let (rendered, lines) = render(&cfg, result_blocks);
    notes.sort_by_key(|n| n.line());
    TidyResult {
        before: stats(&original, text),
        after: stats(result_blocks, &rendered),
        text: rendered,
        lines,
        changes: if failed.is_empty() { changes } else { Vec::new() },
        notes,
        checked: names.into_iter().filter(|h| h != NOBODY).collect(),
        widened: if failed.is_empty() { widened } else { Vec::new() },
        failed,
    }
}

// ── Showing it ───────────────────────────────────────────────────────────────

/// 差異的一行：' ' 留著、'-' 拿掉或搬走、'+' 新寫的。/ One diff line: ' ' kept, '-' removed or moved, '+' written by tidy.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DiffLine {
    pub sign: char,
    pub text: String,
    /// 原檔的行號（'+' 是 0）。/ The source line ('+' = 0).
    pub n: usize,
}

/// 原文與結果的逐行差異（簡化不改變留下來那些行的順序，所以不必算 LCS）。
/// The line diff between the source and the result (tidy never reorders the lines it keeps, so no LCS is needed).
pub fn diff(text: &str, r: &TidyResult) -> Vec<DiffLine> {
    let mut src: Vec<&str> = text.split('\n').map(|l| l.strip_suffix('\r').unwrap_or(l)).collect();
    if src.len() > 1 && src.last() == Some(&"") {
        src.pop();
    }
    let kept: HashSet<usize> = r.lines.iter().map(|(_, n)| *n).filter(|n| *n > 0).collect();
    let mut out = Vec::new();
    let mut next = 1;
    let flush = |upto: usize, out: &mut Vec<DiffLine>, next: &mut usize| {
        while *next < upto && *next <= src.len() {
            if !kept.contains(next) {
                out.push(DiffLine { sign: '-', text: src[*next - 1].to_string(), n: *next });
            }
            *next += 1;
        }
    };
    // 每一行之後下一個留著的原始行號：新寫的行之前，先列完它前面那段拿掉的行（差異習慣 - 在 + 前）。
    // The next kept source line after each output line: before new lines, the removed lines of that gap come first.
    let mut upcoming = vec![src.len() + 1; r.lines.len() + 1];
    for i in (0..r.lines.len()).rev() {
        upcoming[i] = if r.lines[i].1 > 0 { r.lines[i].1 } else { upcoming[i + 1] };
    }
    for (i, (t, n)) in r.lines.iter().enumerate() {
        if *n == 0 {
            flush(upcoming[i], &mut out, &mut next);
            out.push(DiffLine { sign: '+', text: t.clone(), n: 0 });
        } else {
            flush(*n, &mut out, &mut next);
            out.push(DiffLine { sign: ' ', text: t.clone(), n: *n });
            next = n + 1;
        }
    }
    flush(src.len() + 1, &mut out, &mut next);
    out
}

/// 只留改動附近 `context` 行，其餘收成「…」（None）。/ Keep `context` lines around changes; the rest collapse to None.
pub fn hunks(d: &[DiffLine], context: usize) -> Vec<Option<&DiffLine>> {
    let near: Vec<bool> = (0..d.len()).map(|i| (i.saturating_sub(context)..=(i + context).min(d.len().saturating_sub(1))).any(|j| d[j].sign != ' ')).collect();
    let mut out = Vec::new();
    for (i, l) in d.iter().enumerate() {
        if near[i] {
            out.push(Some(l));
        } else if out.last().is_none_or(|x: &Option<&DiffLine>| x.is_some()) {
            out.push(None);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn shared_lines_go_once_and_hostname_becomes_a_template() {
        let text = "Host web1\n    HostName web1.example.com\n    User deploy\nHost web2\n    HostName web2.example.com\n    User deploy\nHost db\n    HostName 10.0.0.5\n    User deploy\n";
        let r = tidy(text, false);
        assert!(r.failed.is_empty());
        assert_eq!(r.text, "Host db\n    HostName 10.0.0.5\nHost web1 web2 db\n    HostName %h.example.com\n    User deploy\n");
    }

    #[test]
    fn matching_follows_openssh() {
        assert!(glob_match("web1", "web*") && glob_match("ab", "?b") && !glob_match("WEB1", "web1"));
        assert!(!host_matches(&["web*".into(), "!web2".into()], "web2"));
        assert!(globs_intersect("web-*", "*.lab") && !globs_intersect("web-*", "db-*"));
        assert_eq!(argv_split(r#"a "b c" d\ e #x"#), Some(vec!["a".into(), "b c".into(), "d e".into()]));
        assert_eq!(argv_split("\"open"), None);
    }

    #[test]
    fn the_diff_marks_removed_and_new_lines() {
        let text = "Host a\n    User x\nHost b\n    User x\n";
        let r = tidy(text, false);
        let d = diff(text, &r);
        assert_eq!(d.iter().map(|l| l.sign).collect::<String>(), "----++");
        assert_eq!(hunks(&d, 1).len(), 6);
    }
}
