# `telepy` コマンドラインと個人用 API トークン

<p align="center"><a href="./cli.md">English</a> | <a href="./cli.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

`telepy` は、ターミナルから使う Telepy です。トンネルの一覧表示、`ssh` / `scp` / `sftp` でのデバイスへの直接接続、1 台のデバイスまたはラベルの付いた全デバイスでのコマンド実行、
ファイルのコピー、ライブセッションの確認と終了、ターミナル録画の再生、ツールボックスのスニペット実行ができます。スクリプトや CI でも同じコマンドを使い、ブラウザーでのサインインの代わりに**個人用 API トークン**を使います。

ソース：`src/cli/`（独立した crate で、サーバーのビルドはこれに依存しません）。バックエンド：`auth/api_tokens.rs`、
`api/api_tokens.rs`、`db/api_tokens.rs`、`db/api_calls.rs` + `api_calls.rs`（呼び出しログ）、`api/ai.rs` の REST exec ルート、
`api/browser.rs` のスクリプト用ブラウザーのルート。

トークンは **API** ページ（`/tunnels/api`、サイドバーの「開発者」→ API）で管理します。タブは 4 つです。**CLI のサインイン**（`telepy login` を実行した
すべてのコンピューター）、**あなたのトークン**、**トークンで呼べるもの**（すべてのエンドポイントを、そのままコピーできる `curl` と
対応する `telepy` コマンド付きで）、**アクティビティ**（トークンと CLI のサインインが行ったこと）です。

## 4 つの入り口、4 つの鍵

![4 つの入り口：1 つを取り消しても他はそのまま](images/ja/ways-in.gif)

```
 このブラウザー ──────────────────── Web サインインセッション ───────────────────────────────┐
                                                                                             │
 スクリプト / CI ─────────────────── API トークン（スコープ · トンネル · 有効期限） ─────────┤
                                                                                             │
 あなたのコンピューターの telepy ─── CLI のサインイン（OAuth、コンピューターごとに 1 つ） ───├──▶ Telepy ──── トンネル経由の SSH ───▶ あなたのデバイス
                                                                                             │
 MCP アプリ ──────────────────────── OAuth の許可（このアプリを承認済み） ───────────────────┘

 API トークンを失効させると：
 スクリプト / CI ─────────────✂── （ただちに拒否され、開いている exec セッションは閉じる）
 このブラウザー、CLI のサインイン、MCP アプリ ── そのまま動き続ける
```

同じ図のライブ版は **API** ページの **4 つの入り口**ボタンの先にあります（「もし…」スイッチ付き：トークンの失効、CLI のサインアウト、
アプリの切断、Web からのサインアウトは、それぞれ自分の経路だけを切ります）。トークンごとの図は
**あなたのトークン → しくみ**にあります。

- トークンは**あなた自身**です。あなたのトンネル、そこで使えるアカウント、管理者があなたに設定した機能スイッチ、
  コマンドルールがすべてそのまま適用されます。あなたが持っている以上の権限は得られません。
- Web にサインインしたり、パスワードや 2 段階認証の設定を変更したり、さらにトークンを作成したりすることはできません。開かれているのは
  許可リスト `auth::api_tokens::ROUTES` にある REST ルートだけで、それぞれ 1 つのスコープが必要です。API ページの**トークンで呼べるもの**
  タブは同じ表（`GET /api/auth/tokens/routes`）から作られているので、サーバーの動作と食い違うことはありません。
- 本人確認（**ステップアップ**）を求めるトンネルは、MCP エージェントと同様にトークンを拒否します。
- トークンにはすべて有効期限があります（最長 1 年）。失効はただちに反映されます。
- 管理者は、全員・ユーザーグループ・特定の 1 人に対して **API トークン**機能をオフにできます（管理 → ユーザーとアクセス →
  機能の権限、`/tunnels/admin/access`）。オフにされた人のトークンは動かなくなります。管理者があなたに対してオフにした
  他の機能（Web ターミナル、ファイルマネージャーなど）も、あなたのトークンには拒否されます（403 `feature_disabled`）。
- 管理者があなたのアカウントを無効にすると、トークンと CLI のサインインは失効ではなく一時停止になります。アカウントが無効の間は拒否され、
  有効に戻すとまた使えるようになります。

