<h1 align="center"><img src="./docs/brand/banner.png" alt="Telepy：ブラウザからすべてのデバイスへ" width="100%"></h1>

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

Telepy は、直接つなげないマシンのためのセルフホスト型 Web コンソールです。NAT の内側のサーバー、自宅の
Raspberry Pi、ファイアウォールの奥にあるオフィスの PC、OpenWrt のルーターなど。各デバイスが Telepy サーバーへ**リバース SSH トンネルを
1 本**張るだけで、あとはブラウザから操作できます——ターミナル、ファイル、リモートデスクトップ、デバイス経由で
インターネットに出るブラウザ、そしてデバイスの LAN にある他のマシンまで。デバイスは細かな権限でチームと共有でき、
すべての操作を `telepy` コマンドライン、REST API、MCP で自動化できます。デバイス側のネットワークでは、その 1 本の
外向き SSH 接続以外にポートを開けることも、何かをインストールすることも不要です。

![トンネル一覧：状態、レイテンシ、各デバイスの接続方法、パブリック／LAN アドレス、OS、ラベル、利用中のユーザー](./docs/screenshots/ja/tunnels.png)

## できること

### デバイスをつなぐ

- **Linux・macOS・OpenWrt は 1 行のコマンド。**デバイスで `curl … | sudo sh` を貼り付けるだけ。スクリプトはまず
  デバイスにあるもの（シェル、HTTP ツール、OpenSSH か Dropbear、systemd / launchd / procd）を調べ、トンネル鍵の作成、
  デバイスの登録、Telepy の承認、Telepy のホスト鍵のピン留め、サービスの登録を行い、Telepy がトンネル経由で実際に
  ログインできるまで待ちます。`--check` を付ければチェックだけを先に実行できます。それ以外の環境（Windows、Docker、
  アプライアンス）では 5 ステップのウィザードが SSH、AutoSSH、systemd、PowerShell、Docker run、Docker Compose の
  スクリプトを生成します。
- **SSH ポート、ふさがれていれば Web ポート。**デバイスはまずゲートウェイの SSH ポートを試し、つながらなければ
  Web ポートの WebSocket に SSH を通します。各トンネルにどの方法で接続しているか（SSH / SSH over WSS）が表示され、
  インストール済みのデバイスもトンネルを切らずに自動へ切り替えられます。Web の名前が Web の通信しか通さない
  プロキシの後ろにあるなら、SSH に別の名前を付けられます。
- **デバイス上のインストールを整理。**各トンネルのサービスには中身の分からないインストール名が付き、Telepy は
  何がどこに入っているかを表示します。古いインストールの名前変更や余分なコピーの削除も、デバイスをオフラインに
  せずに行えます。
- **状態がひと目でわかる。**オンライン／低下／オフライン／未接続、区間ごとのレイテンシ、稼働率と接続履歴、
  デバイスのパブリック／LAN アドレス（IP が変わると通知）、毎日取得するデバイス情報（OS、メモリ、ディスク、負荷、
  再起動待ち）と警告。
- **数百台でも整理できる。**コンパクトな一覧かカード、ラベル、ピン留め、個人用グループ、`status:down`・
  `label:env=prod`・`os:openwrt`・`lastseen:>1d` などの条件で絞り込める検索。

### デバイスで作業する

- **Web ターミナル**：タブ、Nerd Font、組み込み／カスタムの配色、接続が切れてもシェルを残す設定（許可した場合）、
  操作の録画、コマンドをデバイスのシェル履歴に残さない設定（任意）、変数付きのコマンドスニペットを保存できる
  **ツールボックス**。
- **ファイルマネージャー**（SFTP）：ドラッグ＆ドロップでのアップロード、移動／コピー／名前変更／削除／権限、
  zip でのダウンロード、画像プレビュー、ファイルを中途半端に壊さないブラウザ内エディタ。
- **リモートデスクトップ**：トンネル経由の RDP / VNC をブラウザで（guacd）、または RustDesk をタブ内でデコード。
  音声、クリップボードの制御、ファイル転送、マルチモニターの切り出し、ウィンドウに合わせた拡大縮小と解像度に対応。
