//! 指令規則的比對（純函式）：把一行 shell 拆成一個個簡單指令（看穿 `sudo`、`env`、`sh -c`、`$(…)` 這類包裝），
//! 再拿規則比對。「指令」規則比程式名稱與必要參數（短旗標一個字母一個字母比，`-rf` = `-r` + `-f`，參數可用 `*` / `?`），
//! 「正規表示式」規則比整行。規則有兩種主人：全站（管理員）與個人（某個人寫的，管他是 owner / ADMIN 的隧道上的人，或
//! 「只有我」= 只管他自己）。「允許」規則是例外：只豁免同一個主人（全站 / 同一個人）的擋下與要核准規則——個人的允許蓋不過
//! 全站的擋下，全站的允許蓋不過個人更嚴的規則，甲的允許也蓋不過乙的規則。這是防手滑的護欄，不是安全邊界：腳本、alias、
//! 編輯器裡照樣什麼都能跑。
//! Rule matching (pure): split a shell line into simple commands (seeing through `sudo`, `env`, `sh -c`, `$(…)` and
//! similar wrappers), then match rules. "Command" rules compare the program and required arguments (short flags
//! letter by letter, `-rf` = `-r` + `-f`; arguments may use `*` / `?`); "regex" rules match the whole line.
//! Rules belong to the site (admins) or to one person (covering people on the tunnels they own or administer, or
//! "only me" = just themselves). An "allow" rule is an exception that exempts a command from the block / approve
//! rules **of the same owner only**: a personal allow never overrides a site-wide block, a site allow never overrides
//! a personal stricter rule, and one person's allow never overrides another's rule. A guard against mistakes, not a
//! security boundary: scripts, aliases and editors can still run anything.

use regex::{Regex, RegexBuilder};

/// 一行最多看這麼多字元（再長就截斷）。/ Characters of a line that are looked at.
pub const MAX_LINE: usize = 8192;
/// 包裝最多看穿幾層。/ How many wrappers deep we look.
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 直接擋下。/ Refused outright.
    Block,
    /// 等 owner / ADMIN（或規則指定的人）核准。/ Held until the owner, an ADMIN or the rule's own approvers approve.
    Approve,
    /// 提醒：指令照跑，打的人看到一行提示（自己可以靜音）。/ A reminder: the command runs and its typist sees a note (mutable).
    Warn,
    /// 例外：豁免同範圍的擋下 / 要核准 / 提醒規則。/ An exception: exempt from the same scope's block / approve / warn rules.
    Allow,
}

impl Action {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "block" => Some(Self::Block),
            "approve" => Some(Self::Approve),
            "warn" => Some(Self::Warn),
            "allow" => Some(Self::Allow),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Approve => "approve",
            Self::Warn => "warn",
            Self::Allow => "allow",
        }
    }
}

/// 全站規則能不能覆寫。/ Whether a site rule can be overridden.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Mode {
    /// 誰都不能覆寫（🔒）。/ Nobody overrides it.
    Enforced,
    /// 隧道的 owner / ADMIN 可以在自己的隧道上關掉或用自己的例外豁免；提醒每個人可以靜音。
    /// Owners / ADMINs may turn it off on their tunnels or exempt it with their own exceptions; anyone may mute a reminder.
    Default,
}

impl Mode {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "enforced" => Some(Self::Enforced),
            "default" => Some(Self::Default),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Enforced => "enforced",
            Self::Default => "default",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Command,
    Regex,
}

impl Kind {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "command" => Some(Self::Command),
            "regex" => Some(Self::Regex),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Command => "command",
            Self::Regex => "regex",
        }
    }
}

/// 規則管誰：所有人、只管不能核准的人（ADMIN 以下的 sharee），或（個人規則）只管寫它的人自己。/ Who a rule applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    Everyone,
    Sharees,
    /// 只有規則的主人自己（個人規則才有）。/ Only the rule's owner (personal rules only).
    Me,
}

impl Who {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "everyone" => Some(Self::Everyone),
            "sharees" => Some(Self::Sharees),
            "me" => Some(Self::Me),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Everyone => "everyone",
            Self::Sharees => "sharees",
            Self::Me => "me",
        }
    }
}

/// 規則管哪裡：網頁終端機、MCP agent，或兩者。/ Where a rule applies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Via {
    All,
    Terminal,
    Agents,
}

impl Via {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "all" => Some(Self::All),
            "terminal" => Some(Self::Terminal),
            "agents" => Some(Self::Agents),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::All => "all",
            Self::Terminal => "terminal",
            Self::Agents => "agents",
        }
    }
}

/// 指令從哪來。/ Where a command comes from.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    Terminal,
    Agent,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Terminal => "terminal",
            Self::Agent => "agent",
        }
    }
}

/// 一個簡單指令：程式（basename）與參數。/ One simple command: the program (basename) and its arguments.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SimpleCommand {
    pub program: String,
    pub args: Vec<String>,
}

/// 編譯好的比對式。/ A compiled pattern.
#[derive(Debug, Clone)]
pub enum Matcher {
    Command { program: String, required: Vec<String> },
    Regex(Regex),
}

impl Matcher {
    /// 建立比對式；不合法就回錯誤訊息（給表單）。/ Build a matcher, or a message for the form.
    pub fn new(kind: Kind, pattern: &str) -> Result<Self, String> {
        let pattern = pattern.trim();
        if pattern.is_empty() {
            return Err("Enter a command or a pattern.".into());
        }
        if pattern.chars().count() > 500 {
            return Err("Keep the pattern under 500 characters.".into());
        }
        match kind {
            Kind::Command => {
                let words = split_words(pattern);
                let [first, rest @ ..] = words.as_slice() else { return Err("Enter a command, e.g. `rm -rf` or `systemctl stop`.".into()) };
                if words.len() != split_all(pattern).len() || split_commands(pattern).len() > 1 {
                    return Err("A command rule is one command with its arguments; use a regular expression for anything else.".into());
                }
                let program = program_name(first);
                if program.is_empty() {
                    return Err("Enter a command, e.g. `rm -rf` or `systemctl stop`.".into());
                }
                let mut required = Vec::new();
                for w in rest {
                    match short_cluster(w) {
                        Some(letters) => required.extend(letters),
                        None => required.push(w.clone()),
                    }
                }
                required.dedup();
                Ok(Self::Command { program, required })
            }
            Kind::Regex => RegexBuilder::new(pattern)
                .size_limit(1 << 20)
                .build()
                .map(Self::Regex)
                .map_err(|e| format!("Not a valid regular expression: {}", e.to_string().lines().next_back().unwrap_or("syntax error").trim())),
        }
    }

