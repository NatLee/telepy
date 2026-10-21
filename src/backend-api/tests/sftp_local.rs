//! SFTP 層測試：直接對本機 OpenSSH 的 `sftp-server` 講協定（stdin/stdout），不經 SSH。
//! 沒有 sftp-server 的環境（CI 容器）會跳過。
use std::process::Stdio;

use tokio::io::AsyncWriteExt;
use tokio::process::Command;

use telepy_server::sftp;

const CANDIDATES: [&str; 3] = ["/usr/libexec/sftp-server", "/usr/lib/openssh/sftp-server", "/usr/lib/ssh/sftp-server"];

fn sftp_server_bin() -> Option<&'static str> {
    CANDIDATES.iter().copied().find(|p| std::path::Path::new(p).exists())
}

#[tokio::test]
async fn list_zip_and_upload_against_local_sftp_server() {
    let Some(bin) = sftp_server_bin() else {
        eprintln!("skipping: no sftp-server binary");
        return;
    };
    let dir = tempfile::tempdir().unwrap();
    std::fs::create_dir_all(dir.path().join("docs/nested")).unwrap();
    std::fs::write(dir.path().join("docs/a.txt"), b"hello world").unwrap();
    std::fs::write(dir.path().join("docs/nested/b.bin"), vec![7u8; 5000]).unwrap();
    std::fs::write(dir.path().join("top.txt"), b"x").unwrap();

    let mut child = Command::new(bin)
        .current_dir(dir.path())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .kill_on_drop(true)
        .spawn()
        .unwrap();
    let stdin = child.stdin.take().unwrap();
    let stdout = child.stdout.take().unwrap();
    let stream = tokio::io::join(stdout, stdin);
    let session = russh_sftp::client::SftpSession::new(stream).await.unwrap();

    // home = cwd of the server; unix
    let home = sftp::home(&session).await;
    assert!(home.ends_with(dir.path().file_name().unwrap().to_str().unwrap()), "{home}");
    assert_eq!(sftp::detect_shell(&session).await, "unix");

    // list
    let entries = sftp::list_dir(&session, &sftp::resolve_path("~/", &home)).await.unwrap();
    let names: Vec<&str> = entries.iter().map(|e| e.name.as_str()).collect();
    assert_eq!(names, vec!["docs", "top.txt"]);
    assert!(entries[0].is_dir);
    assert_eq!(entries[1].size, 1);
    let ws = sftp::ws_entry_json(&entries[1]);
    assert_eq!(ws["size"], "1.0 B");
    let rest = sftp::rest_entry_json(&entries[0], 480);
    assert_eq!(rest["type"], "directory");
    assert!(rest["permissions"]["string"].as_str().unwrap().starts_with('d'));

    // zip a directory
    let tmp = sftp::zip_directory(&session, &format!("{home}/docs")).await.unwrap();
    let f = std::fs::File::open(tmp.path()).unwrap();
    let mut archive = zip::ZipArchive::new(f).unwrap();
    let mut names: Vec<String> = (0..archive.len()).map(|i| archive.by_index(i).unwrap().name().to_string()).collect();
    names.sort();
    assert_eq!(names, vec!["docs/", "docs/a.txt", "docs/nested/", "docs/nested/b.bin"]);
    let mut a = archive.by_name("docs/a.txt").unwrap();
    let mut s = String::new();
    std::io::Read::read_to_string(&mut a, &mut s).unwrap();
    assert_eq!(s, "hello world");

    // upload into a directory and as an explicit file path
    let target = sftp::upload_target(&session, &format!("{home}/docs"), "up.txt").await;
    assert_eq!(target, format!("{home}/docs/up.txt"));
    let mut file = session.create(&target).await.unwrap();
    file.write_all(b"uploaded").await.unwrap();
    file.shutdown().await.unwrap();
    assert_eq!(std::fs::read_to_string(dir.path().join("docs/up.txt")).unwrap(), "uploaded");
    let explicit = sftp::upload_target(&session, &format!("{home}/new.txt"), "ignored").await;
    assert_eq!(explicit, format!("{home}/new.txt"));
}
