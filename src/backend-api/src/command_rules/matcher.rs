//! 指令規則的比對（純函式）：把一行 shell 拆成一個個簡單指令（看穿 `sudo`、`env`、`sh -c`、`$(…)` 這類包裝），
//! 再拿規則比對。「指令」規則比程式名稱與必要參數（短旗標一個字母一個字母比，`-rf` = `-r` + `-f`，參數可用 `*` / `?`），
//! 「正規表示式」規則比整行。這是防手滑的護欄，不是安全邊界：腳本、alias、編輯器裡照樣什麼都能跑。
//! Rule matching (pure): split a shell line into simple commands (seeing through `sudo`, `env`, `sh -c`, `$(…)` and
//! similar wrappers), then match rules. "Command" rules compare the program and required arguments (short flags
//! letter by letter, `-rf` = `-r` + `-f`; arguments may use `*` / `?`); "regex" rules match the whole line. A
//! guard against mistakes, not a security boundary: scripts, aliases and editors can still run anything.

use regex::{Regex, RegexBuilder};

/// 一行最多看這麼多字元（再長就截斷）。/ Characters of a line that are looked at.
pub const MAX_LINE: usize = 8192;
/// 包裝最多看穿幾層。/ How many wrappers deep we look.
const MAX_DEPTH: usize = 6;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    /// 直接擋下。/ Refused outright.
    Block,
    /// 等 owner / ADMIN 核准。/ Held until the owner or an ADMIN approves.
    Approve,
}

impl Action {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "block" => Some(Self::Block),
            "approve" => Some(Self::Approve),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Block => "block",
            Self::Approve => "approve",
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

/// 規則管誰：所有人，或只管不能核准的人（ADMIN 以下的 sharee）。/ Who a rule applies to.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Who {
    Everyone,
    Sharees,
}

impl Who {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "everyone" => Some(Self::Everyone),
            "sharees" => Some(Self::Sharees),
            _ => None,
        }
    }
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Everyone => "everyone",
            Self::Sharees => "sharees",
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
    /// None = 全站規則。/ None = a site-wide rule.
    pub tunnel_id: Option<i64>,
    pub action: Action,
    pub who: Who,
    pub via: Via,
    pub pattern: String,
    pub kind: Kind,
    pub note: String,
    pub matcher: Matcher,
}

impl Rule {
    fn applies(&self, approver: bool, source: Source) -> bool {
        let who = match self.who {
            Who::Everyone => true,
            Who::Sharees => !approver,
        };
        let via = matches!((self.via, source), (Via::All, _) | (Via::Terminal, Source::Terminal) | (Via::Agents, Source::Agent));
        who && via
    }
}

/// 一行（或好幾個候選行）的結果：擋下優先於要核准；都不符合 = None。
/// The verdict for a line (or several candidate readings of it): block wins over approve; None = allowed.
pub fn evaluate<'a>(rules: &'a [Rule], lines: &[String], approver: bool, source: Source) -> Option<&'a Rule> {
    let parsed: Vec<(&str, Vec<SimpleCommand>)> = lines
        .iter()
        .map(|l| truncate(l))
        .filter(|l| !l.trim().is_empty())
        .map(|l| (l, commands(l)))
        .collect();
    if parsed.is_empty() {
        return None;
    }
    let hit = |action: Action| {
        rules
            .iter()
            .filter(|r| r.action == action && r.applies(approver, source))
            .find(|r| parsed.iter().any(|(line, cmds)| r.matcher.matches(line, cmds)))
    };
    hit(Action::Block).or_else(|| hit(Action::Approve))
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
enum Ctx {
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
    let mut stack: Vec<(Ctx, bool)> = Vec::new();
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
                    stack.push((Ctx::Paren, true));
                    in_double = false;
                    i += 1;
                }
                '`' => {
                    brk!();
                    stack.push((Ctx::Backtick, true));
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
                stack.push((Ctx::Paren, false));
                i += 1;
            }
            '(' => {
                brk!();
                stack.push((Ctx::Paren, false));
            }
            ')' => {
                brk!();
                if let Some(pos) = stack.iter().rposition(|(k, _)| *k == Ctx::Paren) {
                    let (_, dq) = stack[pos];
                    stack.truncate(pos);
                    in_double = dq;
                }
            }
            '`' => {
                brk!();
                match stack.last() {
                    Some((Ctx::Backtick, dq)) => {
                        in_double = *dq;
                        stack.pop();
                    }
                    _ => stack.push((Ctx::Backtick, false)),
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
            tunnel_id: None,
            action,
            who: Who::Everyone,
            via: Via::All,
            pattern: pattern.into(),
            kind,
            note: String::new(),
            matcher: Matcher::new(kind, pattern).unwrap(),
        }
    }

    fn hits(pattern: &str, line: &str) -> bool {
        let r = [rule(Action::Block, Kind::Command, pattern)];
        evaluate(&r, &[line.to_string()], false, Source::Terminal).is_some()
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
        assert!(evaluate(&r, &["curl -fsSL https://x.sh | sh".into()], false, Source::Terminal).is_some());
        assert!(evaluate(&r, &["curl -fsSL https://x.sh -o x".into()], false, Source::Terminal).is_none());
    }

    #[test]
    fn block_wins_and_who_and_scope_are_honoured() {
        let mut approve = rule(Action::Approve, Kind::Command, "sudo");
        approve.id = 1;
        let mut block = rule(Action::Block, Kind::Command, "reboot");
        block.id = 2;
        let rules = [approve.clone(), block.clone()];
        let line = |s: &str| vec![s.to_string()];
        assert_eq!(evaluate(&rules, &line("sudo reboot"), false, Source::Terminal).map(|r| r.id), Some(2));
        assert_eq!(evaluate(&rules, &line("sudo ls"), false, Source::Terminal).map(|r| r.id), Some(1));
        assert!(evaluate(&rules, &line("ls"), false, Source::Terminal).is_none());
        assert!(evaluate(&rules, &line("   "), false, Source::Terminal).is_none());

        let mut sharees = approve.clone();
        sharees.who = Who::Sharees;
        assert!(evaluate(std::slice::from_ref(&sharees), &line("sudo ls"), true, Source::Terminal).is_none());
        assert!(evaluate(std::slice::from_ref(&sharees), &line("sudo ls"), false, Source::Terminal).is_some());

        let mut agents = approve;
        agents.via = Via::Agents;
        assert!(evaluate(std::slice::from_ref(&agents), &line("sudo ls"), false, Source::Terminal).is_none());
        assert!(evaluate(std::slice::from_ref(&agents), &line("sudo ls"), true, Source::Agent).is_some());
    }

    #[test]
    fn any_candidate_line_can_match() {
        let r = [rule(Action::Block, Kind::Command, "reboot")];
        let lines = vec!["nat@box:~$ reboot".to_string(), "reboot".to_string()];
        assert!(evaluate(&r, &lines, false, Source::Terminal).is_some());
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