## スコープ

| スコープ | トークンにできること | CLI コマンド |
| --- | --- | --- |
| `tunnels:read` | トンネル一覧、状態、稼働時間、アカウント、生成された ssh config、ライブセッションの取得 | `ls`、`status`、`ssh`、`scp`、`sftp`、`config install`、`sessions`、`lan ls` |
| `ssh:exec` | exec セッションを開いてコマンドを実行（コマンドルールが適用されます）、録画とスニペットの読み取り | `exec`、`run`、`recordings`、`snippets` |
| `ssh:files` | すべての SFTP 操作 | `cp` |
| `network:scan` | LAN スキャン（MCP の `lan_scan`、スキャン用 REST ルート） | — |
| `browser:use` | デバイス経由のスクリプト用ブラウザー：MCP のブラウザーツールと `/api/browser/sessions*` | `browse` |
| `tunnels:manage` | トンネルの作成 / 変更 / 削除 / 共有、ラベル、LAN ホスト、セッションの終了（トークン専用） | `sessions end`、`lan add` / `rm` |

`tunnels:read` では、デバイスの背後にある LAN ホストも一覧できます（`telepy lan ls`、`GET /api/reverse/lan/topology`）。

`ssh` / `scp` / `sftp` に必要なのは `tunnels:read` だけです。ssh config を取得したあと、お使いのシステムの OpenSSH が
**あなた自身の個人用 SSH キー**でゲートウェイ経由でログインします。Web の SSH config ダイアログと同じ方法です。

## インストール

Web には **CLI** ページ（`/tunnels/cli`、サイドバーの「開発者」→ CLI）があり、お使いのコンピューター向けのインストールコマンド
（ブラウザーから判別します）、お使いのサーバー向けのサインインコマンド、そして自分のトンネル、アカウント、ラベル、グループ、スニペットで
埋めた例が載っています。手作業で行う場合のコマンドは次のとおりです。

`v2.8.0` 以降のすべての Telepy リリースに、macOS arm64 / x86_64、Linux x86_64 / arm64（静的、musl）、
Windows x86_64 向けの CLI が含まれます。同じタグからビルドされ、同じバージョンを報告します（`telepy --version`）。ファイル名には
バージョンが入らないので、`releases/latest/download/…` は常に最新版を指します。

```sh
# macOS / Linux
TARGET=aarch64-apple-darwin   # x86_64-apple-darwin, x86_64-unknown-linux-musl, aarch64-unknown-linux-musl
curl -fsSL "https://github.com/NatLee/telepy/releases/latest/download/telepy-$TARGET.tar.gz" | tar xz telepy
sudo mkdir -p /usr/local/bin && sudo install -m 755 telepy /usr/local/bin/ && rm telepy
telepy --version
```

```powershell
# Windows: unpacks into %LOCALAPPDATA%\telepy and adds it to your PATH once
$dir = "$env:LOCALAPPDATA\telepy"
Invoke-WebRequest https://github.com/NatLee/telepy/releases/latest/download/telepy-x86_64-pc-windows-msvc.zip -OutFile "$env:TEMP\telepy.zip"
Expand-Archive "$env:TEMP\telepy.zip" $dir -Force
$p = [Environment]::GetEnvironmentVariable("Path", "User")
if (($p -split ";") -notcontains $dir) { [Environment]::SetEnvironmentVariable("Path", "$p;$dir", "User") }
$env:Path += ";$dir"
telepy --version
```

各アーカイブの隣には `.sha256` があり、各リリースには `SHA256SUMS` があります
（`curl -fsSL …/telepy-$TARGET.tar.gz.sha256 | sha256sum -c`、macOS では `shasum -a 256 -c`）。バージョンを指定する場合は
`…/releases/download/v2.11.0/telepy-$TARGET.tar.gz` とします。バイナリーには Apple や Microsoft の署名はありません。`curl` ではなく
ブラウザーでダウンロードした場合、macOS では先に `xattr -d com.apple.quarantine telepy` が必要です。

### ダウンロードの出どころを確かめる

リリースのファイルが Telepy のものだと示す手段が 2 つあり、どちらもアカウントは不要です。