    /// 這一行（已拆好的指令）符合嗎？/ Does this line (already split into commands) match?
    pub fn matches(&self, line: &str, commands: &[SimpleCommand]) -> bool {
        match self {
            Self::Regex(re) => re.is_match(line),
            Self::Command { program, required } => commands.iter().any(|c| {
                glob(program, &c.program, true) && {
                    let tokens = arg_tokens(&c.args);
                    required.iter().all(|r| tokens.iter().any(|a| glob(r, a, false)))
                }
            }),
        }
    }
}

/// 評估用的規則。/ A rule ready for evaluation.
#[derive(Debug, Clone)]
pub struct Rule {
    pub id: i64,
    /// None = 全站規則；Some = 這個人的個人規則。/ None = a site-wide rule; Some = that person's personal rule.
    pub owner: Option<i64>,
    /// 個人規則主人的帳號名稱（給畫面與紀錄）。/ The personal rule owner's username (for the UI and the logs).
    pub owner_name: Option<String>,
    /// 全站規則能不能覆寫（個人規則一律 Default）。/ Whether a site rule can be overridden (personal rules: Default).
    pub mode: Mode,
    /// 「要核准」等多久（秒）；None = 網站設定。/ How long an approval waits; None = the site setting.
    pub approval_timeout: Option<i64>,
    pub action: Action,
    pub who: Who,
    pub via: Via,
    pub pattern: String,
    pub kind: Kind,
    pub note: String,
    /// 「要核准」規則指定的核准人；空 = owner + ADMIN sharee。/ The approvers an "approve" rule names; empty = owner + ADMIN.
    pub approver_ids: Vec<i64>,
    pub matcher: Matcher,
}

impl Rule {
    /// 全站（沒有主人）或個人。/ Site-wide (no owner) or personal.
    pub fn scope(&self) -> Scope {
        if self.owner.is_some() {
            Scope::Personal
        } else {
            Scope::Site
        }
    }

    /// 紀錄用的範圍：site / personal / self（「只有我」）。/ The scope for the records: site / personal / self ("only me").
    pub fn record_scope(&self) -> &'static str {
        match (self.scope(), self.who) {
            (Scope::Site, _) => "site",
            (Scope::Personal, Who::Me) => "self",
            (Scope::Personal, _) => "personal",
        }
    }

    /// 這條規則可以被覆寫嗎（強制的全站規則不行）。/ Whether it can be overridden (enforced site rules can't).
    pub fn overridable(&self) -> bool {
        self.mode == Mode::Default
    }

    /// 這條規則管不管這個人、這個來源。個人規則（管別人的）只在主人還是這條隧道的 owner / ADMIN 時算數；被這條隧道的
    /// owner / ADMIN 關掉的（`ctx.off`）或這個人靜音的提醒（`ctx.muted`）不算——強制的全站規則除外。
    /// Whether the rule covers this person and source. A personal rule for other people only counts while its owner
    /// still owns or administers the tunnel; a rule turned off here (`ctx.off`) or a reminder this person muted
    /// (`ctx.muted`) doesn't — unless it is an enforced site rule.
    fn applies(&self, ctx: &Ctx<'_>) -> bool {
        if self.overridable() && (ctx.off.contains(&self.id) || (self.action == Action::Warn && ctx.muted.contains(&self.id))) {
            return false;
        }
        let who = match (self.who, self.owner) {
            (Who::Me, owner) => owner.is_some() && ctx.user == owner,
            (_, Some(owner)) if !ctx.managers.contains(&owner) => false,
            (Who::Everyone, _) => true,
            (Who::Sharees, _) => !ctx.approver,
        };
        let via = matches!((self.via, ctx.source), (Via::All, _) | (Via::Terminal, Source::Terminal) | (Via::Agents, Source::Agent));
        who && via
    }
}

/// 規則的範圍。/ A rule's scope.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Scope {
    Site,
    Personal,
}

impl Scope {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Site => "site",
            Self::Personal => "personal",
        }
    }
}

/// 評估一行時的情境：誰在跑、他能不能核准、這條隧道由誰管、指令從哪來。
/// The context a line is judged in: who runs it, whether they approve here, who manages the tunnel, and the source.
#[derive(Debug, Clone, Copy)]
pub struct Ctx<'a> {
    /// 跑指令的人是 owner / ADMIN（「只管被分享的人」的規則不管他）。/ The person owns or administers the tunnel.
    pub approver: bool,
    /// 跑指令的人；None = 假想的另一個人（試跑時）。/ The person running it; None = a hypothetical someone else (tester).
    pub user: Option<i64>,
    /// 這條隧道的 owner 與 ADMIN sharee。/ The tunnel's owner and ADMIN sharees.
    pub managers: &'a [i64],
    pub source: Source,
    /// 在這條隧道上被 owner / ADMIN 關掉的規則。/ Rules an owner / ADMIN turned off on this tunnel.
    pub off: &'a [i64],
    /// 這個人靜音的提醒規則。/ Reminder rules this person muted.
    pub muted: &'a [i64],
}

/// 一個範圍（全站或隧道）的結果：符合的擋下 / 要核准規則，與豁免它的允許規則（有允許就不算）。
/// One scope's outcome: the block / approve rule that matched, and the allow rule that exempted it (if any).
#[derive(Debug, Clone, Copy, Default)]
pub struct ScopeVerdict<'a> {
    /// 符合的擋下 / 要核准規則（擋下優先）；被豁免時也留著，給畫面說「本來會…」。
    /// The block / approve rule that matched (block first); kept when exempted so the UI can say "would have …".
    pub hit: Option<&'a Rule>,
    /// 豁免這個範圍的允許規則。/ The allow rule that exempts this scope.
    pub allowed_by: Option<&'a Rule>,
}

impl<'a> ScopeVerdict<'a> {
    /// 這個範圍真正算數的規則（被豁免 = None）。/ The rule that counts for this scope (None when exempted).
    pub fn effective(&self) -> Option<&'a Rule> {
        if self.allowed_by.is_some() {
            None
        } else {
            self.hit
        }
    }
}

/// 一行的完整結果：全站與個人規則各自的結果（全站 = 強制與可覆寫兩組、個人 = 每位主人各自算完後最嚴的那個），合起來
/// 擋下 > 要核准 > 提醒 > 放行。
/// The whole verdict: the site-wide outcome (enforced and overridable rules, each on its own) and the personal one
/// (the strictest of each owner's own outcome); combined, block > approve > warn > allowed.
#[derive(Debug, Clone, Copy, Default)]
pub struct Verdict<'a> {
    pub site: ScopeVerdict<'a>,
    pub personal: ScopeVerdict<'a>,
}

impl<'a> Verdict<'a> {
    /// 要執行的決定：擋下或要核准的那條規則；None = 放行。/ The decision: the block or approve rule; None = allowed.
    pub fn decision(&self) -> Option<&'a Rule> {
        let effective = [self.site.effective(), self.personal.effective()];
        [Action::Block, Action::Approve, Action::Warn].into_iter().find_map(|a| effective.iter().flatten().find(|r| r.action == a)).copied()
    }

    /// 放行而且是因為允許規則的（本來會被擋下 / 要核准）。/ Allowed because of an allow rule (it would otherwise be caught).
    pub fn allowed_by(&self) -> Option<&'a Rule> {
        if self.decision().is_some() {
            return None;
        }
        [self.site, self.personal].iter().find(|s| s.hit.is_some()).and_then(|s| s.allowed_by)
    }
}