- **リモートブラウザ**：本物の Chromium（KasmVNC）で、通信はデバイスから出ていきます。デバイスのネットワークからしか
  開けない管理画面に。
- **ネットワークトポロジー**：何もインストールせずにデバイスの LAN をスキャンし、メーカーと開いているポートを表示。
  デバイス経由で LAN 内のホストにターミナルやリモートデスクトップを開いたり、`ssh -J`／`ProxyJump` の設定を
  コピーしたりできます。
- **手元のコンピューターから**：1 つのコマンドで全デバイスを `~/.ssh/config` に追加（各デバイス自身のホスト鍵も
  確認）。コマンド早見表には `ssh -L`／`-R`／`-D`／`-J`、`scp`、`rsync` がそのまま使える形で並びます。
  **SSH config エディター**は設定ファイルの各ホストが実際に使う値を一覧にし、効かない行を直し、ファイルを簡潔に
  します——どの変更も ssh の読み方どおりに検証済み（ターミナルでは `telepy config tidy` で同じことができます）。

### チームと管理

- **共有**：VIEW／EDIT／ADMIN の権限、使えるログインアカウントの個別指定、期限付きの共有、一時的な権限追加の申請。
  権限を外すと、その人の開いているセッションはすぐに終了します。
- **機能の権限とユーザーグループ**：ターミナル、ファイル、リモートデスクトップ、LAN スキャン、API トークン、
  MCP アプリなどを誰が使えるかを、全員・グループ・個人単位で設定。
- **コマンドルール**：Web ターミナルと MCP エージェントの両方で、コマンドをブロック・承認制にする、またはリマインド
  を表示します。管理するデバイスには自分のルールを、管理者はサイト全体のルールを設定し、どのサイトルールを各自の
  デバイスでオフにできるかを決められます。
- **ライブセッション**：誰がどこに接続しているかを確認し、ターミナルをリアルタイムで見守る（キーボードを渡すことも
  可能）、またはセッションを終了。
- **サインインの安全性**：パスキーと認証アプリ、重要なデバイスの前での再確認、サインイン中のブラウザ一覧、新しい
  デバイスからのサインイン通知、目立たないサインイン画面（任意）。
- **通知**：画面内の通知とデスクトップ通知をイベントごとに設定。管理者がサイトの既定を決めて強制することもでき、
  デバイスごとのミュートも可能。個人用・サイト全体の Webhook を Slack・Discord・Google Chat・Teams・Telegram・
  ntfy・自前のサービスへ。
- **監査**：改ざん検知付きのログ（ハッシュチェーン）、ターミナル録画、サインイン履歴。
- **サーバーの状態**：管理セクションで、稼働中のサーバー自身のチェック（設定、鍵、連携サービス、訪問者アドレスの
  届き方、監査チェーン）を実行し、リアルタイムの数値と並べて表示。既知の問題は確認済みにできます。

### 自動化

- **`telepy` コマンドライン**：`telepy ls`、`telepy ssh web-01`、`telepy exec --label env=prod -- uptime`、
  `telepy cp`、ライブセッション、録画、スニペット、LAN ホスト、スクリプトから操作するブラウザ。`ssh`／`scp`／`sftp`
  は Web ポートを通り、`telepy update` で CLI を最新に保てます。
- **REST API**：個人用 API トークン（スコープ、対象トンネルの限定、有効期限、呼び出し履歴）と自動生成の OpenAPI。
- **MCP サーバー**（AI エージェント向け：Claude Code、Cursor など）：アプリごとに OAuth で承認し、すべてのツール
  呼び出しを記録。コマンドルールと権限もそのまま適用されます。

## スクリーンショット

