# Telepy ドキュメント

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

Telepy とは何か、どうインストールするかは、まず[プロジェクトの README](../README.ja.md)をご覧ください。以下のドキュメントでは
さらに詳しく説明します。どれも英語・繁体字中国語・日本語で用意されています。

## まず図で見る

- **[図で見る Telepy](./visual-guide.ja.md)** — アプリの情報ボタンの先にある図と、いくつかの録画：デバイスの追加と削除、
  ターミナル、ファイル、リモートデスクトップとブラウザ、共有、コマンドルール、キーと SSH 設定、通知、CLI・API・MCP、
  サインイン、サーバーの状態。

## Telepy を使う

| ドキュメント | 内容 |
| --- | --- |
| [1 行コマンドでのデバイス追加](./device-join.ja.md) | 追加スクリプトの動作、対応デバイス（Linux、macOS、OpenWrt）、残るもの、診断のしかた |
| [リモートデスクトップ](./remote-desktop.ja.md) | guacd 経由の RDP / VNC とブラウザ内の RustDesk：画質、表示、クリップボード、サウンド、画面、ファイル、保存したログイン |
| [リモートブラウザ](./remote-browser.ja.md) | KasmVNC 上の Chromium で、通信はデバイスから出ていきます。セッション、制限、トラブルシューティング |
| [`telepy` コマンドラインと API トークン](./cli.ja.md) | インストールとサインイン、全コマンド、トークンとスコープ、呼び出しログ |
| [MCP](./mcp.ja.md) | MCP クライアントの接続、承認フロー、ツール、対話シェル、ブラウザ、コマンドルール、監査 |
| [Webhooks](./webhooks.ja.md) | 個人用とサイト全体の webhook、イベント、形式、署名、再試行、対象外 |

## 内部のしくみ

| ドキュメント | 内容 |
| --- | --- |
| [バックエンドがデバイスに届くしくみ](./device-connections.ja.md) | 共有接続、ポート、ホストキーの固定、マシンの識別、トンネルごとのサービスキー、TCP / WebSocket / PROXY protocol、インストール名 |
| [レイテンシの数字の出どころ](./latency-deep-dive.ja.md) | 各区間の往復時間をどう測り、どう表示するか |
| [ベンチマーク：Django 対 Rust](./benchmarks.ja.md) | バックエンド書き換えの実測値 |
| [README のスクリーンショットの作り方](./screenshots/README.ja.md) | これらのドキュメントの図の元になっているデモサーバー |

## エンジニアリングノート

書かれた当時のまま繁体字中国語で残してあります：[Rust バックエンド移行計画](./rust-migration-plan.md)、
RustDesk の調査（[spike](./rustdesk-spike.md)、[ID / リレーサーバー](./rustdesk-id-server.md)）、
[Dropbear 向け russh strict-kex パッチ](./russh-dropbear-strict-kex.patch)、そして[記事](./articles/)。

リリースノートは [GitHub Releases](https://github.com/NatLee/telepy/releases) にあります。
