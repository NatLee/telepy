# Telepy

[English](./README.md) | [繁體中文](./README.zh-TW.md) | **日本語**

**リバース SSH トンネル**を管理するセルフホスト型 Web プラットフォームです。デバイスを一度登録すれば、どこからでもアクセスできます。ライブダッシュボードでトンネルの状態を監視し、ブラウザからターミナルを開き、SFTP でファイルを管理し、チームメンバーとアクセス権を共有し、さらにはリモートデバイス「経由」で Web ブラウジングまで行えます。

## 特徴

- **トンネルダッシュボード** — オンライン／オフライン状態と区間ごとのレイテンシ（あなた → Telepy → デバイス）をリアルタイム表示。リスト／カード表示に対応。
- **ガイド付きトンネル作成** — 5 ステップのウィザードが鍵を発行し、すぐに実行できる接続スクリプトを生成します：SSH、AutoSSH、systemd サービス、PowerShell、Docker Run、Docker Compose。対象マシンでスクリプトを取得するためのワンタイム `curl` URL も発行できます。
- **Web ターミナル** — WebSocket 上で動作する xterm.js のマルチタブターミナル。ユーザーごとのセッションとレイテンシ表示に対応。
- **ファイルマネージャー** — ターミナル横の SFTP ファイルブラウザで、デバイス上のファイルをアップロード／ダウンロード。
- **リモートプロキシブラウザ** — 本物の Chromium デスクトップ（KasmVNC）を起動し、トラフィックを対象デバイス経由でトンネリング。外部へのリクエストはそのマシンから発信されたように見えます。
- **ネットワークトポロジー（踏み台）** — 各デバイスの背後にあるマシンをひと目で確認。デバイスに何もインストールせずに LAN をスキャンし（デバイス自身の sshd が接続）、ホストにラベルやログインを設定して、デバイス経由で Web ターミナルを開いたり、`ssh -J` のワンライナーや `ProxyJump` の ssh config をコピーしたりできます。
- **共有と権限** — VIEW / EDIT / ADMIN の階層的な権限で、他のユーザーとトンネルを共有。
- **コマンド早見表** — トンネルを選ぶだけで、手元の PC からポート転送やファイルコピーをするための `ssh -L` / `-R` / `-D` / `-J` / `scp` コマンドをそのままコピーできます。各シナリオには通信の流れを示すライブ図が付き、`~/.ssh/config` 利用でも設定不要のワンライナーでも使えます。
- **キーとログ** — 認証キーの管理と SSH ゲートウェイログの閲覧を UI から行えます。全体またはトンネルごとに表示でき、ユーザーには自分のトンネルと共有されたトンネルだけが見えます。
- **認証** — Google OAuth2 またはユーザー名／パスワード、JWT ベースの API。最初にログインしたユーザーがスーパーユーザーになります。パスキー（パスワードレスにも対応）または認証アプリ（TOTP）による二段階認証と、使い捨てのリカバリーコードを任意で設定でき、管理者はユーザーの第二要素をリセットできます。
- **多言語対応とテーマ** — 英語・繁體中文・日本語、ライト／ダークテーマ。

## 使い方

### トンネルを作成する

**Tunnels → Create Tunnel** に移動し、デバイスの SSH 公開鍵を貼り付けてウィザードに従います。生成されたスクリプトをデバイス上で実行すると、トンネルがオンラインになります。

![トンネルの作成](./docs/gifs/create-tunnel.gif)

### Web ターミナル

オンラインのトンネルで **Terminal** をクリックすると、ブラウザから直接デバイスのシェルに入れます。

![Web ターミナル](./docs/gifs/web-terminal.gif)

### リモートプロキシブラウザ

オンラインのトンネルで **Browser** をクリックすると、そのデバイス経由で Web を閲覧する Chromium セッションが起動します（SSH SOCKS プロキシ + KasmVNC ストリーミング）。

![リモートプロキシブラウザ](./docs/gifs/remote-browser.gif)

## 仕組み

デバイスは Telepy のバックエンドへリバース SSH 接続（`ssh -NR <port>:localhost:22 telepy@server`）を維持し、内蔵の SSH ゲートウェイがそれを終端して各トンネルに専用ポートを割り当てます。Web ターミナル、ファイルマネージャー、プロキシブラウザはすべてこのポートを通じてデバイスへ到達します。デバイス側にインバウンドのファイアウォール設定やグローバル IP は不要です。

Telepy は Docker Compose で編成された 4 つのコンテナで動作します：

| サービス       | 役割                                                          |
| -------------- | ------------------------------------------------------------- |
| `traefik`      | リバースプロキシ。`/api/*` と `/ws/*` をバックエンドへ、それ以外をフロントエンドへルーティング |
| `frontend`     | Next.js 製の Web UI                                           |
| `backend`      | Rust（axum）サービス：REST API、WebSocket ターミナル／ファイルマネージャー／リレー、リバーストンネルを終端する内蔵 SSH ゲートウェイ |
| `kasm-browser` | リモートブラウザセッション用の KasmVNC + Chromium             |

## クイックスタート

Compose プラグイン付きの Docker が必要です。

1. 環境設定ファイルを作成し、必要に応じて編集します：

   ```bash
   cp .env.example .env
   ```

2. SSH サーバー鍵を生成します：

   ```bash
   ./telepy.sh keygen
   ```

3. ビルドして起動します：

   ```bash
   docker compose up -d --build
   ```

