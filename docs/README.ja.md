# Telepy ドキュメント

<p align="center"><a href="./README.md">English</a> | <a href="./README.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

はじめての方は、まず[プロジェクトの README](../README.ja.md) で Telepy とは何か、どうインストールするかをご覧ください。以下のドキュメントはさらに詳しい内容で、どれも英語・繁体字中国語・日本語でそろっています。

## まず図で見る

[**図で見る Telepy**](./visual-guide.ja.md) には、アプリの情報ボタンの先にある図といくつかの録画をまとめています。デバイスの追加、ターミナル、ファイル、リモートデスクトップ、共有、コマンドルール、鍵、通知、CLI、サーバーの状態を扱っています。

## Telepy を使う

| ドキュメント | 内容 |
| --- | --- |
| [1 行のコマンドでデバイスを追加](./device-join.ja.md) | スクリプトが何をするか、対応デバイス、残るもの、失敗したときの対処 |
| [リモートデスクトップ](./remote-desktop.ja.md) | ブラウザで使う RDP・VNC・RustDesk：画質、クリップボード、音声、画面、ファイル |
| [リモートブラウザ](./remote-browser.ja.md) | デバイス側からネットに出る Chromium、その制限とトラブルシューティング |
| [コマンドラインと API トークン](./cli.ja.md) | インストール、サインイン、全コマンド、トークンにできること |
| [MCP](./mcp.ja.md) | MCP クライアントの接続と承認、エージェントにできること・できないこと |
| [Webhook](./webhooks.ja.md) | 個人用とサイト全体の Webhook：イベント、形式、署名、再試行 |

## 内部のしくみ

| ドキュメント | 内容 |
| --- | --- |
| [バックエンドがデバイスに接続する仕組み](./device-connections.ja.md) | 共有接続、ホスト鍵の確認、マシンの識別、2 つの接続方法（SSH と WebSocket） |
| [レイテンシの数字の出どころ](./latency-deep-dive.ja.md) | 各区間をどう測り、どう表示するか |
| [ベンチマーク：Django 対 Rust](./benchmarks.ja.md) | バックエンドを書き直したときの実測値 |
| [README のスクリーンショットの作り方](./screenshots/README.ja.md) | すべての画像の元になっているデモサーバー |

## エンジニアリングノート

書かれた当時のまま、繁体字中国語だけで残しているノートもあります。当時の見込み違いも、そのまま残してあります。

- [Rust バックエンド移行計画](./engineering/rust-migration-plan.md)
- RustDesk の調査：[最初の試作](./engineering/rustdesk-spike.md)と [Telepy を ID／リレーサーバーにする案](./engineering/rustdesk-id-server.md)
- [記事](./engineering/articles/)

上流の対応を待っている修正が 1 つあります。Dropbear クライアントを russh の厳格な鍵交換に通すためのものです（[issue #804](https://github.com/Eugeny/russh/issues/804)、[PR #805](https://github.com/Eugeny/russh/pull/805)）。

リリースノートは [GitHub Releases](https://github.com/NatLee/telepy/releases) にあります。