- **ビルドの来歴。**リリースの各ファイルはビルド自身が証明します（GitHub artifact attestation）。
  `gh attestation verify telepy-$TARGET.tar.gz --repo NatLee/telepy` で、どのコミットのどの workflow 実行がそのバイトを作ったかが分かります。
- **署名されたチェックサム一覧。**`SHA256SUMS` は Telepy のリリース鍵（OpenSSH の ed25519 鍵。公開鍵は
  [`src/backend-api/src/release_key.rs`](../src/backend-api/src/release_key.rs)）で署名され、`SHA256SUMS.sig` として
  OpenSSH の署名形式で添付されます。OpenSSH だけで検証できます：

  ```sh
  echo "telepy-release $(sed -n 's/^ *"\(ssh-ed25519 [^"]*\)".*/\1/p' release_key.rs | head -1)" > allowed_signers
  ssh-keygen -Y verify -f allowed_signers -I telepy-release -n telepy-release -s SHA256SUMS.sig < SHA256SUMS
  sha256sum -c --ignore-missing SHA256SUMS
  ```

  （鍵の行を手で貼ってもかまいません。`allowed_signers` は 1 行だけ：`telepy-release <鍵>`。）

`telepy update` とバックエンドのキャリア取得はこの検証を自分で行い、`SHA256SUMS` がない、または Telepy のリリース鍵で
署名されていないリリースは受け付けません。`TELEPY_RELEASE_KEYS`（公開鍵の行を 1 つ以上、改行か `;` で区切る）で、
自分の鍵で署名し直すミラー向けに内蔵の鍵を差し替えられます。

自分でビルドすることもできます（Rust 1.88 以降）：`cargo install --locked --git https://github.com/NatLee/telepy telepy-cli`
（報告されるバージョンは Cargo.toml の `0.1.0` です。ビルド時に `TELEPY_VERSION` を設定すると別のバージョンを刻印できます）。`ssh`、`scp`、`sftp` には
PATH 上にシステムの OpenSSH クライアントも必要です（`telepy doctor` が確認します）。

**メンテナー向け：**GitHub リリースを公開する（`gh release create v2.7.0 …`）と `.github/workflows/release-cli.yml` が動きます。
そのタグから 5 つのターゲットをビルドし、`TELEPY_VERSION` には先頭の `v` を除いたタグを設定して、スモークテスト
（`telepy --version` がそれを表示すること）を行い、来歴を証明し、`.sha256` ファイルと、`RELEASE_SIGNING_KEY` secret
（OpenSSH の ed25519 秘密鍵。なければ release ジョブは失敗します）で署名した `SHA256SUMS` とともにリリースに添付します。Actions タブから
手動で実行することもできます。タグを指定すると既存のリリースに（再）添付し、指定しなければ試験ビルドとなり、ファイルはその実行の artifacts に残るだけです。バージョン刻印より前のタグ（`v2.8.0` など）にも
同じ方法でビルドを与えられ、その CLI は Cargo.toml の `0.1.0` を報告します。`v2.8.0` 以降のすべての Telepy リリースには、そこからビルドした CLI が含まれます。
CLI 専用のタグはありません。

### アップデート

```sh
telepy update --check        # is a newer release out?
telepy update                # download it, check it against the release's signed SHA256SUMS and replace this telepy
telepy update --to v2.9.0    # a given release (also to go back)
```

`telepy update` は、リリースからこのプラットフォーム用のアーカイブをダウンロードし、`SHA256SUMS` が Telepy のリリース鍵で
署名されていないか、アーカイブの SHA-256 がそれと一致しなければ受け付けず、新しいバイナリーを古いものの隣に書き込み、古いものを脇へ移して、新しいものの `--version` を実行します。
それが失敗したら古いものを元に戻します。telepy があるフォルダーへの書き込み権限が必要です（`/usr/local/bin` なら `sudo telepy update`）。
`cargo install` や Homebrew でインストールした telepy は、それらのツールに任せます。Windows では、古い
`.exe` の名前を変更し（実行中のファイルは削除できないため）、次回の実行時に片付けます。