4. `http://localhost:<WEB_SERVER_PORT>/login`（デフォルト：`http://localhost:8787/login`）を開いてサインインします。

> [!NOTE]
> 最初に作成された**ユーザー**がスーパーユーザーになります。Google ログインでも `./telepy.sh create-superuser` でも同様です（実行前に `dev-scripts/dev-create-superuser.sh` でデフォルトのユーザー名／パスワードを変更できます）。

### デバイスを接続する

1. **Tunnels → Create Tunnel** でデバイスの SSH 公開鍵を貼り付け、ウィザードを完了します（デバイス上に実在する OS ユーザー名を最低 1 つ追加してください）。
2. 表示されたサービス鍵をデバイスの `~/.ssh/authorized_keys` に追記します。
3. 生成された接続スクリプトをデバイス上で実行します（動作確認には SSH、常時接続には AutoSSH／systemd／Docker）。スクリプトはトンネルの **Scripts** からいつでも取得できます。
4. トンネルが **Online** になれば、ターミナル・ファイルマネージャー・リモートブラウザが利用できます。

## 設定

`.env` の環境変数：

| 変数                      | デフォルト  | 説明                                       |
| ------------------------- | ----------- | ------------------------------------------ |
| `PROJECT_NAME`            | `main`      | コンテナ名のサフィックス                   |
| `DEBUG`                   | `false`     | デバッグログ                               |
| `SECRET_KEY`              | —           | JWT 署名キー（本番環境では必ず設定）       |
| `WEB_SERVER_PORT`         | `8787`      | Traefik が Web UI を公開するポート         |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | デバイスがリバース SSH で接続するポート    |
| `SOCIAL_GOOGLE_CLIENT_ID` | —           | Google OAuth クライアント ID               |
| `SERVER_DOMAIN`           | `localhost` | Telepy サーバーの公開ホスト名              |
| `PUBLIC_URL`              | —           | 公開ベース URL（例: `https://telepy.example.com`）。MCP クライアント向け OAuth の issuer とパスキーの origin。空ならリクエストから推定。パスキーにはドメイン名 + https（または `localhost`）が必要 |
| `INTERNAL_API_TOKEN`      | —           | 内部サービス間通信用のシークレット         |
| `OPENAPI_ENABLED`         | `true`      | Swagger UI と OpenAPI 仕様を公開（下記参照）|

### AI ツール（MCP）

Telepy 自身が OAuth 2.1 認可サーバーなので、MCP に対応した AI ツール（Claude、Cursor など）を
`https://<ホスト>/mcp` に向けるだけで使えます。初回利用時にブラウザで承認ページが開き、アプリのリダイレクト先、
権限（トンネルの閲覧／コマンド実行／ファイルの読み書き）、利用できるトンネルを選びます。承認したアプリは
**環境設定 → 接続済みアプリ** に表示され、取り消すとアクセスは即座に停止しセッションも閉じられます。
AI ツールが開いたセッションはアイドル時に自動で閉じ、上限はサイト設定で変更できます。サイドバーの
**AI アクティビティ** には開いているセッション（その場で閉じられます）とエージェントのすべてのツール呼び出しが
表示され、共有トンネルにエージェントが接続すると所有者に通知されます。詳細は [docs/mcp.md](./docs/mcp.md) を参照してください。

Claude Code の場合：`claude mcp add --transport http telepy https://<ホスト>/mcp`。ツール：`list_tunnels`、
`tunnel_status`、`ssh_session_open` / `ssh_exec` / `ssh_session_list` / `ssh_session_close`、`sftp_list` /
`sftp_read` / `sftp_write`。すべてのツール呼び出しは監査ログ（`/api/ai/activity`）に残り、共有先のユーザーが
AI セッションを開くとトンネルの所有者に通知されます。詳細は [docs/mcp.md](docs/mcp.md)。

### API ドキュメント

バックエンドは `/api/openapi.json` で OpenAPI 3 ドキュメントを、`/api/__hidden_swagger` で Swagger UI を
提供します。どちらもログインが必要です。ページは Web のログイン状態を再利用し（ログイン済みのブラウザで
開いてください。未ログインなら `/login` へ移動します）、仕様は Bearer トークン（`POST /api/auth/token` の
`access_token`）を要求します。「Try it out」は自動的にログインを引き継ぎ、**Authorize** で別のトークンを
使って試すこともできます。仕様は実際のルートから生成される（`utoipa`）ため、常にサーバーと一致します。
`telepy-server openapi` で CLI からも同じドキュメントを出力できます。`OPENAPI_ENABLED=false` で両方とも
無効化できます。

## CLI ヘルパー

`./telepy.sh` は日常のメンテナンススクリプトをまとめたラッパーです：

```
Usage: ./telepy.sh sub-command [args]
Sub-commands:
  keygen: Generate SSH host keys (gateway) and the backend service key.
  create-superuser: Create an admin account for Telepy management.
  shell: Open a shell in the backend container.
  migration: Reconcile the database schema (also runs automatically on start).
  backend-debug: Recreate the backend container and follow its logs.
```

## 参考資料

- [リモートブラウザのアーキテクチャ](./docs/remote-browser.md)
- [レイテンシ計測の詳解](./docs/latency-deep-dive.md)
- [バックエンドベンチマーク：Django vs Rust](./docs/benchmarks.md)
- [記事](./docs/articles/)

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

[MIT](./LICENSE)
