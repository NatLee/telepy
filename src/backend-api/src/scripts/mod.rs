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
    pub host_friendly_name: &'a str,
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
    m.insert("host_friendly_name", ctx.host_friendly_name.to_string());
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
            // 容器版（jnovack/autossh）：金鑰掛到 /id_rsa、用環境變數設定；沒給 key_path 就用預設的 ~/.ssh/id_rsa
            //（compose 會展開 ~，shell 版用 $HOME 讓 bash 展開）。容器透過 host.docker.internal 連本機 sshd。
            // Container flavour (jnovack/autossh): key mounted at /id_rsa, env-driven; key_path defaults to
            // ~/.ssh/id_rsa (compose expands ~, the shell flavour uses $HOME). The container reaches the host's
            // sshd via host.docker.internal.
            let compose = tunnel_type.eq_ignore_ascii_case("docker-compose");
            let default_key = if compose { "~/.ssh/id_rsa" } else { "$HOME/.ssh/id_rsa" };
            m.insert("key_path", ctx.key_path.unwrap_or(default_key).to_string());
            m.insert(
                "telepy_public_key",
                match ctx.telepy_public_key {
                    Some(k) => k.to_string(),
                    None if compose => "<Telepy service key not found - add one on the Keys page>".to_string(),
                    None => String::new(),
                },
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
            host_friendly_name: "My Box",
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
        assert!(render_script("nope", &ctx).is_err());
    }

    #[test]
    fn docker_scripts_use_a_real_image_and_reach_the_host() {
        let ctx = ScriptContext {
            host_friendly_name: "My Box",
            server_domain: "telepy.test",
            reverse_port: 12345,
            ssh_port: 22,
            reverse_server_ssh_port: "24242",
            username: "root",
            key_path: None,
            telepy_public_key: Some("ssh-ed25519 AAAAtest web-service"),
        };
        let (s, lang) = render_script("docker-compose", &ctx).unwrap();
        assert_eq!(lang, "yaml");
        assert!(s.contains("image: jnovack/autossh:latest"), "{s}");
        assert!(s.contains("- \"~/.ssh/id_rsa:/id_rsa:ro\""), "default key path: {s}");
        assert!(s.contains("- \"host.docker.internal:host-gateway\""));
        assert!(s.contains("SSH_TARGET_HOST: host.docker.internal"));
        assert!(s.contains("SSH_TUNNEL_PORT: \"12345\"") && s.contains("SSH_TARGET_PORT: \"22\"") && s.contains("SSH_REMOTE_PORT: \"24242\""));
        assert!(s.contains("SSH_REMOTE_HOST: \"telepy.test\"") && s.contains("SSH_REMOTE_USER: telepy"));
        assert!(s.contains("grep -qxF 'ssh-ed25519 AAAAtest web-service' ~/.ssh/authorized_keys"), "append, never overwrite: {s}");
        assert!(s.contains("docker compose -f telepy-docker-compose.yml up -d"));
        assert!(!s.contains("ports:"), "the reverse port is bound on the Telepy server, not on the device");
        assert!(!s.contains("${"), "every placeholder must be substituted (compose would try to expand it): {s}");
        assert!(s.contains("\"My Box\""));

        let (s, lang) = render_script("docker-run", &ScriptContext { key_path: Some("/keys/dev.pem"), ..ctx.clone() }).unwrap();
        assert_eq!(lang, "bash");
        assert!(s.contains("KEY_FILE=/keys/dev.pem\n"), "{s}");
        assert!(s.contains("-v \"$KEY_FILE\":/id_rsa:ro"));
        assert!(s.contains("--add-host host.docker.internal:host-gateway"));
        assert!(s.contains("-e SSH_TUNNEL_PORT=12345") && s.contains("-e SSH_TARGET_PORT=22") && s.contains("-e SSH_REMOTE_HOST=telepy.test"));
        assert!(s.contains("TELEPY_KEY='ssh-ed25519 AAAAtest web-service'"));
        assert!(s.contains(">> ~/.ssh/authorized_keys") && !s.contains(" > ~/.ssh/authorized_keys"), "append only: {s}");
        assert!(s.contains("jnovack/autossh:latest"));
        let (s, _) = render_script("docker-run", &ctx).unwrap();
        assert!(s.contains("KEY_FILE=$HOME/.ssh/id_rsa\n"), "{s}");
        let (s, _) = render_script("docker-run", &ScriptContext { telepy_public_key: None, ..ctx.clone() }).unwrap();
        assert!(s.contains("TELEPY_KEY=''"), "no service key → nothing appended: {s}");
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
