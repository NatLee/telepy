//! 工具箱片段的變數代換（跟網頁 `lib/snippets.ts` 一樣：`$name` / `${name}`，不認得的照留，`$$` 也照留——在 shell
//! 裡是 PID）。純函式。/ Snippet variable substitution, as on the web: unknown names and `$$` survive. Pure.
use std::collections::HashMap;

pub fn substitute(command: &str, vars: &HashMap<String, String>) -> String {
    let chars: Vec<char> = command.chars().collect();
    let mut out = String::new();
    let mut i = 0;
    let ident_start = |c: char| c.is_ascii_alphabetic() || c == '_';
    let ident = |c: char| c.is_ascii_alphanumeric() || c == '_';
    while i < chars.len() {
        let c = chars[i];
        if c != '$' || i + 1 >= chars.len() {
            out.push(c);
            i += 1;
            continue;
        }
        let next = chars[i + 1];
        if next == '$' {
            out.push_str("$$");
            i += 2;
        } else if next == '{' {
            let end = chars[i + 2..].iter().position(|c| *c == '}').map(|p| p + i + 2);
            match end {
                Some(e) if e > i + 2 && ident_start(chars[i + 2]) && chars[i + 2..e].iter().all(|c| ident(*c)) => {
                    let name: String = chars[i + 2..e].iter().collect();
                    match vars.get(&name) {
                        Some(v) => out.push_str(v),
                        None => out.extend(&chars[i..=e]),
                    }
                    i = e + 1;
                }
                _ => {
                    out.push(c);
                    i += 1;
                }
            }
        } else if ident_start(next) {
            let mut e = i + 1;
            while e < chars.len() && ident(chars[e]) {
                e += 1;
            }
            let name: String = chars[i + 1..e].iter().collect();
            match vars.get(&name) {
                Some(v) => out.push_str(v),
                None => out.extend(&chars[i..e]),
            }
            i = e;
        } else {
            out.push(c);
            i += 1;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_substitute_semantics() {
        let vars: HashMap<String, String> = [("svc".to_string(), "nginx".to_string()), ("n".to_string(), "20".to_string())].into();
        assert_eq!(substitute("journalctl -u $svc -n ${n} --no-pager", &vars), "journalctl -u nginx -n 20 --no-pager");
        assert_eq!(substitute("echo $HOME $$ ${unknown} $", &vars), "echo $HOME $$ ${unknown} $");
        assert_eq!(substitute("a${svc}b$svc.x", &vars), "anginxbnginx.x");
    }
}