/// 一行（或好幾個候選行）的結果。每位主人：先找符合的允許規則；有，就豁免同一位主人的擋下 / 要核准 / 提醒。全站分兩組：
/// 強制的只有全站自己的例外能豁免；可以覆寫的，這條隧道的 owner / ADMIN 的例外也能豁免。每一邊再取最嚴的
/// （擋下 > 要核准 > 提醒 > 被豁免 > 只有允許），最後全站與個人合起來（擋下 > 要核准 > 提醒 > 放行）。
/// The verdict for a line (or several candidate readings of it). Per owner: an allow rule that matches exempts the same
/// owner's block / approve / warn rules. Site rules come in two groups: enforced ones only yield to site exceptions;
/// overridable ones also yield to exceptions of this tunnel's owner / ADMINs. Each side takes its strictest outcome
/// (block > approve > warn > exempted > allow only), then site and personal combine as block > approve > warn > allowed.
pub fn evaluate<'a>(rules: &'a [Rule], lines: &[String], ctx: &Ctx<'_>) -> Verdict<'a> {
    let parsed: Vec<(&str, Vec<SimpleCommand>)> = lines
        .iter()
        .map(|l| truncate(l))
        .filter(|l| !l.trim().is_empty())
        .map(|l| (l, commands(l)))
        .collect();
    if parsed.is_empty() {
        return Verdict::default();
    }
    let matching = |r: &&Rule| parsed.iter().any(|(line, cmds)| r.matcher.matches(line, cmds));
    let find = |pick: &dyn Fn(&Rule) -> bool| rules.iter().filter(|r| pick(r) && r.applies(ctx)).find(matching);
    let caught = |pick: &dyn Fn(&Rule) -> bool| {
        [Action::Block, Action::Approve, Action::Warn].into_iter().find_map(|a| find(&|r: &Rule| pick(r) && r.action == a))
    };
    let of = |owner: Option<i64>| ScopeVerdict {
        hit: caught(&|r: &Rule| r.owner == owner && r.action != Action::Allow),
        allowed_by: find(&|r: &Rule| r.owner == owner && r.action == Action::Allow),
    };
    // 全站：強制的只認全站的例外；可以覆寫的也認這條隧道 owner / ADMIN 的例外。
    // Site: enforced rules only yield to site exceptions; overridable ones also to the tunnel managers' exceptions.
    let site_allow = find(&|r: &Rule| r.owner.is_none() && r.action == Action::Allow);
    let manager_allow = find(&|r: &Rule| r.action == Action::Allow && r.owner.is_some_and(|o| ctx.managers.contains(&o)));
    let enforced = ScopeVerdict { hit: caught(&|r: &Rule| r.owner.is_none() && r.mode == Mode::Enforced && r.action != Action::Allow), allowed_by: site_allow };
    let default = ScopeVerdict { hit: caught(&|r: &Rule| r.owner.is_none() && r.mode == Mode::Default && r.action != Action::Allow), allowed_by: site_allow.or(manager_allow) };
    let mut owners: Vec<i64> = Vec::new();
    for o in rules.iter().filter_map(|r| r.owner) {
        if !owners.contains(&o) {
            owners.push(o);
        }
    }
    let each: Vec<ScopeVerdict<'a>> = owners.into_iter().map(|o| of(Some(o))).collect();
    Verdict { site: strictest(&[enforced, default]), personal: strictest(&each) }
}

/// 幾組結果裡最嚴的那組（擋下 > 要核准 > 提醒 > 被豁免 > 只有允許）。/ The strictest of several outcomes.
fn strictest<'a>(each: &[ScopeVerdict<'a>]) -> ScopeVerdict<'a> {
    let by = |action: Action| each.iter().find(|v| v.effective().is_some_and(|r| r.action == action));
    by(Action::Block)
        .or_else(|| by(Action::Approve))
        .or_else(|| by(Action::Warn))
        .or_else(|| each.iter().find(|v| v.hit.is_some()))
        .or_else(|| each.iter().find(|v| v.allowed_by.is_some()))
        .copied()
        .unwrap_or_default()
}

fn truncate(s: &str) -> &str {
    match s.char_indices().nth(MAX_LINE) {
        Some((i, _)) => &s[..i],
        None => s,
    }
}

// ------------------------------------------------------------------ lexing