<table>
  <tr>
    <td width="50%"><img src="./docs/screenshots/ja/terminal.png" alt="Web ターミナルとファイルマネージャー"><br><sub><b>Web ターミナル + ファイルマネージャー</b>——タブ、SFTP のサイドパネル、区間ごとのレイテンシ。</sub></td>
    <td width="50%"><img src="./docs/screenshots/ja/network.png" alt="ネットワークトポロジー"><br><sub><b>ネットワーク</b>——デバイスの sshd 経由でスキャンした LAN。メーカーと開いているポート付き。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/ja/desktop.png" alt="リモートデスクトップ"><br><sub><b>リモートデスクトップ</b>——トンネル経由の VNC デスクトップ。ストリーム統計と画面選択付き。</sub></td>
    <td><img src="./docs/screenshots/ja/browser.png" alt="リモートブラウザ"><br><sub><b>リモートブラウザ</b>——デバイスからインターネットに出る Chromium。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/ja/create.png" alt="1 行のコマンドでデバイスを追加"><br><sub><b>デバイスの追加</b>——1 行のコマンド。スクリプトが何をするかを示し、Telepy がログインするまで進捗を表示。</sub></td>
    <td><img src="./docs/screenshots/ja/commands.png" alt="コマンドルール"><br><sub><b>コマンドルール</b>——自分のルールとサイト全体のルール：ブロック・承認・リマインド・例外。テスターで誰に承認を求めるかがわかります。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/ja/sessions.png" alt="ライブセッション"><br><sub><b>ライブセッション</b>——誰がどこから接続しているか。見守る・終了する。</sub></td>
    <td><img src="./docs/screenshots/ja/access.png" alt="機能の権限"><br><sub><b>機能の権限</b>——個人、ユーザーグループ、全員単位で設定。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/ja/sshconfig.png" alt="SSH config エディター"><br><sub><b>SSH config エディター</b>——<code>~/.ssh/config</code> を貼り付けて、各ホストが使う値を確認し簡潔に。ssh の読み方どおりに検証。</sub></td>
    <td><img src="./docs/screenshots/ja/health.png" alt="サーバーの状態"><br><sub><b>サーバーの状態</b>——サーバー自身のチェック、リアルタイムの数値、直近 24 時間。</sub></td>
  </tr>
  <tr>
    <td><img src="./docs/screenshots/ja/api.png" alt="API トークン"><br><sub><b>API</b>——スコープ・対象トンネル・トークンごとの呼び出し概要。</sub></td>
    <td><img src="./docs/screenshots/ja/activity.png" alt="エージェントのアクティビティ"><br><sub><b>エージェントのアクティビティ</b>——承認待ちのコマンドを含む、すべての MCP ツール呼び出し。</sub></td>
  </tr>
</table>

## 仕組み

```
 ブラウザ ──https──▶ Traefik ──▶ frontend（Next.js）
                       │
                       └──────▶ backend（Rust）◀══ リバース SSH（デバイスから外向き）══ デバイス ── LAN ホスト
                                  │   REST API · WebSocket · 内蔵 SSH ゲートウェイ · 監視
                                  ├──▶ kasm-browser（リモートブラウザ用 Chromium）
                                  └──▶ guacd（RDP / VNC）
```

デバイスは `ssh -R 0:localhost:22 telepy@<サーバー>` を実行します——ゲートウェイの SSH ポートへ直接、HTTPS しか
出られなければ Web ポートの WebSocket の中で（1 行のコマンドや生成スクリプトがサービスとして登録します）。バックエンドの内蔵 SSH ゲートウェイがこれを受け、鍵からどのトンネルかを判別し、転送をメモリ上に
記録します——ホスト側でポートを開くことはありません。Telepy がデバイスで行うすべての操作（ターミナル、ファイル、
デスクトップ、リモートブラウザ、LAN スキャン）は、この 1 本の接続の中にチャネルを開き、そのトンネル専用のサービス鍵で
デバイス自身の sshd にログインします。デバイスにパブリック IP もファイアウォールの開放も不要で、Telepy は各デバイスの
ホスト鍵を、デバイスは Telepy のホスト鍵をピン留めします。

Telepy は 5 つのコンテナで動きます：

| サービス       | 役割                                                                                          |
| -------------- | --------------------------------------------------------------------------------------------- |
| `traefik`      | リバースプロキシ：`/api/*`、`/ws/*`（デバイスの WebSocket 接続も）、`/mcp`、OAuth ディスカバリはバックエンドへ、それ以外はフロントエンドへ |
| `frontend`     | Next.js の Web UI                                                                              |
| `backend`      | 単一の Rust プロセス（axum + russh）：REST API、WebSocket、SSH ゲートウェイ、監視、SQLite       |
| `kasm-browser` | リモートブラウザ用の KasmVNC + Chromium                                                         |
| `guacd`        | リモートデスクトップ用の Apache Guacamole RDP / VNC エンジン（内部ネットワークのみ）             |