リリースビルドは、新しいリリースがないかも自分で確認します。1 日に 1 回まで、バックグラウンドで 2 秒のタイムアウト付きで行い、
stderr がターミナルで、かつ `CI` が設定されていないときだけです。新しいものがあれば、コマンドが成功したあとに 1 行で知らせます。
`TELEPY_NO_UPDATE_CHECK=1` でオフにできます。`TELEPY_RELEASES_URL` を使うと、確認とダウンロードの両方を
`https://github.com/NatLee/telepy/releases` のミラーに向けられます（最新のタグは `/latest` のリダイレクトから読むので、GitHub API の
レート制限は関係しません）。`telepy doctor` はバージョンと新しいものがあるかどうかを表示します（警告であり、失敗にはなりません）。
手元でビルドした telepy（バージョンは Cargo.toml 由来）は、自分では確認しません。

## サインイン

```sh
telepy login https://telepy.example.com                 # browser: OAuth + PKCE, loopback callback
telepy login https://telepy.example.com --scope "tunnels:read ssh:exec ssh:files network:scan"
telepy login https://telepy.example.com --no-browser    # print the sign-in URL instead of opening a browser
telepy login https://telepy.example.com --token tpt_…   # a personal API token (the API page → Your tokens); --with-token works too
telepy whoami                                           # who, and with which token / app, scopes, tunnels and expiry
telepy logout
```

承認すると、ブラウザーは Telepy の「サインイン完了」ページ（`/oauth/done`：CLI に今できることと、試せる
コマンドがいくつか表示されます。見た目はサイト設定 → サインインの承認ページの設定に従います）に移ります。このページがない
古い Telepy サーバーでは、CLI 自身が描く小さなページが表示されます。

ブラウザーでのサインインは MCP アプリと同じ OAuth の承認を使うので、承認ページも似た見た目になりますが、
CLI は MCP アプリではありません。**API ページ → CLI のサインイン**に（コンピューターごとに 1 件、その呼び出しは API
アクティビティに）表示され、MCP アプリの中には現れません。サインアウトもそこか `telepy logout` で行います。同じコンピューターで `telepy login` を
もう一度実行すると、以前のサインインを置き換えるか尋ねられます。CLI のサインインは 1 人あたり最大 10 件まで保持され、11 件目は
最も長く使われていないものをサインアウトします。ブラウザーでのサインインは、管理者がオフにできる **MCP アプリ**機能（管理 →
ユーザーとアクセス → 機能の権限）に従います。トークンはそれに関係なく使えます。CLI はアクセストークンとリフレッシュトークンを保存します。認証情報は
macOS ではキーチェーン、Windows では資格情報マネージャーに保存されます。Linux（および `TELEPY_NO_KEYRING=1` を設定した場合、またはキーリングが失敗した場合）では、設定ディレクトリー内のモード 0600 の `credentials.json` に保存されます
（`TELEPY_CONFIG_DIR`、なければ `$XDG_CONFIG_HOME/telepy` か `~/.config/telepy`、Windows では `%APPDATA%\telepy`）。`logout` はサインイン情報を忘れ、
ブラウザーでのサインインはサーバー側で失効させます。トークンは、API ページで失効させるまで有効です。

CI では何も保存する必要はありません。`TELEPY_URL` と `TELEPY_TOKEN` を設定してください（または `--server` / `--token` を渡します）。

ターミナルでは、`telepy login` と問題のない `telepy doctor` の結果の横に、Telepy の小さなゴースト Tapi が表示されます（出力をパイプしているときは表示されません。`NO_COLOR` では色なしで描かれます）。
横のテキストはターミナルの幅に合わせて折り返されます。幅が狭いと Tapi の下に回り、非常に狭いと Tapi は省かれます。
`TELEPY_NO_MASCOT=1` を設定すると表示しません。

## コマンド

![CLI がデバイスに届く経路](images/ja/cli-flow.png)

