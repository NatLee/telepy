//! 啟動時補齊缺少的 SSH 金鑰：gateway 的主機金鑰（ed25519 + rsa，`GATEWAY_HOST_KEYS_DIR`）與後端登入裝置的服務金鑰
//! （`SSH_IDENTITY`，compose 設成 `/root/.ssh/id_rsa`）。已經存在的一律不動：裝置釘選了主機金鑰、也信任服務金鑰，換新的
//! 會把每一台裝置擋在外面；只缺 `.pub` 時從私鑰重算。有 `ssh-keygen`（後端映像裝了 openssh-client）就用它，產出跟以前
//! `telepy.sh keygen` 一模一樣的檔案；沒有就用 russh 自己產 ed25519。服務金鑰只在 `SSH_IDENTITY` 有設時才碰：本機開發的
//! `~/.ssh/id_rsa` 是開發者自己的檔案，不能替他產。`telepy-server keygen` 跑同一件事並印出結果。
//!
//! Missing SSH keys are created at start: the gateway's host keys (ed25519 + rsa in `GATEWAY_HOST_KEYS_DIR`) and the
//! service key the backend logs in to devices with (`SSH_IDENTITY`, `/root/.ssh/id_rsa` in compose). Existing keys are
//! never touched (devices pin the host keys and trust the service key); a missing `.pub` is recomputed from the private
//! key. `ssh-keygen` is preferred (the image ships openssh-client) and writes the same files the old wrapper did; without
//! it russh generates ed25519 keys. The service key is only created when `SSH_IDENTITY` is set explicitly: a developer's
//! own `~/.ssh/id_rsa` is not Telepy's to create. `telepy-server keygen` runs the same step and prints what happened.

use std::path::{Path, PathBuf};
use std::process::Command;

use russh::keys::ssh_key::LineEnding;
use russh::keys::{load_secret_key, Algorithm, PrivateKey};

use crate::config::Config;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Ed25519,
    Rsa,
}

impl Kind {
    pub fn as_str(self) -> &'static str {
        match self {
            Kind::Ed25519 => "ed25519",
            Kind::Rsa => "rsa",
        }
    }
    fn ssh_keygen_args(self) -> &'static [&'static str] {
        match self {
            Kind::Ed25519 => &["-t", "ed25519"],
            Kind::Rsa => &["-t", "rsa", "-b", "3072"],
        }
    }
}

/// 一把該存在的金鑰。/ One key that ought to exist.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Spec {
    pub path: PathBuf,
    pub kind: Kind,
    pub comment: &'static str,
    /// 給人看的名稱（`gateway host key` / `service key`）。/ What it is, for messages.
    pub what: &'static str,
}

impl Spec {
    pub fn public_path(&self) -> PathBuf {
        let mut s = self.path.as_os_str().to_owned();
        s.push(".pub");
        PathBuf::from(s)
    }
}