## クイックスタート

Docker と Compose プラグインが必要です。

1. 環境ファイルを作り、少なくとも `SECRET_KEY`、`INTERNAL_API_TOKEN`、`SERVER_DOMAIN` を設定します（HTTPS プロキシの
   後ろに置く場合の公開アドレスは `PUBLIC_URL`、または後から**サイト設定 → サーバー**で）：

   ```bash
   cp .env.example .env
   ```

2. ゲートウェイのホスト鍵とサービス鍵を生成します（再実行しても既存の鍵は残ります——デバイスがピン留めしているため）：

   ```bash
   ./telepy.sh keygen
   ```

3. ビルドして起動し、確認します：

   ```bash
   docker compose up -d --build
   ./telepy.sh doctor
   ```

4. `http://localhost:<WEB_SERVER_PORT>`（既定は `http://localhost:8787`）を開いてサインインします。

> [!NOTE]
> **最初のアカウント**が管理者になります——Google でサインインした場合も、`./telepy.sh create-superuser` で作成した場合も
> 同じです。

本番環境では Traefik の前に HTTPS プロキシを置き、公開アドレスを設定し、デバイスからゲートウェイのポート
（`REVERSE_SERVER_SSH_PORT`）に届くようにしてください。Web の名前が Web の通信しか通さないプロキシ（Cloudflare の
オレンジ色の雲、CDN、HTTP ロードバランサー）を通る場合は、**サイト設定 → サーバー → SSH ホスト**でサーバーを直接
指す名前を SSH に付けてください——またはデバイスに Web ポートを使わせます。訪問者のアドレス（サインイン履歴、
ライブセッション）は X-Forwarded-For から取り、既定ではバックエンドの前にある内部プロキシを自動的にスキップします。
管理セクションの**サーバーの状態**で構成全体をチェックし、自分のリクエストのアドレスがどう求められたかも確認できます。

### デバイスをつなぐ

- **Linux / macOS / OpenWrt**：**トンネル → トンネルを作成 → 1 行のコマンド**で、コマンドをコピーしてデバイスで
  実行します。各ステップが画面に表示され、Telepy がトンネル経由でログインできると緑になります。詳しくは
  [docs/device-join.md](./docs/device-join.md)。
- **それ以外（Windows、Docker、アプライアンス）**：**ステップごとに設定**——デバイスの公開鍵を貼り付け、ログイン
  アカウントを選び、Telepy の鍵を承認し、生成されたスクリプトを実行してログインを確認します。

トンネルが**オンライン**になれば、カードのターミナル・ファイル・デスクトップ・ブラウザのボタンが使えます。

## 設定

次の値はスタックの起動前に必要なので `.env` に置きます（詳しいコメントは [`.env.example`](./.env.example)）：

| 変数                      | 既定        | 説明                                                                       |
| ------------------------- | ----------- | -------------------------------------------------------------------------- |
| `PROJECT_NAME`            | `main`      | コンテナとネットワーク名の接尾辞（同じホストでスタックごとに別の値）      |
| `DEBUG`                   | `false`     | デバッグログ                                                               |
| `WEB_SERVER_PORT`         | `8787`      | Traefik が公開する Web UI・API・WebSocket のポート                          |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | デバイスがリバース SSH トンネルを張るポート                                |
| `SERVER_DOMAIN`           | `localhost` | このサーバーのホスト名；スクリプト、SSH 設定、ピン留めするホスト鍵に書き込まれます |
| `SECRET_KEY`              | —           | サインインの署名と保存する秘密情報の暗号化；本番前に長いランダム値を設定  |
| `INTERNAL_API_TOKEN`      | —           | バックエンドと kasm-browser コンテナの間の秘密値                           |
| `GEOIP_DIR` / `OUI_DIR`   | `/data/geoip` / `/data/oui` | IP 位置情報データベースと NIC メーカー一覧の場所（コンテナ内のパス。`./telepy.sh geoip` / `oui` がここに取得） |