/// 拆好的一個字（`redirect` = 重新導向的目標檔名，不算參數）。/ A lexed word.
#[derive(Debug)]
enum Token {
    Word(String),
    /// 指令分隔（`;` `&&` `|` 換行 `$(` `)` 反引號…）。/ A command boundary.
    Break,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Nest {
    /// `$(` 或 `(`。
    Paren,
    Backtick,
}

/// 簡化的 shell 斷字：引號、跳脫、分隔符、`$(…)` / 反引號 / 子 shell、重新導向（目標檔名丟掉）。
/// A simplified shell lexer: quotes, escapes, separators, `$(…)` / backticks / subshells, redirections (targets dropped).
// 巨集展開後有幾處「設了沒讀」是正常的。/ Some macro expansions assign a flag that is overwritten right after.
#[allow(unused_assignments)]
fn lex(line: &str) -> Vec<Token> {
    let chars: Vec<char> = line.chars().collect();
    let mut out = Vec::new();
    let mut word: Option<String> = None;
    let mut in_single = false;
    let mut in_double = false;
    // 進入 `$(` / 反引號時記住外面是不是在雙引號裡。/ Saved double-quote state per substitution.
    let mut stack: Vec<(Nest, bool)> = Vec::new();
    let mut skip_next_word = false;
    let mut i = 0;

    macro_rules! end_word {
        () => {
            if let Some(w) = word.take() {
                if skip_next_word {
                    skip_next_word = false;
                } else {
                    out.push(Token::Word(w));
                }
            }
        };
    }
    macro_rules! brk {
        () => {{
            if let Some(w) = word.take() {
                if !skip_next_word {
                    out.push(Token::Word(w));
                }
            }
            skip_next_word = false;
            out.push(Token::Break);
        }};
    }

    while i < chars.len() {
        let c = chars[i];
        if in_single {
            if c == '\'' {
                in_single = false;
            } else {
                word.get_or_insert_with(String::new).push(c);
            }
            i += 1;
            continue;
        }
        if in_double {
            match c {
                '"' => in_double = false,
                '\\' if i + 1 < chars.len() && matches!(chars[i + 1], '$' | '`' | '"' | '\\' | '\n') => {
                    if chars[i + 1] != '\n' {
                        word.get_or_insert_with(String::new).push(chars[i + 1]);
                    }
                    i += 1;
                }
                '$' if chars.get(i + 1) == Some(&'(') => {
                    brk!();
                    stack.push((Nest::Paren, true));
                    in_double = false;
                    i += 1;
                }
                '`' => {
                    brk!();
                    stack.push((Nest::Backtick, true));
                    in_double = false;
                }
                _ => word.get_or_insert_with(String::new).push(c),
            }
            i += 1;
            continue;
        }
        match c {
            '\'' => {
                in_single = true;
                word.get_or_insert_with(String::new);
            }
            '"' => {
                in_double = true;
                word.get_or_insert_with(String::new);
            }
            '\\' => {
                if let Some(&n) = chars.get(i + 1) {
                    if n != '\n' {
                        word.get_or_insert_with(String::new).push(n);
                    }
                    i += 1;
                }
            }
            ' ' | '\t' => end_word!(),
            '\n' | '\r' | ';' => brk!(),
            '|' => {
                brk!();
                if matches!(chars.get(i + 1), Some('|') | Some('&')) {
                    i += 1;
                }
            }
            '&' => {
                if chars.get(i + 1) == Some(&'>') {
                    // `&>file` / `&>>file`：重新導向。/ A redirection.
                    end_word!();
                    i += 1;
                    if chars.get(i + 1) == Some(&'>') {
                        i += 1;
                    }
                    skip_next_word = true;
                } else {
                    brk!();
                    if chars.get(i + 1) == Some(&'&') {
                        i += 1;
                    }
                }
            }
            '$' if chars.get(i + 1) == Some(&'(') => {
                brk!();
                stack.push((Nest::Paren, false));
                i += 1;
            }
            '(' => {
                brk!();
                stack.push((Nest::Paren, false));
            }
            ')' => {
                brk!();
                if let Some(pos) = stack.iter().rposition(|(k, _)| *k == Nest::Paren) {
                    let (_, dq) = stack[pos];
                    stack.truncate(pos);
                    in_double = dq;
                }
            }
            '`' => {
                brk!();
                match stack.last() {
                    Some((Nest::Backtick, dq)) => {
                        in_double = *dq;
                        stack.pop();
                    }
                    _ => stack.push((Nest::Backtick, false)),
                }
            }
            '>' | '<' => {
                // `2>` 的 2 是檔案描述元，不是參數。/ The `2` of `2>` is a file descriptor.
                if word.as_deref().is_some_and(|w| !w.is_empty() && w.chars().all(|d| d.is_ascii_digit())) {
                    word = None;
                }
                end_word!();
                while matches!(chars.get(i + 1), Some('>') | Some('<') | Some('|')) {
                    i += 1;
                }
                if chars.get(i + 1) == Some(&'&') {
                    // `>&2` / `<&-`：複製描述元，沒有檔名。/ Descriptor duplication, no file name.
                    i += 1;
                    while chars.get(i + 1).is_some_and(|d| d.is_ascii_digit() || *d == '-') {
                        i += 1;
                    }
                } else if chars.get(i + 1) == Some(&'(') {
                    // `<(cmd)` / `>(cmd)`：行程替換。/ Process substitution.
                } else {
                    skip_next_word = true;
                }
            }
            _ => word.get_or_insert_with(String::new).push(c),
        }
        i += 1;
    }
    end_word!();
    out
}

/// 把一行拆成好幾段（每段 = 一個簡單指令的字）。/ Split a line into the words of each simple command.
fn split_commands(line: &str) -> Vec<Vec<String>> {
    let mut all = Vec::new();
    let mut cur = Vec::new();
    for t in lex(line) {
        match t {
            Token::Word(w) => cur.push(w),
            Token::Break => {
                if !cur.is_empty() {
                    all.push(std::mem::take(&mut cur));
                }
            }
        }
    }
    if !cur.is_empty() {
        all.push(cur);
    }
    all
}

/// 第一段的字（規則本身用）。/ The words of the first command (for a rule's own pattern).
fn split_words(line: &str) -> Vec<String> {
    split_commands(line).into_iter().next().unwrap_or_default()
}

fn split_all(line: &str) -> Vec<String> {
    split_commands(line).into_iter().flatten().collect()
}

// ------------------------------------------------------------------ commands

const KEYWORDS: &[&str] = &["if", "then", "else", "elif", "fi", "do", "done", "while", "until", "!", "{", "}", "[[", "]]", "coproc"];

fn is_assignment(w: &str) -> bool {
    match w.split_once('=') {
        Some((name, _)) => !name.is_empty() && name.chars().next().is_some_and(|c| c.is_ascii_alphabetic() || c == '_') && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '_'),
        None => false,
    }
}

/// 程式名稱：去掉前面的 `\`（略過 alias）、取 basename、轉小寫。/ The program's name: no leading `\`, basename, lower case.
fn program_name(w: &str) -> String {
    let w = w.trim_start_matches('\\');
    w.rsplit('/').next().unwrap_or(w).to_lowercase()
}

/// `-rf` → `-r`, `-f`。長選項（`--force`）與單一字母不拆。/ Split a short-flag cluster.
fn short_cluster(w: &str) -> Option<Vec<String>> {
    let rest = w.strip_prefix('-')?;
    if rest.starts_with('-') || rest.chars().count() < 2 || !rest.chars().all(|c| c.is_ascii_alphanumeric()) {
        return None;
    }
    Some(rest.chars().map(|c| format!("-{c}")).collect())
}

/// 參數加上拆開的短旗標。/ Arguments plus their split short flags.
fn arg_tokens(args: &[String]) -> Vec<String> {
    let mut out = Vec::with_capacity(args.len());
    for a in args {
        out.push(a.clone());
        if let Some(letters) = short_cluster(a) {
            out.extend(letters);
        }
    }
    out
}

/// 一行裡的所有簡單指令（含包裝裡面的）。/ Every simple command in a line, including wrapped ones.
pub fn commands(line: &str) -> Vec<SimpleCommand> {
    let mut out = Vec::new();
    for words in split_commands(line) {
        expand(&words, 0, &mut out);
    }
    out
}

/// 選項跳過：`with_arg` 是要吃掉下一個字的選項。回第一個非選項的位置。
/// Skip options (`with_arg` options take the next word); returns the index of the first operand.
fn skip_options(args: &[String], with_arg: &[&str]) -> usize {
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        if a == "--" {
            return i + 1;
        }
        if !a.starts_with('-') || a == "-" {
            return i;
        }
        if with_arg.contains(&a) {
            i += 2;
        } else {
            i += 1;
        }
    }
    i
}

