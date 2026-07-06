# Telepy

[English](./README.md) | [繁體中文](./README.zh-TW.md) | **日本語**

**リバース SSH トンネル**を管理するセルフホスト型 Web プラットフォームです。デバイスを一度登録すれば、どこからでもアクセスできます。ライブダッシュボードでトンネルの状態を監視し、ブラウザからターミナルを開き、SFTP でファイルを管理し、チームメンバーとアクセス権を共有し、さらにはリモートデバイス「経由」で Web ブラウジングまで行えます。

## 特徴

- **トンネルダッシュボード** — オンライン／オフライン状態と区間ごとのレイテンシ（あなた → Telepy → デバイス）をリアルタイム表示。リスト／カード表示に対応。
- **ガイド付きトンネル作成** — 5 ステップのウィザードが鍵を発行し、すぐに実行できる接続スクリプトを生成します：SSH、AutoSSH、systemd サービス、PowerShell、Docker Run、Docker Compose。対象マシンでスクリプトを取得するためのワンタイム `curl` URL も発行できます。
- **Web ターミナル** — WebSocket 上で動作する xterm.js のマルチタブターミナル。ユーザーごとのセッションとレイテンシ表示に対応。
- **ファイルマネージャー** — ターミナル横の SFTP ファイルブラウザで、デバイス上のファイルをアップロード／ダウンロード。
- **リモートプロキシブラウザ** — 本物の Chromium デスクトップ（KasmVNC）を起動し、トラフィックを対象デバイス経由でトンネリング。外部へのリクエストはそのマシンから発信されたように見えます。
- **共有と権限** — VIEW / EDIT / ADMIN の階層的な権限で、他のユーザーとトンネルを共有。
- **鍵とログ** — authorized keys の管理と SSH サーバーログの閲覧を UI から行えます。
- **認証** — Google OAuth2 またはユーザー名／パスワード、JWT ベースの API。最初にログインしたユーザーがスーパーユーザーになります。
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

デバイスは Telepy の SSH コンテナへリバース SSH 接続（`ssh -NR <port>:localhost:22 telepy@server`）を維持し、各トンネルには専用ポートが割り当てられます。Web ターミナル、ファイルマネージャー、プロキシブラウザはすべてこのポートを通じてデバイスへ到達します。デバイス側にインバウンドのファイアウォール設定やグローバル IP は不要です。

Telepy は Docker Compose で編成された 6 つのコンテナで動作します：

| サービス       | 役割                                                          |
| -------------- | ------------------------------------------------------------- |
| `traefik`      | リバースプロキシ。`/api/*` と `/ws/*` をバックエンドへ、それ以外をフロントエンドへルーティング |
| `frontend`     | Next.js 製の Web UI                                           |
| `backend`      | Django + DRF + Channels（REST API と WebSocket ターミナル）   |
| `redis`        | キャッシュとチャネルレイヤー                                  |
| `ssh`          | リバーストンネルを終端する OpenSSH サーバー                   |
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
| `DEBUG`                   | `false`     | Django のデバッグモード                    |
| `WEB_SERVER_PORT`         | `8787`      | Traefik が Web UI を公開するポート         |
| `REVERSE_SERVER_SSH_PORT` | `24242`     | デバイスがリバース SSH で接続するポート    |
| `SOCIAL_GOOGLE_CLIENT_ID` | —           | Google OAuth クライアント ID               |
| `SERVER_DOMAIN`           | `localhost` | Telepy サーバーの公開ホスト名              |
| `INTERNAL_API_TOKEN`      | —           | 内部サービス間通信用のシークレット         |

## CLI ヘルパー

`./telepy.sh` は日常のメンテナンススクリプトをまとめたラッパーです：

```
Usage: ./telepy.sh sub-command [args]
Sub-commands:
  keygen: Generate SSH keys for Telepy service.
  create-superuser: Create an admin account for Telepy management.
  shell: Create a shell to run arbitrary command.
  ipython: Create a shell to run ipython.
  supervisorctl: Attach to supervisor control shell.
  ssh-shell: Similar to 'shell', but for ssh container.
  migration: Run migration process.
  backend-debug: Recreate and attach to backend container.
  collect-static: Collect static files to increase rendering speed.
  django-startapp: Create a new Django app.
```

## API ドキュメント

ログイン後、以下にアクセスしてください：

- Swagger UI — `http://localhost:<WEB_SERVER_PORT>/api/__hidden_swagger`
- ReDoc — `http://localhost:<WEB_SERVER_PORT>/api/__hidden_redoc`
- Django admin — `http://localhost:<WEB_SERVER_PORT>/api/__hidden_admin/`

## 参考資料

- [リモートブラウザのアーキテクチャ](./docs/remote-browser.md)
- [レイテンシ計測の詳解](./docs/latency-deep-dive.md)
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