以下は**任意**です。どれも**サイト設定 → サーバー**に同じ項目があり、管理者が Web から再起動なしで変更できます。
変数を空にしておけば Web で管理し、`.env` に値があればそちらが優先されてその項目はロックされます。

| 変数                          | サイト設定                             | 空のとき                                                |
| ----------------------------- | -------------------------------------- | ------------------------------------------------------- |
| `PUBLIC_URL`                  | 公開アドレス                           | リクエストから推定（OAuth issuer、パスキーのオリジン、1 行コマンドの URL） |
| `SSH_SERVER_DOMAIN`           | SSH ホスト                             | `SERVER_DOMAIN` と同じ；Web の名前が Web 専用のプロキシを通るときに設定 |
| `SOCIAL_GOOGLE_CLIENT_ID`     | Google クライアント ID                 | Google サインインなし                                   |
| `TRUSTED_PROXY_HOPS`          | 信頼するプロキシ                       | `auto`：X-Forwarded-For の内部アドレスはすべてプロキシ  |
| `CLIENT_IP_HEADER`            | クライアント IP ヘッダー               | なし（Cloudflare 経由のリクエストではそのヘッダーを自動で使用） |
| `GATEWAY_PROXY_PROTOCOL_FROM` | SSH ゲートウェイの PROXY protocol 送信元 | オフ                                                  |
| `DEVICE_PROBE`                | 毎日のデバイス確認                     | オン：1 日 1 回、読み取り専用でデバイスにログインしてアドレスと情報を取得 |
| `KEEP_SHARED_SERVICE_KEY`     | デバイスの共有サービス鍵を残す         | オフ                                                    |
| `LOG_LEVEL`                   | ログレベル                             | `info`（`DEBUG=true` なら `debug`）                     |
| `OPENAPI_ENABLED`             | API リファレンス                       | オン（Swagger UI と OpenAPI ドキュメント、要サインイン） |

それ以外——登録、サインインの有効期間と 2 段階認証の必須化、リモートブラウザ／デスクトップの上限、MCP セッション、
Webhook、通知、ターミナルとコマンドルールの既定値——もサイト設定で、ユーザーと機能の権限は管理セクションの
**ユーザーとアクセス**にあります。

## コマンドライン、API、MCP

**`telepy` コマンドライン**——リリース版（macOS、Linux、Windows。Telepy の各リリースに付属）をダウンロードするか
`cargo install --locked --git https://github.com/NatLee/telepy telepy-cli`。Web の **CLI** ページ（サイドバーの「開発者」→ CLI）に、
このコンピューター用のインストールコマンドと、自分のトンネルで埋めた例があります：

```sh
telepy login https://telepy.example.com        # ブラウザでサインイン、または API ページの --token tpt_…
telepy ls                                      # トンネル一覧（状態、レイテンシ、アカウント、ラベル）
telepy ssh web-01                              # システムの ssh でトンネル経由で接続、Telepy のホスト鍵はピン留め済み
telepy exec --label env=prod -- uptime         # 複数台で一括実行；コマンドルールと監査も適用
telepy cp ./app.conf web-01:/etc/app/
telepy config tidy                             # ~/.ssh/config を簡潔に（ssh の読み方どおりに検証）
telepy api activity --follow                   # API トークンの呼び出しをリアルタイムで表示
telepy update                                  # 最新のリリースに置き換え
```

CI ではサインインせず `TELEPY_URL` と `TELEPY_TOKEN` を設定します。詳細は [docs/cli.md](./docs/cli.md)。

**REST API**——**API** ページで個人用トークンを作成します。トークンで呼べるエンドポイントが `curl` の例付きで一覧
されます。OpenAPI ドキュメントは `/api/openapi.json`、Swagger UI は `/api/__hidden_swagger`（どちらも要サインイン。
`telepy-server openapi` でも出力できます）。