fn expand(words: &[String], depth: usize, out: &mut Vec<SimpleCommand>) {
    if depth > MAX_DEPTH {
        return;
    }
    let mut start = 0;
    while start < words.len() && (words[start].is_empty() || is_assignment(&words[start]) || KEYWORDS.contains(&words[start].as_str())) {
        start += 1;
    }
    let words = &words[start..];
    let Some(first) = words.first() else { return };
    let program = program_name(first);
    let args = &words[1..];
    out.push(SimpleCommand { program: program.clone(), args: args.to_vec() });

    let inner: Option<usize> = match program.as_str() {
        "sudo" => Some(skip_options(args, &["-u", "-g", "-h", "-p", "-C", "-D", "-r", "-t", "-T", "-U", "-R", "--user", "--group", "--host", "--prompt", "--close-from", "--chdir", "--role", "--type", "--command-timeout", "--other-user", "--chroot"])),
        "doas" => Some(skip_options(args, &["-u", "-C"])),
        "command" if args.first().is_some_and(|a| a == "-v" || a == "-V") => None,
        "nohup" | "builtin" | "setsid" | "unbuffer" | "caffeinate" | "exec" | "command" | "time" | "busybox" | "chronic" | "flock" => Some(match program.as_str() {
            "exec" => skip_options(args, &["-a"]),
            "flock" => skip_options(args, &["-w", "-E", "--timeout", "--conflict-exit-code"]).saturating_add(1).min(args.len()),
            _ => skip_options(args, &[]),
        }),
        "nice" => Some(skip_options(args, &["-n", "--adjustment"])),
        "ionice" => Some(skip_options(args, &["-c", "-n", "-p", "-P", "-u", "--class", "--classdata"])),
        "stdbuf" => Some(skip_options(args, &["-i", "-o", "-e", "--input", "--output", "--error"])),
        "taskset" => Some(skip_options(args, &[]).saturating_add(1).min(args.len())),
        "chroot" => Some(skip_options(args, &["--userspec", "--groups"]).saturating_add(1).min(args.len())),
        "timeout" => Some(skip_options(args, &["-s", "-k", "--signal", "--kill-after"]).saturating_add(1).min(args.len())),
        "watch" => Some(skip_options(args, &["-n", "-d", "--interval", "--differences", "-q", "--equexit"])),
        "xargs" => Some(skip_options(args, &["-a", "-d", "-E", "-e", "-I", "-i", "-L", "-l", "-n", "-P", "-s", "--arg-file", "--delimiter", "--eof", "--replace", "--max-lines", "--max-args", "--max-procs", "--max-chars", "--process-slot-var"])),
        "env" => {
            let mut i = skip_options(args, &["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]);
            // `env -S "cmd args"`：字串本身是指令。/ `env -S` takes the command as one string.
            if let Some(pos) = args.iter().position(|a| a == "-S" || a == "--split-string") {
                if let Some(s) = args.get(pos + 1) {
                    for words in split_commands(s) {
                        expand(&words, depth + 1, out);
                    }
                }
            }
            while i < args.len() && is_assignment(&args[i]) {
                i += 1;
            }
            Some(i)
        }
        "sh" | "bash" | "zsh" | "dash" | "ksh" | "ash" | "fish" | "mksh" | "su" | "runuser" => {
            // `-c STRING`（`-lc`、`-ec` 也算）、`--command=STRING`：字串裡面是指令。/ The `-c` string is a command line.
            let mut script: Option<&str> = None;
            let mut i = 0;
            while i < args.len() {
                let a = args[i].as_str();
                if let Some(s) = a.strip_prefix("--command=") {
                    script = Some(s);
                    break;
                }
                if a == "--command" || (a.starts_with('-') && !a.starts_with("--") && a.contains('c')) {
                    script = args.get(i + 1).map(String::as_str);
                    break;
                }
                i += 1;
            }
            if let Some(s) = script {
                for words in split_commands(s) {
                    expand(&words, depth + 1, out);
                }
            }
            None
        }
        "eval" => {
            let joined = args.join(" ");
            for words in split_commands(&joined) {
                expand(&words, depth + 1, out);
            }
            None
        }
        _ => None,
    };
    if let Some(i) = inner {
        if i < args.len() {
            expand(&args[i..], depth + 1, out);
        }
    }
}

// ------------------------------------------------------------------ glob

/// `*` = 任意字元、`?` = 一個字元。/ `*` matches anything, `?` one character.
fn glob(pattern: &str, text: &str, fold: bool) -> bool {
    let (p, t): (Vec<char>, Vec<char>) = if fold {
        (pattern.to_lowercase().chars().collect(), text.to_lowercase().chars().collect())
    } else {
        (pattern.chars().collect(), text.chars().collect())
    };
    if !p.contains(&'*') && !p.contains(&'?') {
        return p == t;
    }
    let (mut pi, mut ti) = (0, 0);
    let (mut star, mut mark) = (None, 0);
    while ti < t.len() {
        if pi < p.len() && (p[pi] == '?' || p[pi] == t[ti]) {
            pi += 1;
            ti += 1;
        } else if pi < p.len() && p[pi] == '*' {
            star = Some(pi);
            mark = ti;
            pi += 1;
        } else if let Some(s) = star {
            pi = s + 1;
            mark += 1;
            ti = mark;
        } else {
            return false;
        }
    }
    while pi < p.len() && p[pi] == '*' {
        pi += 1;
    }
    pi == p.len()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn rule(action: Action, kind: Kind, pattern: &str) -> Rule {
        Rule {
            id: 1,
            owner: None,
            owner_name: None,
            mode: Mode::Default,
            approval_timeout: None,
            action,
            who: Who::Everyone,
            via: Via::All,
            pattern: pattern.into(),
            kind,
            note: String::new(),
            approver_ids: Vec::new(),
            matcher: Matcher::new(kind, pattern).unwrap(),
        }
    }

    /// 7 號（這條隧道的 owner）的個人規則。/ A personal rule of user 7, who owns the tunnel.
    fn tunnel_rule(id: i64, action: Action, pattern: &str) -> Rule {
        owned(7, id, action, pattern)
    }

    fn owned(owner: i64, id: i64, action: Action, pattern: &str) -> Rule {
        Rule { id, owner: Some(owner), ..rule(action, Kind::Command, pattern) }
    }

    /// 隧道由 7 與 8 管；跑指令的是假想的另一個人。/ Users 7 and 8 manage the tunnel; a hypothetical someone runs it.
    const MANAGERS: &[i64] = &[7, 8];

    fn ctx(approver: bool, source: Source) -> Ctx<'static> {
        Ctx { approver, user: None, managers: MANAGERS, source, off: &[], muted: &[] }
    }

    fn eval<'a>(rules: &'a [Rule], line: &str, approver: bool, source: Source) -> Verdict<'a> {
        evaluate(rules, &[line.to_string()], &ctx(approver, source))
    }

    fn site_rule(id: i64, action: Action, pattern: &str) -> Rule {
        Rule { id, ..rule(action, Kind::Command, pattern) }
    }

    /// 強制（誰都不能覆寫）的全站規則。/ An enforced site rule.
    fn enforced(id: i64, action: Action, pattern: &str) -> Rule {
        Rule { mode: Mode::Enforced, ..site_rule(id, action, pattern) }
    }

    fn hits(pattern: &str, line: &str) -> bool {
        let r = [rule(Action::Block, Kind::Command, pattern)];
        eval(&r, line, false, Source::Terminal).decision().is_some()
    }

    fn decided(rules: &[Rule], line: &str, approver: bool, source: Source) -> Option<i64> {
        eval(rules, line, approver, source).decision().map(|r| r.id)
    }

    fn programs(line: &str) -> Vec<String> {
        commands(line).into_iter().map(|c| c.program).collect()
    }

    #[test]
    fn splits_lines_into_simple_commands() {
        assert_eq!(programs("ls -la; cd /tmp && rm -rf x || echo no | grep y & sleep 1"), ["ls", "cd", "rm", "echo", "grep", "sleep"]);
        assert_eq!(programs("echo $(whoami) `id` \"$(hostname)\""), ["echo", "whoami", "id", "hostname"]);
        assert_eq!(programs("(cd /; reboot)"), ["cd", "reboot"]);
        assert_eq!(programs("for f in a b; do rm \"$f\"; done"), ["for", "rm"]);
        assert_eq!(programs("FOO=1 BAR=2 /usr/bin/RM -f x"), ["rm"]);
        assert_eq!(programs("\\rm x"), ["rm"]);
        assert_eq!(programs("echo 'rm -rf /' \"; reboot\""), ["echo"]);
        assert_eq!(programs("cat <<EOF\nshutdown now\nEOF"), ["cat", "shutdown", "eof"]);
        assert_eq!(programs("diff <(ls a) >(ls b)"), ["diff", "ls", "ls"]);
    }

    #[test]
    fn redirections_are_not_arguments() {
        let c = commands("rm -f a 2>/dev/null >out.log &>all 2>&1 < in");
        assert_eq!(c.len(), 1);
        assert_eq!(c[0].args, ["-f", "a"]);
    }

    #[test]
    fn sees_through_wrappers() {
        assert_eq!(programs("sudo -u root -E rm -rf /var"), ["sudo", "rm"]);
        assert_eq!(programs("sudo -- reboot"), ["sudo", "reboot"]);
        assert_eq!(programs("env -i PATH=/bin FOO=1 rm x"), ["env", "rm"]);
        assert_eq!(programs("nohup nice -n 5 timeout -s KILL 10 rm x"), ["nohup", "nice", "timeout", "rm"]);
        assert_eq!(programs("bash -lc 'cd / && rm -rf x'"), ["bash", "cd", "rm"]);
        assert_eq!(programs("su - root -c \"systemctl stop nginx\""), ["su", "systemctl"]);
        assert_eq!(programs("eval \"rm -rf\" x"), ["eval", "rm"]);
        assert_eq!(programs("find . -name '*.log' | xargs -n 1 rm -f"), ["find", "xargs", "rm"]);
        assert_eq!(programs("busybox reboot"), ["busybox", "reboot"]);
        assert_eq!(programs("env -S 'rm -rf x'"), ["env", "rm"]);
    }

    #[test]
    fn command_rules_compare_program_and_required_arguments() {
        assert!(hits("rm -rf", "rm -rf /tmp/x"));
        assert!(hits("rm -rf", "rm -fr /tmp/x"));
        assert!(hits("rm -rf", "rm -r -f /tmp/x"));
        assert!(hits("rm -rf", "sudo rm -v -rf /tmp/x"));
        assert!(hits("rm -rf", "cd /tmp && /bin/rm -rf x"));
        assert!(!hits("rm -rf", "rm -r /tmp/x"));
        assert!(!hits("rm -rf", "echo rm -rf"));
        assert!(!hits("rm -rf", "rmdir -rf"));
        assert!(hits("reboot", "sudo reboot"));
        assert!(hits("REBOOT", "reboot now"));
        assert!(hits("systemctl stop", "systemctl --no-pager stop nginx"));
        assert!(!hits("systemctl stop", "systemctl status nginx"));
        assert!(hits("sudo", "sudo -i"));
        assert!(hits("chmod 777", "chmod -R 777 /srv"));
        assert!(hits("rm /etc/*", "rm -f /etc/passwd"));
        assert!(!hits("rm /etc/*", "rm -f /tmp/passwd"));
        assert!(hits("docker rm*", "docker rmi abc"));
        assert!(hits("git push --force", "git push origin main --force"));
        assert!(!hits("git push --force", "git push origin main"));
        assert!(hits("kill -9", "kill -9 1234"));
        assert!(hits("mkfs*", "mkfs.ext4 /dev/sdb1"));
        assert!(hits("dd of=/dev/*", "dd if=x.img of=/dev/sda bs=4M"));
    }

    #[test]
    fn regex_rules_match_the_whole_line() {
        let r = [rule(Action::Block, Kind::Regex, r"curl .*\|\s*(ba)?sh")];
        assert!(decided(&r, "curl -fsSL https://x.sh | sh", false, Source::Terminal).is_some());
        assert!(decided(&r, "curl -fsSL https://x.sh -o x", false, Source::Terminal).is_none());
    }

    #[test]
    fn block_wins_and_who_and_scope_are_honoured() {
        let mut approve = rule(Action::Approve, Kind::Command, "sudo");
        approve.id = 1;
        let mut block = rule(Action::Block, Kind::Command, "reboot");
        block.id = 2;
        let rules = [approve.clone(), block.clone()];
        assert_eq!(decided(&rules, "sudo reboot", false, Source::Terminal), Some(2));
        assert_eq!(decided(&rules, "sudo ls", false, Source::Terminal), Some(1));
        assert!(decided(&rules, "ls", false, Source::Terminal).is_none());
        assert!(decided(&rules, "   ", false, Source::Terminal).is_none());

        let mut sharees = approve.clone();
        sharees.who = Who::Sharees;
        assert!(decided(std::slice::from_ref(&sharees), "sudo ls", true, Source::Terminal).is_none());
        assert!(decided(std::slice::from_ref(&sharees), "sudo ls", false, Source::Terminal).is_some());

        let mut agents = approve;
        agents.via = Via::Agents;
        assert!(decided(std::slice::from_ref(&agents), "sudo ls", false, Source::Terminal).is_none());
        assert!(decided(std::slice::from_ref(&agents), "sudo ls", true, Source::Agent).is_some());
    }

    #[test]
    fn any_candidate_line_can_match() {
        let r = [rule(Action::Block, Kind::Command, "reboot")];
        let lines = vec!["nat@box:~$ reboot".to_string(), "reboot".to_string()];
        assert!(evaluate(&r, &lines, &ctx(false, Source::Terminal)).decision().is_some());
    }

    // ---------------------------------------------------------------- allow (exception) rules

    #[test]
    fn allow_exempts_only_its_own_scope() {
        // 強制的全站規則擋 `rm -rf`，隧道允許 `rm -rf /tmp/build/*`：還是擋（管理員的規則優先）。
        // A tunnel allow never overrides an enforced site-wide block.
        let rules = [enforced(1, Action::Block, "rm -rf"), tunnel_rule(2, Action::Allow, "rm -rf /tmp/build/*")];
        let v = eval(&rules, "rm -rf /tmp/build/x", false, Source::Terminal);
        assert_eq!(v.decision().map(|r| r.id), Some(1));
        assert_eq!(v.personal.allowed_by.map(|r| r.id), Some(2), "the tunnel allow matched, it just has nothing to exempt there");
        assert!(v.allowed_by().is_none());

        // 隧道要核准 `sudo`，全站允許 `sudo systemctl restart myapp`：還是要核准（owner 自己的規則更嚴）。
        // A site allow never overrides a tunnel's stricter rule.
        let rules = [tunnel_rule(1, Action::Approve, "sudo"), site_rule(2, Action::Allow, "sudo systemctl restart myapp")];
        assert_eq!(decided(&rules, "sudo systemctl restart myapp", false, Source::Terminal), Some(1));

        // 同範圍：允許豁免擋下，而且說得出是哪一條。/ Same scope: the allow exempts the block, and names itself.
        let rules = [site_rule(1, Action::Block, "rm -rf"), site_rule(2, Action::Allow, "rm -rf /tmp/build/*")];
        let v = eval(&rules, "rm -rf /tmp/build/x", false, Source::Terminal);
        assert!(v.decision().is_none());
        assert_eq!(v.allowed_by().map(|r| r.id), Some(2));
        assert_eq!(v.site.hit.map(|r| r.id), Some(1), "the exempted rule is still reported");
        assert_eq!(decided(&rules, "rm -rf /srv", false, Source::Terminal), Some(1), "outside the exception the block holds");
        // 同範圍：允許也豁免要核准。/ The same for approve rules of that scope.
        let rules = [tunnel_rule(1, Action::Approve, "sudo"), tunnel_rule(2, Action::Allow, "sudo systemctl restart myapp")];
        assert!(decided(&rules, "sudo systemctl restart myapp", false, Source::Terminal).is_none());
        assert_eq!(decided(&rules, "sudo reboot", false, Source::Terminal), Some(1));

        // 兩個範圍各自豁免後再合併：全站被豁免、隧道還要核准 → 要核准。/ After per-scope exemptions the scopes still combine.
        let rules = [site_rule(1, Action::Block, "rm -rf"), site_rule(2, Action::Allow, "rm -rf /tmp/*"), tunnel_rule(3, Action::Approve, "rm")];
        let v = eval(&rules, "rm -rf /tmp/x", false, Source::Terminal);
        assert_eq!(v.decision().map(|r| r.id), Some(3));
        assert!(v.allowed_by().is_none(), "not allowed overall, so no allow is credited");
        assert_eq!(v.site.allowed_by.map(|r| r.id), Some(2));
    }

    #[test]
    fn allow_rules_honour_who_and_via() {
        // 只豁免 agent 的允許：終端機還是被擋。/ An agents-only allow exempts agent calls only.
        let mut agents_only = site_rule(2, Action::Allow, "rm -rf /tmp/build/*");
        agents_only.via = Via::Agents;
        let rules = [site_rule(1, Action::Block, "rm -rf"), agents_only];
        assert_eq!(decided(&rules, "rm -rf /tmp/build/x", false, Source::Terminal), Some(1));
        assert!(decided(&rules, "rm -rf /tmp/build/x", false, Source::Agent).is_none());

        // 只給 sharee 的允許：owner / ADMIN 不在豁免內（對他們而言規則照舊）。/ A sharees-only allow leaves approvers out.
        let mut sharees_only = site_rule(2, Action::Allow, "sudo systemctl restart myapp");
        sharees_only.who = Who::Sharees;
        let rules = [site_rule(1, Action::Approve, "sudo"), sharees_only];
        assert!(decided(&rules, "sudo systemctl restart myapp", false, Source::Terminal).is_none());
        assert_eq!(decided(&rules, "sudo systemctl restart myapp", true, Source::Terminal), Some(1));
    }

    #[test]
    fn allow_rules_alone_do_nothing() {
        let rules = [site_rule(1, Action::Allow, "ls")];
        let v = eval(&rules, "ls -la", false, Source::Terminal);
        assert!(v.decision().is_none());
        assert!(v.allowed_by().is_none(), "nothing to exempt from: the allow is not credited");
    }

    // ---------------------------------------------------------------- personal rules

    #[test]
    fn personal_rules_count_only_where_their_owner_manages_the_tunnel() {
        // 9 號不管這條隧道（不是 owner / ADMIN）：他的規則在這裡不算。/ User 9 doesn't manage this tunnel: no effect here.
        let rules = [owned(9, 1, Action::Block, "reboot")];
        assert!(decided(&rules, "reboot", false, Source::Terminal).is_none());
        let rules = [owned(8, 1, Action::Block, "reboot")];
        assert_eq!(decided(&rules, "reboot", false, Source::Terminal), Some(1));
        assert_eq!(decided(&rules, "reboot", true, Source::Terminal), Some(1), "everyone = the approvers too");
    }

    #[test]
    fn only_me_rules_cover_their_owner_alone() {
        // 9 號（只是被分享的人）替自己的 agent 加的護欄：只管他，不管別人，也不管他在這裡有沒有管理權。
        // User 9 (a plain sharee) guards their own agent: it covers them only, whatever their role here.
        let mut mine = owned(9, 1, Action::Approve, "apt");
        mine.who = Who::Me;
        mine.via = Via::Agents;
        let rules = [mine];
        let as_9 = Ctx { approver: false, user: Some(9), managers: MANAGERS, source: Source::Agent, off: &[], muted: &[] };
        let as_7 = Ctx { user: Some(7), approver: true, ..as_9 };
        let v = evaluate(&rules, &["apt install x".to_string()], &as_9);
        assert_eq!(v.decision().map(|r| r.id), Some(1));
        assert_eq!(v.decision().map(Rule::record_scope), Some("self"));
        assert!(evaluate(&rules, &["apt install x".to_string()], &as_7).decision().is_none(), "never someone else's commands");
        assert!(evaluate(&rules, &["apt install x".to_string()], &Ctx { source: Source::Terminal, ..as_9 }).decision().is_none(), "agents only");
        assert!(eval(&rules, "apt install x", false, Source::Agent).decision().is_none(), "a hypothetical someone else");
    }

    #[test]
    fn an_allow_exempts_only_its_own_owners_rules() {
        // 7 擋 `rm -rf`，8 允許 `rm -rf /tmp/*`：還是擋（8 的例外管不到 7 的規則）。
        // 7 blocks `rm -rf`, 8 allows `rm -rf /tmp/*`: still blocked (8's exception can't touch 7's rule).
        let rules = [owned(7, 1, Action::Block, "rm -rf"), owned(8, 2, Action::Allow, "rm -rf /tmp/*")];
        assert_eq!(decided(&rules, "rm -rf /tmp/x", false, Source::Terminal), Some(1));
        // 同一個人的例外照樣豁免。/ The same person's exception still exempts.
        let rules = [owned(7, 1, Action::Block, "rm -rf"), owned(7, 2, Action::Allow, "rm -rf /tmp/*")];
        let v = eval(&rules, "rm -rf /tmp/x", false, Source::Terminal);
        assert!(v.decision().is_none());
        assert_eq!(v.allowed_by().map(|r| r.id), Some(2));
        // 「只有我」的允許蓋不過 owner 的擋下。/ An "only me" allow can't lift the owner's block.
        let mut escape = owned(9, 2, Action::Allow, "rm -rf /tmp/*");
        escape.who = Who::Me;
        let rules = [owned(7, 1, Action::Block, "rm -rf"), escape];
        let as_9 = Ctx { approver: false, user: Some(9), managers: MANAGERS, source: Source::Terminal, off: &[], muted: &[] };
        assert_eq!(evaluate(&rules, &["rm -rf /tmp/x".to_string()], &as_9).decision().map(|r| r.id), Some(1));
        // 兩位主人：擋下比要核准嚴。/ Two owners: a block beats an approval.
        let rules = [owned(7, 1, Action::Approve, "rm"), owned(8, 2, Action::Block, "rm -rf")];
        let v = eval(&rules, "rm -rf /x", false, Source::Terminal);
        assert_eq!(v.decision().map(|r| r.id), Some(2));
        assert_eq!(v.personal.hit.map(|r| r.id), Some(2));
    }

    #[test]
    fn overridable_site_rules_yield_to_the_tunnel_managers() {
        // 可以覆寫的全站擋下：這條隧道 owner / ADMIN（7）的例外豁免它；不管這條隧道的人（9）的例外不行。
        // An overridable site block yields to an exception of the tunnel's owner / ADMIN (7), not of someone else (9).
        let rules = [site_rule(1, Action::Block, "rm -rf"), owned(7, 2, Action::Allow, "rm -rf /tmp/*")];
        let v = eval(&rules, "rm -rf /tmp/x", false, Source::Terminal);
        assert!(v.decision().is_none());
        assert_eq!(v.allowed_by().map(|r| r.id), Some(2));
        assert_eq!(v.site.hit.map(|r| r.id), Some(1), "the exempted site rule is still reported");
        let rules = [site_rule(1, Action::Block, "rm -rf"), owned(9, 2, Action::Allow, "rm -rf /tmp/*")];
        assert_eq!(decided(&rules, "rm -rf /tmp/x", false, Source::Terminal), Some(1));
        // 強制的不行，可以覆寫的跟強制的同時符合時強制的照樣擋。/ Enforced ones don't yield, even next to an overridable one.
        let rules = [enforced(1, Action::Approve, "rm"), site_rule(3, Action::Block, "rm -rf"), owned(7, 2, Action::Allow, "rm -rf /tmp/*")];
        let v = eval(&rules, "rm -rf /tmp/x", false, Source::Terminal);
        assert_eq!(v.decision().map(|r| r.id), Some(1), "the overridable block is exempted, the enforced approval stays");

        // 在這條隧道上被關掉：可以覆寫的不算，強制的照算。/ Turned off here: overridable ones stop counting, enforced ones don't.
        let rules = [site_rule(1, Action::Block, "reboot"), enforced(2, Action::Approve, "sudo")];
        let off = Ctx { off: &[1, 2], ..ctx(false, Source::Terminal) };
        assert!(evaluate(&rules, &["reboot".to_string()], &off).decision().is_none());
        assert_eq!(evaluate(&rules, &["sudo ls".to_string()], &off).decision().map(|r| r.id), Some(2));
    }

    #[test]
    fn reminders_run_the_command_and_can_be_muted() {
        let rules = [site_rule(1, Action::Warn, "systemctl restart")];
        let v = eval(&rules, "sudo systemctl restart nginx", false, Source::Terminal);
        assert_eq!(v.decision().map(|r| r.action), Some(Action::Warn));
        // 擋下 / 要核准都比提醒嚴。/ Block and approval beat a reminder.
        let rules = [site_rule(1, Action::Warn, "systemctl restart"), owned(7, 2, Action::Approve, "sudo")];
        assert_eq!(decided(&rules, "sudo systemctl restart nginx", false, Source::Terminal), Some(2));
        // 同一位主人的例外豁免提醒。/ The same owner's exception exempts a reminder.
        let rules = [owned(7, 1, Action::Warn, "systemctl restart"), owned(7, 2, Action::Allow, "systemctl restart myapp")];
        assert!(decided(&rules, "systemctl restart myapp", false, Source::Terminal).is_none());
        // 靜音：可以覆寫的不提醒，強制的照樣提醒。/ Muted: overridable reminders go quiet, enforced ones still remind.
        let rules = [site_rule(1, Action::Warn, "reboot"), enforced(2, Action::Warn, "shutdown"), owned(7, 3, Action::Warn, "halt")];
        let muted = Ctx { muted: &[1, 2, 3], ..ctx(false, Source::Terminal) };
        assert!(evaluate(&rules, &["reboot".to_string()], &muted).decision().is_none());
        assert!(evaluate(&rules, &["halt".to_string()], &muted).decision().is_none(), "someone else's reminder to you is yours to mute");
        assert_eq!(evaluate(&rules, &["shutdown".to_string()], &muted).decision().map(|r| r.id), Some(2));
        // 靜音只對提醒有用：被「靜音」的擋下規則照擋。/ Muting only applies to reminders.
        let rules = [site_rule(1, Action::Block, "reboot")];
        assert!(evaluate(&rules, &["reboot".to_string()], &Ctx { muted: &[1], ..ctx(false, Source::Terminal) }).decision().is_some());
    }

    #[test]
    fn patterns_are_validated() {
        assert!(Matcher::new(Kind::Command, "").is_err());
        assert!(Matcher::new(Kind::Command, "rm -rf; reboot").is_err());
        assert!(Matcher::new(Kind::Command, "rm -rf | x").is_err());
        assert!(Matcher::new(Kind::Regex, "(").is_err());
        assert!(Matcher::new(Kind::Regex, "a{1000}{1000}").is_err());
        assert!(Matcher::new(Kind::Command, "systemctl stop").is_ok());
    }

    #[test]
    fn globs() {
        assert!(glob("a*c", "abbbc", false));
        assert!(glob("a?c", "abc", false));
        assert!(!glob("a?c", "abbc", false));
        assert!(glob("*", "", false));
        assert!(glob("RM", "rm", true));
        assert!(!glob("RM", "rm", false));
    }
}