/// 這個設定下該有哪些金鑰。`service_key_configured` = `SSH_IDENTITY` 有設（compose 都設）。
/// The keys this configuration calls for. `service_key_configured` = `SSH_IDENTITY` is set (compose always sets it).
pub fn specs(config: &Config, service_key_configured: bool) -> Vec<Spec> {
    let mut out = Vec::new();
    if let Some(dir) = &config.gateway_host_keys_dir {
        out.push(Spec { path: dir.join("ssh_host_ed25519_key"), kind: Kind::Ed25519, comment: "root@telepy-ssh", what: "gateway host key" });
        out.push(Spec { path: dir.join("ssh_host_rsa_key"), kind: Kind::Rsa, comment: "root@telepy-ssh", what: "gateway host key" });
    }
    if service_key_configured {
        out.push(Spec { path: config.ssh_identity.clone(), kind: Kind::Rsa, comment: "root@telepy-web", what: "service key" });
    }
    out
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Action {
    Keep,
    RestorePub,
    Create,
}

/// 純函式：私鑰在 → 留著（只缺 .pub 就重算）；不在 → 產新的。/ Pure: keep an existing private key, create a missing one.
pub fn action(private_exists: bool, public_exists: bool) -> Action {
    match (private_exists, public_exists) {
        (true, true) => Action::Keep,
        (true, false) => Action::RestorePub,
        (false, _) => Action::Create,
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Tool {
    SshKeygen,
    Builtin,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Outcome {
    Kept(Spec),
    Created(Spec, Tool, Kind),
    RestoredPub(Spec),
    Failed(Spec, String),
}

pub fn ensure(config: &Config, service_key_configured: bool) -> Vec<Outcome> {
    ensure_specs(&specs(config, service_key_configured))
}

pub fn ensure_specs(specs: &[Spec]) -> Vec<Outcome> {
    specs.iter().map(|s| ensure_one(s, have_ssh_keygen())).collect()
}

fn have_ssh_keygen() -> bool {
    Command::new("ssh-keygen").arg("-?").output().is_ok()
}

fn ensure_one(spec: &Spec, ssh_keygen: bool) -> Outcome {
    let public = spec.public_path();
    match action(spec.path.exists(), public.exists()) {
        Action::Keep => Outcome::Kept(spec.clone()),
        Action::RestorePub => match restore_pub(spec, &public, ssh_keygen) {
            Ok(()) => Outcome::RestoredPub(spec.clone()),
            Err(e) => Outcome::Failed(spec.clone(), e),
        },
        Action::Create => match create(spec, &public, ssh_keygen) {
            Ok((tool, kind)) => Outcome::Created(spec.clone(), tool, kind),
            Err(e) => Outcome::Failed(spec.clone(), e),
        },
    }
}

fn create(spec: &Spec, public: &Path, ssh_keygen: bool) -> Result<(Tool, Kind), String> {
    if let Some(dir) = spec.path.parent() {
        std::fs::create_dir_all(dir).map_err(|e| format!("cannot create {}: {e}", dir.display()))?;
    }
    if ssh_keygen {
        let out = Command::new("ssh-keygen")
            .arg("-q")
            .args(spec.kind.ssh_keygen_args())
            .args(["-N", "", "-C", spec.comment, "-f"])
            .arg(&spec.path)
            .output()
            .map_err(|e| format!("cannot run ssh-keygen: {e}"))?;
        if !out.status.success() {
            return Err(format!("ssh-keygen failed: {}", String::from_utf8_lossy(&out.stderr).trim()));
        }
        return Ok((Tool::SshKeygen, spec.kind));
    }
    // 沒有 ssh-keygen：russh 只方便產 ed25519，兩種用途都夠（OpenSSH 6.5+ / Dropbear 2013+ 都認）。
    // Without ssh-keygen: russh makes ed25519 keys, enough for both uses (OpenSSH 6.5+ and Dropbear 2013+ accept them).
    let key = PrivateKey::random(&mut rand10::rng(), Algorithm::Ed25519).map_err(|e| format!("generate key: {e}"))?;
    let pem = key.to_openssh(LineEnding::LF).map_err(|e| format!("serialise key: {e}"))?;
    write_private(&spec.path, pem.as_bytes())?;
    write_public(public, &key, spec.comment)?;
    Ok((Tool::Builtin, Kind::Ed25519))
}

fn restore_pub(spec: &Spec, public: &Path, ssh_keygen: bool) -> Result<(), String> {
    if ssh_keygen {
        let out = Command::new("ssh-keygen").args(["-y", "-f"]).arg(&spec.path).output().map_err(|e| format!("cannot run ssh-keygen: {e}"))?;
        if out.status.success() {
            let line = String::from_utf8_lossy(&out.stdout).trim().to_string();
            return std::fs::write(public, format!("{line} {}\n", spec.comment)).map_err(|e| format!("cannot write {}: {e}", public.display()));
        }
    }
    let key = load_secret_key(&spec.path, None).map_err(|e| format!("cannot read {}: {e}", spec.path.display()))?;
    write_public(public, &key, spec.comment)
}

fn write_private(path: &Path, pem: &[u8]) -> Result<(), String> {
    std::fs::write(path, pem).map_err(|e| format!("cannot write {}: {e}", path.display()))?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(|e| format!("cannot chmod {}: {e}", path.display()))?;
    }
    Ok(())
}

fn write_public(path: &Path, key: &PrivateKey, comment: &str) -> Result<(), String> {
    let line = key.public_key().to_openssh().map_err(|e| format!("serialise public key: {e}"))?;
    std::fs::write(path, format!("{} {comment}\n", line.trim())).map_err(|e| format!("cannot write {}: {e}", path.display()))
}

/// 有沒有一把失敗。/ Whether any key could not be made.
pub fn failed(outcomes: &[Outcome]) -> bool {
    outcomes.iter().any(|o| matches!(o, Outcome::Failed(..)))
}

/// `telepy-server keygen` 的輸出。/ The subcommand's report.
pub fn render(outcomes: &[Outcome]) -> String {
    let mut s = String::new();
    if outcomes.is_empty() {
        s.push_str("nothing to do: GATEWAY_HOST_KEYS_DIR and SSH_IDENTITY are not set\n");
    }
    for o in outcomes {
        s.push_str(&line(o));
        s.push('\n');
    }
    s
}

/// 一行一把（log 與輸出共用）。/ One line per key, shared by the log and the report.
pub fn line(o: &Outcome) -> String {
    match o {
        Outcome::Kept(s) => format!("kept {} ({})", s.path.display(), s.what),
        Outcome::Created(s, tool, kind) => format!(
            "created {} ({}, {}, {})",
            s.path.display(),
            s.what,
            kind.as_str(),
            match tool {
                Tool::SshKeygen => "ssh-keygen",
                Tool::Builtin => "built in",
            }
        ),
        Outcome::RestoredPub(s) => format!("restored {} from the private key ({})", s.public_path().display(), s.what),
        Outcome::Failed(s, e) => format!("failed {} ({}): {e}", s.path.display(), s.what),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn existing_keys_are_kept_and_a_missing_pub_is_restored() {
        assert_eq!(action(true, true), Action::Keep);
        assert_eq!(action(true, false), Action::RestorePub);
        assert_eq!(action(false, false), Action::Create);
        assert_eq!(action(false, true), Action::Create);
    }

    fn spec(dir: &Path, name: &str, kind: Kind) -> Spec {
        Spec { path: dir.join(name), kind, comment: "test@telepy", what: "gateway host key" }
    }

    #[test]
    fn the_built_in_generator_writes_a_loadable_key_pair_and_keeps_it_afterwards() {
        let dir = tempfile::tempdir().unwrap();
        let s = spec(dir.path(), "ssh_host_ed25519_key", Kind::Ed25519);
        let o = ensure_one(&s, false);
        assert!(matches!(o, Outcome::Created(_, Tool::Builtin, Kind::Ed25519)), "{o:?}");
        let key = load_secret_key(&s.path, None).unwrap();
        let public = std::fs::read_to_string(s.public_path()).unwrap();
        assert!(public.starts_with("ssh-ed25519 AAAA") && public.trim_end().ends_with(" test@telepy"), "{public}");
        assert_eq!(key.public_key().to_openssh().unwrap(), public.split_whitespace().take(2).collect::<Vec<_>>().join(" "));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(&s.path).unwrap().permissions().mode() & 0o777, 0o600);
        }
        // 再跑一次：原封不動。/ Again: untouched.
        let before = std::fs::read(&s.path).unwrap();
        assert!(matches!(ensure_one(&s, false), Outcome::Kept(_)));
        assert_eq!(std::fs::read(&s.path).unwrap(), before);
        // 刪掉 .pub：從私鑰重算。/ Remove the .pub: recomputed from the private key.
        std::fs::remove_file(s.public_path()).unwrap();
        assert!(matches!(ensure_one(&s, false), Outcome::RestoredPub(_)));
        assert_eq!(std::fs::read_to_string(s.public_path()).unwrap(), public);
    }

    #[test]
    fn ssh_keygen_writes_the_same_files_the_wrapper_did() {
        if !have_ssh_keygen() {
            eprintln!("skipping: no ssh-keygen");
            return;
        }
        let dir = tempfile::tempdir().unwrap();
        let nested = dir.path().join("ssh_host_keys");
        let ed = spec(&nested, "ssh_host_ed25519_key", Kind::Ed25519);
        let rsa = Spec { path: nested.join("id_rsa"), kind: Kind::Rsa, comment: "root@telepy-web", what: "service key" };
        let out = ensure_specs(&[ed.clone(), rsa.clone()]);
        assert!(out.iter().all(|o| matches!(o, Outcome::Created(_, Tool::SshKeygen, _))), "{out:?}");
        assert!(load_secret_key(&ed.path, None).is_ok() && load_secret_key(&rsa.path, None).is_ok());
        let rsa_pub = std::fs::read_to_string(rsa.public_path()).unwrap();
        assert!(rsa_pub.starts_with("ssh-rsa AAAA") && rsa_pub.contains("root@telepy-web"), "{rsa_pub}");
        std::fs::remove_file(ed.public_path()).unwrap();
        assert!(matches!(ensure_one(&ed, true), Outcome::RestoredPub(_)));
        assert!(std::fs::read_to_string(ed.public_path()).unwrap().starts_with("ssh-ed25519 AAAA"));
        assert!(!failed(&out));
        assert!(render(&out).lines().all(|l| l.starts_with("created ")));
    }

    #[test]
    fn an_unwritable_place_is_reported_not_fatal() {
        let dir = tempfile::tempdir().unwrap();
        let file = dir.path().join("a-file");
        std::fs::write(&file, "x").unwrap();
        // 父路徑是檔案，create_dir_all 一定失敗。/ The parent is a file, so the directory cannot be made.
        let s = spec(&file, "ssh_host_ed25519_key", Kind::Ed25519);
        let o = ensure_one(&s, false);
        assert!(matches!(o, Outcome::Failed(..)), "{o:?}");
        assert!(failed(&[o.clone()]) && line(&o).starts_with("failed "));
    }
}
