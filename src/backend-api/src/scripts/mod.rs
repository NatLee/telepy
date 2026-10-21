//! 連線腳本與 ssh config 的模板渲染。模板檔原封不動搬自 Django（templates/），置換語意沿用
//! Python `string.Template.safe_substitute`（`$name` / `${name}`；未知名稱原樣保留；`$$` → `$`）。
//! Script/config rendering with Python `string.Template.safe_substitute` semantics.

use std::collections::HashMap;

use once_cell::sync::Lazy;
use regex::Regex;

pub const SSH: &str = include_str!("../../templates/ssh_template.sh");
pub const AUTOSSH: &str = include_str!("../../templates/autossh_template.sh");
pub const AUTOSSH_SERVICE: &str = include_str!("../../templates/autossh_service_template.sh");
pub const POWERSHELL: &str = include_str!("../../templates/powershell_template.ps1");
pub const DOCKER_RUN: &str = include_str!("../../templates/docker_run_template.sh");
pub const DOCKER_COMPOSE: &str = include_str!("../../templates/docker_compose_template.yml");
pub const SSH_CONFIG: &str = include_str!("../../templates/ssh_config_template.conf");

pub const ALLOWED_SCRIPT_TYPES: &[&str] = &["ssh", "powershell", "autossh", "autossh-service", "docker-run", "docker-compose"];

static TEMPLATE_RE: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)\$(?:(?P<escaped>\$)|(?P<named>[_a-z][_a-z0-9]*)|\{(?P<braced>[_a-z][_a-z0-9]*)\}|(?P<invalid>))").unwrap()
});

/// `string.Template(text).safe_substitute(mapping)`
pub fn safe_substitute(text: &str, mapping: &HashMap<&str, String>) -> String {
    TEMPLATE_RE
        .replace_all(text, |caps: &regex::Captures| {
            if caps.name("escaped").is_some() {
                return "$".to_string();
            }
            let name = caps.name("named").or_else(|| caps.name("braced")).map(|m| m.as_str());
            match name.and_then(|n| mapping.get(n)) {
                Some(v) => v.clone(),
                None => caps[0].to_string(),
            }
        })
        .into_owned()
}

#[derive(Debug, Clone)]
pub struct ScriptContext<'a> {
    pub server_domain: &'a str,
    pub reverse_port: i64,
    pub ssh_port: i64,
    /// Django 的 settings.REVERSE_SERVER_SSH_PORT 是 env 原字串。
    pub reverse_server_ssh_port: &'a str,
    pub username: &'a str,
    pub key_path: Option<&'a str>,
    /// docker 模板用：第一把 service key。/ For the docker templates.
    pub telepy_public_key: Option<&'a str>,
}

fn base_mapping(ctx: &ScriptContext) -> HashMap<&'static str, String> {
    let mut m = HashMap::new();
    m.insert("username", ctx.username.to_string());
    m.insert("server_domain", ctx.server_domain.to_string());
    m.insert("reverse_port", ctx.reverse_port.to_string());
    m.insert("ssh_port", ctx.ssh_port.to_string());
    m.insert("reverse_server_ssh_port", ctx.reverse_server_ssh_port.to_string());
    m
}

/// `ssh_tunnel_script_factory(tunnel_type, ...).render()`；回 (script, language)。
pub fn render_script(tunnel_type: &str, ctx: &ScriptContext) -> Result<(String, &'static str), String> {
    let mut m = base_mapping(ctx);
    match tunnel_type.to_ascii_lowercase().as_str() {
        "ssh" | "autossh" => {
            m.insert("key_option", ctx.key_path.map(|k| format!(" \\\n-i {k} ")).unwrap_or_else(|| " ".into()));
            let tpl = if tunnel_type.eq_ignore_ascii_case("ssh") { SSH } else { AUTOSSH };
            Ok((safe_substitute(tpl, &m), "bash"))
        }
        "autossh-service" => {
            m.insert("key_option", ctx.key_path.map(|k| format!("-i {k} ")).unwrap_or_default());
            Ok((safe_substitute(AUTOSSH_SERVICE, &m), "bash"))
        }
        "powershell" => {
            m.insert("key_option", ctx.key_path.map(|k| format!("-i '{k}' ")).unwrap_or_default());
            Ok((safe_substitute(POWERSHELL, &m), "powershell"))
        }
        "docker-run" | "docker-compose" => {
            let compose = tunnel_type.eq_ignore_ascii_case("docker-compose");
            if let Some(k) = ctx.key_path {
                m.insert("key_mount", format!("  -v {k}:/root/.ssh/id_rsa:ro"));
                m.insert("key_option", "  -i /root/.ssh/id_rsa".into());
            } else {
                m.insert("key_mount", String::new());
                m.insert("key_option", String::new());
            }
            m.insert("docker_type", if compose { "compose".into() } else { "run".into() });
            m.insert(
                "telepy_public_key",
                ctx.telepy_public_key.map(str::to_string).unwrap_or_else(|| "# Telepy public key not found".into()),
            );
            let tpl = if compose { DOCKER_COMPOSE } else { DOCKER_RUN };
            Ok((safe_substitute(tpl, &m), if compose { "yaml" } else { "bash" }))
        }
        other => Err(format!("Invalid tunnel type {other}.")),
    }
}