```sh
telepy ls                                  # NAME  HEALTH  LATENCY  ACCOUNTS  LABELS  GROUP  SEEN
telepy ls --label env=prod --online --json
telepy ls --group "Lab"
telepy status box                          # health, uptime, device facts and warnings

telepy ssh box                             # the tunnel's default account
telepy ssh box@pi -- uname -a              # <tunnel>@<account> (pi@box works too)
telepy ssh box -L 8080:localhost:80        # forward a port; -D 1080 for SOCKS
telepy ssh box -i ~/.ssh/id_work           # a specific key for both hops
telepy ssh box --ssh-opt "-o ServerAliveInterval=30"   # any other ssh option (repeatable; scp / sftp take it too)
telepy ssh box --via ssh                   # straight to Telepy's SSH port instead of the web port (see "Which port" below)
telepy config fallback always              # this server: use the SSH port without asking when the web port can't be reached
telepy scp ./build.tar.gz box@pi:/tmp/
telepy scp -r box@pi:/var/log/app ./logs
telepy sftp box@pi
telepy config install box nas              # the web dialog's install command, done for you (~/.ssh/config, marked blocks, backup)
telepy config install --all --print        # every tunnel you can use; print the blocks instead of writing (--file <path> writes elsewhere)
telepy config tidy                         # simplify ~/.ssh/config: shows what changes + the diff, asks, keeps config.bak
telepy config tidy --check                 # report only; exit 1 when it could be simpler or has lines worth a look (dotfiles CI)

telepy exec box -- systemctl is-active nginx
telepy exec --label env=prod -- uptime     # every tunnel with the label, in parallel, "name | " prefixes
telepy exec --group Lab -u root --timeout 300 -- apt-get -y upgrade   # a tunnel group of yours, one account, timeout ≤ 600 s
telepy exec box nas --json -- df -h /
telepy exec box --wait-approval -- sudo reboot   # keep waiting while a command rule holds it for approval

telepy cp box@pi:/var/log/syslog ./syslog
telepy cp ./config.yml box@pi:/etc/app/

telepy sessions                            # live sessions on your tunnels
telepy sessions end 42
telepy recordings ls --tunnel box
telepy recordings play 17 --speed 2        # with its timing, pauses capped at 2 s (--idle-limit 0 keeps every pause)
telepy snippets ls --tunnel box
telepy run "restart service" box --var svc=nginx   # -y skips the "ask first" confirmation

telepy lan ls box                          # the LAN hosts Telepy knows behind a device
telepy lan add box 192.168.1.20 --label nas --user pi --port 22
telepy lan rm box nas                      # by id, address or label

ID=$(telepy browse box http://192.168.1.1/)   # a browser on the device's network (browser:use); prints its id
telepy browse text "$ID" --selector main
telepy browse shot "$ID" -o router.png
telepy browse click "$ID" --text "Status"
telepy browse type "$ID" "#q" "uptime" --enter
telepy browse go "$ID" http://192.168.1.1/logs
telepy browse ls
telepy browse close "$ID"

telepy api tokens                          # your tokens: scopes, expiry, last use, calls 24 h / 7 d, errors
telepy api activity                        # the last 50 calls made with your tokens and CLI sign-ins
telepy api activity --api-token ci --status 4xx --since 2h
telepy api activity --method DELETE --limit 200 --json
telepy api activity --follow               # like tail -f: new calls every 2 s, Ctrl+C stops
telepy api activity --all --user bob       # admins: everyone's, or one person's

telepy doctor                              # server, sign-in, scopes, expiry, ssh / scp / sftp
```

`ssh` / `scp` / `sftp` は `~/.ssh/telepy/<alias>.conf`（ProxyCommand がそのファイル自身を指す、生成された設定）と
`~/.ssh/telepy/known_hosts-<server>`（固定された Telepy ゲートウェイのホストキー）を書き込み、システムの OpenSSH を `-F` 付きで実行します
（`TELEPY_SSH_DIR` でそのフォルダーを移せます）。`telepy config install` を実行しない限り、あなた自身の `~/.ssh/config` には触れません。
このコマンドは `config.bak` を残し、ホストキーを `~/.ssh/telepy_known_hosts` に保存し、Web
ダイアログと同様に、別の Telepy サーバーに属する同名のデバイスには手を付けません（名前のプレフィックス `ssh_alias_prefix` を設定すれば
両方を共存させられます）。

`config tidy` はサインインが不要で、ファイルをどこにも送信しません。Web の **SSH config エディター**と同じルールを適用します（同じ
エンジンで、共通のテストケースによって一致が保たれています）。複数のホストが共有する行は、それらの後ろに置いた `Host a b c` ブロックに 1 回だけ書かれ
（独自の値を設定しているホストはその値を保ちます）、`Host web1` の下の `HostName web1.example.com` は
`HostName %h.example.com` になり、ssh が読むことのない重複は削除されます。ファイルに挙がっているすべての名前をもう一度解決し、
以前とまったく同じ結果になることを確かめます。`Match` / `Include` をまたぐ移動はなく、Telepy 自身のブロックはマーカーを保ちます。
また、効果のない行や ssh が知らないオプションも一覧します。`--wildcards` は、ファイル内の他のどの名前にも一致しない場合に `Host web-*` を許可します。`--yes` は確認なしで書き込み、
`--file <path>` は別のファイルを簡略化します。