**MCP**——MCP クライアントを `https://<ホスト>/mcp` に向けます。例：
`claude mcp add --transport http telepy https://<ホスト>/mcp`。初回は承認ページが開き、権限と対象トンネルを選べます。
**MCP** ページにクライアントごとの設定方法があります。詳細は [docs/mcp.md](./docs/mcp.md)。

## 運用

`./telepy.sh`（Windows では `telepy.ps1`）が日常の作業をまとめています：

| サブコマンド       | 内容                                                                 |
| ------------------ | -------------------------------------------------------------------- |
| `keygen`           | ゲートウェイのホスト鍵とバックエンドのサービス鍵を生成（既存の鍵は保持） |
| `create-superuser` | 管理者アカウントを作成                                               |
| `doctor`           | `.env`、コンテナ、ポート、バックエンドの設定を確認（問題があれば 1） |
| `geoip`            | オフラインの IP 位置情報（DB-IP Lite）をダウンロード；毎月更新       |
| `oui`              | IEEE のメーカー一覧をダウンロードし、LAN ホストに NIC のメーカーを表示 |
| `migration`        | データベーススキーマを調整（起動時にも自動で実行）                   |
| `shell`            | バックエンドコンテナのシェルに入る                                   |
| `backend-debug`    | バックエンドコンテナを作り直してログを追う                           |

アップグレードは `git pull && docker compose up -d --build` だけです。スキーマは起動時に自動で調整されます。

## ドキュメント

- [`telepy` コマンドラインと API トークン](./docs/cli.md)
- [MCP：AI エージェントからデバイスを操作](./docs/mcp.md)
- [Webhook：イベント、形式、署名](./docs/webhooks.md)
- [1 行のコマンドでデバイスを追加（Linux、macOS、OpenWrt）](./docs/device-join.md)
- [リモートデスクトップ（RDP / VNC / RustDesk）](./docs/remote-desktop.md)
- [リモートブラウザ（KasmVNC）](./docs/remote-browser.md)
- [バックエンドがデバイスに接続する仕組み](./docs/device-connections.md)
- [レイテンシ計測の詳細](./docs/latency-deep-dive.md)
- [Rust バックエンド移行計画](./docs/rust-migration-plan.md) と [ベンチマーク：Django vs Rust](./docs/benchmarks.md)
- [README のスクリーンショットの作り方](./docs/screenshots/README.md)
- [記事](./docs/articles/)
- リリースノート：[GitHub Releases](https://github.com/NatLee/telepy/releases)

## コントリビューター

<!-- ALL-CONTRIBUTORS-LIST:START - Do not remove or modify this section -->
<!-- prettier-ignore-start -->
<!-- markdownlint-disable -->
<table>
  <tbody>
    <tr>
      <td align="center"><a href="https://github.com/NatLee"><img src="https://avatars.githubusercontent.com/u/10178964?v=3?s=100" width="100px;" alt="Nat Lee"/><br /><sub><b>Nat Lee</b></sub></a></td>
      <td align="center"><a href="https://github.com/h-alice"><img src="https://avatars.githubusercontent.com/u/16372174?v=3?s=100" width="100px;" alt="H. Alice"/><br /><sub><b>H. Alice</b></sub></a></td>
      <td align="center"><a href="https://github.com/boris-lok"><img src="https://avatars.githubusercontent.com/u/77889460?v=3?s=100" width="100px;" alt="Boris Lok"/><br /><sub><b>Boris Lok</b></sub></a></td>
    </tr>
  </tbody>
</table>

<!-- markdownlint-restore -->
<!-- prettier-ignore-end -->

<!-- ALL-CONTRIBUTORS-LIST:END -->

## ライセンス

Telepy は [GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0）で提供されています。改変した Telepy を他の人に
サービスとして提供する場合は、その人たちにソースコードを提供する必要があります。この条件が合わない場合は商用ライセンスも
あります——[@NatLee](https://github.com/NatLee) までご連絡ください。

2026 年 10 月より前にリリースされたバージョンは MIT ライセンスです（[NOTICE](./NOTICE) を参照）。コントリビューションは
[コントリビューターライセンス契約](./CONTRIBUTING.md#contributor-license-agreement) に基づきます。