static HOST_ALIAS_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"[^A-Za-z0-9._-]+").unwrap());

/// `_sanitize_ssh_host_alias`
pub fn sanitize_host_alias(value: &str) -> String {
    let v = HOST_ALIAS_RE.replace_all(value.trim(), "-");
    let v = v.trim_matches('-');
    if v.is_empty() {
        "telepy-endpoint".to_string()
    } else {
        v.to_string()
    }
}

fn ensure_newline(mut s: String) -> String {
    if !s.is_empty() && !s.ends_with('\n') {
        s.push('\n');
    }
    s
}

/// `SshClientTemplate`：裝置端 `~/.ssh/config` 的 Host 區塊（經 telepy-ssh-server 跳板）。
pub fn render_client_config(host_friendly_name: &str, ssh_username: &str, reverse_port: i64) -> String {
    let mut m: HashMap<&str, String> = HashMap::new();
    m.insert("username", "root".into());
    m.insert("server_domain", "localhost".into());
    m.insert("reverse_port", reverse_port.to_string());
    m.insert("ssh_port", "-1".into());
    m.insert("reverse_server_ssh_port", String::new());
    m.insert("ssh_username", ssh_username.into());
    m.insert("host_friendly_name", sanitize_host_alias(host_friendly_name));
    m.insert("client_proxy_command", "ProxyCommand ssh -W %h:%p telepy-ssh-server".into());
    ensure_newline(safe_substitute(SSH_CONFIG, &m))
}

/// `SshServerTemplate`：`Host telepy-ssh-server` 區塊。
pub fn render_server_config(server_domain: &str, reverse_server_ssh_port: &str) -> String {
    let mut m: HashMap<&str, String> = HashMap::new();
    m.insert("username", "root".into());
    m.insert("server_domain", server_domain.into());
    m.insert("reverse_port", String::new());
    m.insert("ssh_port", "-1".into());
    m.insert("reverse_server_ssh_port", reverse_server_ssh_port.into());
    m.insert("ssh_username", "telepy".into());
    m.insert("host_friendly_name", "telepy-ssh-server".into());
    m.insert("client_proxy_command", String::new());
    ensure_newline(safe_substitute(SSH_CONFIG, &m))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn substitute_semantics() {
        let mut m = HashMap::new();
        m.insert("a", "1".to_string());
        assert_eq!(safe_substitute("$a ${a} $b ${b} $$ $(x) $_", &m), "1 1 $b ${b} $ $(x) $_");
    }

    #[test]
    fn ssh_script_with_and_without_key() {
        let ctx = ScriptContext {
            server_domain: "telepy.test",
            reverse_port: 12345,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "root",
            key_path: None,
            telepy_public_key: None,
        };
        let (s, lang) = render_script("ssh", &ctx).unwrap();
        assert_eq!(lang, "bash");
        assert!(s.contains("ssh  \\\n-o \"ServerAliveInterval 30\""), "{s}");
        assert!(s.contains("-NR '*:12345:localhost:22'"));
        assert!(s.contains("telepy@telepy.test"));
        let ctx2 = ScriptContext { key_path: Some("~/.ssh/id_rsa"), ..ctx.clone() };
        let (s, _) = render_script("autossh", &ctx2).unwrap();
        assert!(s.contains("-i ~/.ssh/id_rsa"));
        let (s, lang) = render_script("powershell", &ctx2).unwrap();
        assert_eq!(lang, "powershell");
        assert!(s.contains("-i '~/.ssh/id_rsa' -o ServerAliveInterval=15"));
        assert!(s.contains("$Host.UI.RawUI.ReadKey"), "unknown $identifiers must survive");
        let (s, lang) = render_script("docker-compose", &ctx2).unwrap();
        assert_eq!(lang, "yaml");
        assert!(s.contains("  -v ~/.ssh/id_rsa:/root/.ssh/id_rsa:ro"));
        assert!(s.contains("# Telepy public key not found"));
        assert!(render_script("nope", &ctx).is_err());
    }

    #[test]
    fn ssh_config_blocks() {
        let server = render_server_config("telepy.test", "24242");
        assert!(server.starts_with("Host telepy-ssh-server\n"));
        assert!(server.contains("Port  24242\n"));
        assert!(server.contains("User telepy\n"));
        assert!(server.ends_with('\n'));
        let client = render_client_config("My Box!", "ubuntu", 12345);
        assert!(client.starts_with("Host My-Box\n"), "{client}");
        assert!(client.contains("HostName localhost"));
        assert!(client.contains("Port 12345 \n"));
        assert!(client.contains("ProxyCommand ssh -W %h:%p telepy-ssh-server"));
        assert_eq!(sanitize_host_alias("   "), "telepy-endpoint");
    }
}