`exec` はバックエンド経由でトンネルごとに短命のセッションを開きます（`POST /api/ai/sessions`、続いて `POST /api/ai/sessions/{id}/exec`、その後に閉じます）。
MCP エージェントと同じリーパー、コマンドルール、監査が使われます。
コマンドは **AI アクティビティ**ページにトークン名（ブラウザーでのサインイン後は CLI のアプリ名）で表示されます。
トークンで行った他の REST の書き込み（共有、ラベル、LAN ホスト、セッションの終了など）は、そのトンネルのログに
`token_call` の項目を残します。

`browse` は**スクリプト用ブラウザー**を操作します。デバイスの上にいるかのようにブラウズする本物の Chromium なので、
デバイスの LAN、localhost、グローバル IP が見えます。ルーターの管理ページ、社内ダッシュボード、特定の IP や地域だけを許可するサイトなどです。
操作は 1 回に 1 つで、それぞれ 30 秒以内に制限されます。各ブラウザーは完全な Chromium で、1 人あたりの
セッション数の上限（`ai_max_sessions_per_user`）に数えられるため、スクリプトによる確認、スクリーンショット、小規模なスクレイピングに向いており、
大量のクロールには向きません。ブラウザーはアイドル時に自動で閉じます。すべての操作は AI アクティビティログに残り（入力した
テキストは `--show` を付けない限り長さだけ）、ステップアップが必要なトンネルは拒否します。

終了コード：1 つのターゲットに対する `exec` / `run` は、リモートコマンドの終了コードで終了します（タイムアウトして強制終了された場合は 124、
Telepy が拒否した、または実行できなかった場合は 255）。複数のターゲットでは、どれかが失敗すると 1 で終了します。`ssh` / `scp` / `sftp` は
OpenSSH の終了コードで終了します。Telepy からのその他のエラーは 1 で終了し、サーバーのメッセージを表示します。

### `ssh / scp / sftp` が使うポート

デフォルトでは Telepy の**ウェブポート**経由で接続します。`telepy` 自身が Telepy へのホップの ProxyCommand になり、
SSH を WebSocket の中で運びます（`/ws/gateway/`、python3 は不要）。中の SSH は変わらず、あなたのキー、
固定されたホストキー、デバイス自身の sshd を使いますが、Telepy があなたの実際のアドレスを記録できるようになります。SSH ポートの手前にあるもの
（OrbStack や Docker のポート転送、NAT）は、これを隠してしまうことがよくあります。SSH のホップは 30 秒ごとにキープアライブを送るので、ウェブポートの手前にある
プロキシ（CDN、ロードバランサー）がアイドルのセッションを閉じることはありません。

ウェブポートに届かないときは、あなたが同意した場合にだけ SSH ポートを使います。

| `--fallback` / `telepy config fallback` | 動作 |
| --- | --- |
| `ask`（デフォルト） | ターミナルで尋ねます：**y** 今回だけ、**a** このサーバーでは常に（保存されます）、**N** 使わない。ターミナルがない場合（CI、スクリプト）はフォールバックせず、許可する方法を表示します。 |
| `always` | SSH ポートを使い、stderr にその旨を表示します。 |
| `never` | 理由を表示して失敗します。 |

この設定はサーバーごとに `<config dir>/prefs.json` に保存されます（値なしの `telepy config fallback` で現在の設定を表示）。
`--fallback` または `TELEPY_SSH_FALLBACK` で 1 回の実行だけ上書きでき、`--via ssh` / `TELEPY_SSH_VIA=ssh` はウェブ
ポートをまったく使いません。`telepy doctor` は両方を表示します。

## curl や MCP クライアントでトークンを使う

```sh
curl -H "Authorization: Bearer $TELEPY_TOKEN" https://telepy.example.com/api/reverse/server/dashboard
```

```json
{ "mcpServers": { "telepy": { "url": "https://telepy.example.com/mcp", "headers": { "Authorization": "Bearer tpt_…" } } } }
```

`/mcp` では、（**API トークン**に加えて）**MCP アプリ**機能があなたに対してオンである限り、トークンは OAuth アプリのトークンと同じように動作します（同じツール、スコープ、トンネルの制限）。
ツールについては [mcp.ja.md](mcp.ja.md) を参照してください。

**トークンで呼べるもの**タブには、すべてのエンドポイントについて、ベース URL を埋めた `curl` があり、シークレットは
`$TELEPY_TOKEN` になっています（一度エクスポートしておけば十分です。ページが本物のシークレットを再び表示することはありません）。パス変数もシェル変数です
（`$TUNNEL_ID`、`$ID`、`$HOST_ID`）。

## 呼び出しログ

個人用 API トークンまたは OAuth アプリのトークン（CLI のブラウザーサインイン）で行われたすべての REST リクエストが記録されます。
読み取りも含みます。個人用トークンで行われたすべての MCP ツール呼び出しも同様です（MCP アプリのツール呼び出しは、すでに
AI アクティビティログにあります）。1 行は、日時、誰が、どのトークン / アプリか、メソッド + **ルートのテンプレート**（クエリ文字列は含みません）、
トンネル、ステータス、所要時間、IP です。MCP の行は `MCP <tool>` で、ステータスは 200 または 400（ツールがエラーを返した）、
エラーの冒頭部分が付きます。拒否されたリクエスト（`token_route`、`token_scope`、トークンのトンネル範囲外の `404`）も記録されます。

- **API → アクティビティ**には自分の呼び出しが日ごとに表示され、トークンまたは CLI のサインインで絞り込めます（トークンや
  CLI のサインインの**呼び出し**ボタンからここへ移動します）。
  ステータス（OK / 4xx / 5xx）、メソッド、検索でも絞り込めます。管理者は **管理 → 全体の API アクティビティ**で全員分を見られます（人で絞り込み可能。
  「ユーザーを管理」ダイアログからリンクされています）。`GET /api/auth/tokens/calls?scope=mine|all&token_id=&grant_id=&user_id=&username=&status=&method=&limit=&before=`。
- **`telepy api activity`** は同じ一覧をターミナルに表示します（新しい順：ローカルタイムゾーンの時刻、トークンまたはアプリ、
  メソッド、ルート、トンネル、ステータス、所要時間、IP）。絞り込み：`--api-token <name|id|prefix>`（グローバルの `--token` は
  サインインの上書き用なので、絞り込みには別の名前が付いています）、`--status ok|4xx|5xx|error`、`--method GET…|MCP`、
  `--since 30m|2h|7d|<RFC 3339>`、`--limit N`（デフォルト 50、最大 1000。古いページは `before` で取得します）。
  `--all` / `--user <name|id>` は管理者向けの表示です（それ以外の人には「Only admins can see other people's API
  activity」と表示されます）。`--follow` は直近の呼び出しを古い順に表示し、その後は新しい呼び出しが来るたびに表示します（2 秒ごと。
  `--json` では 1 行に 1 オブジェクト）。ログ自身のポーリングは除外されます。`telepy api tokens` はトークンの一覧で、
  トークンごとの同じ集計が付きます。トークンと CLI のブラウザーサインインは、追加のスコープなしでこの 2 つのエンドポイント（`GET /api/auth/tokens`、
  `GET /api/auth/tokens/calls`）を読めます。トークンの作成と失効は引き続き Web アプリでのみ行います。
- **あなたのトークン**には、トークンごとに直近 24 時間 / 7 日間の呼び出し、エラー、合計が表示されます（ログの行が古くなって消えても `call_count` は
  数え続けます）。
- 書き込みはバックグラウンドでまとめて行われます（キューが満杯のときは呼び出しを破棄してカウントし、リクエストが待たされることはありません）。行は
  90 日間、最大 200,000 行まで保持され、削除されたユーザーの分も一緒に消えます。このログはハッシュチェーンではありません（量が多く、
  ユーザー単位の削除がチェーンを壊してしまうため）。トークンで行った書き込みは、引き続きトンネルのログにハッシュチェーン付きの `token_call` ゲートウェイイベントを残します。
