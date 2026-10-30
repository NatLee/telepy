# バックエンドのベンチマーク：Django (a622634) vs Rust (main @ 464d207)

<p align="center"><a href="./benchmarks.md">English</a> | <a href="./benchmarks.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

> **ステータス：** 2026-10-22 のスナップショットで、Rust バックエンドへの切り替え（#88–#91）の直後に測定し、#94 で追加したものです。この移行の前後比較であり、現在の測定値ではありません。Django 版はリポジトリから削除され、Telepy もその後変化しています（compose ファイルは現在 5 つのコンテナを実行し、リモートデスクトップ用に guacd が加わりました。Web ターミナルは OpenSSH クライアントを起動する代わりに、トンネルとアカウントごとに 1 本のプール済み接続上で russh の PTY チャネルとして動作します）。この移行の計画は [`rust-migration-plan.md`](rust-migration-plan.md) にあります。

2026-10-22 に 1 台のマシン（Apple Silicon、10 コア、24 GB、OrbStack 経由の Docker）で測定しました。2 つのスタックを別々の worktree から、それぞれ専用のポートとデータディレクトリで並べて動かし、デバイスには `linuxserver/openssh-server` コンテナを 1 つ使い、両方のトンネルを同じデバイスにつないでいます。数値は記載した実行回数の中央値で、生の出力はこのファイルを追加した PR（#94）にあります。

## 概要

| 指標 | Django | Rust | 変化 |
|---|---|---|---|
| デバイスの SSH 認証（接続 → `Authenticated to`） | 54 ms | 12 ms | 4.5 倍高速 |
| デバイス接続 → ダッシュボードにオンライン表示 | 2.90 s | 0.16 s | 18.1 倍高速 |
| `GET /api/reverse/server/dashboard`、同時 50、バックエンドに直接 | 561 req/s、p50 84 ms、p99 235 ms | 4726 req/s、p50 10 ms、p99 27 ms | スループット 8.4 倍、p99 は 8.7 倍低い |
| `GET /api/auth/user/profile`、同時 50、バックエンドに直接 | 943 req/s、p50 50 ms、p99 105 ms | 5727 req/s、p50 8 ms、p99 26 ms | スループット 6.1 倍 |
| dashboard、同時 200、直接 | 350 req/s、p50 546 ms、p99 895 ms | 4470 req/s、p50 32 ms、p99 78 ms | スループット 12.8 倍 |
| Web ターミナルのスループット（40 MB の base64 ストリームを PTY に通す） | 35.1 MB/s | 96.9 MB/s | 2.8 倍 |
| Web ターミナル、認証後から最初の PTY 出力までの時間 | 103 ms | 123 ms | ほぼ同じ（デバイスとの ssh ハンドシェイクが大半） |
| コールドスタート（`compose up --force-recreate backend` → `/api/auth/setup-status` が応答） | 14.2 s（各回：14.2、24.9、13.6） | 0.7 s（各回：1.69、0.71、0.49） | 20.1 倍高速 |
| メモリ、アイドル時（backend + redis + ssh コンテナ vs backend のみ） | 329 MiB | 20 MiB | 16.5 倍小さい |
| メモリ、負荷とターミナルの実行後 | 341 MiB | 23 MiB | 14.8 倍小さい |
| コンテナ数 | 6（traefik、frontend、backend、redis、ssh、kasm-browser） | 4 | — |
| 接続中のデバイス 1 台あたりのプロセス | sshd 2 つ + 3〜15 秒ごとのサンプリングスクリプトのサブプロセス | 0（tokio タスク 1 つ） | — |

## Traefik 経由（ブラウザから見える値）

`ab` はリクエストごとに新しい HTTP/1.0 接続を開きます。Traefik 経由で同時 50〜200 接続にすると、どちらのスタックでも約 1 秒の外れ値が時折発生し（accept キューが一時的に満杯になったときの SYN 再送）、速い側では p99 を左右します。同時 50 での 3 回の中央値です。

| エンドポイント | Django | Rust |
|---|---|---|
| `/api/reverse/server/dashboard` | 268 req/s、p50 152 ms、p99 707 ms | 1340 req/s、p50 6 ms、p99 1006 ms |
| `/api/auth/user/profile` | 538 req/s、p50 83 ms、p99 203 ms | 1391 req/s、p50 6 ms、p99 1004 ms |

## 測定方法

- **デバイスの SSH 認証／フォワード**：デバイスのコンテナから `ssh -v -N -R '*:<port>:localhost:2222' telepy@host` を実行し、デバッグ出力の `Connecting to`、`Authenticated to`、`remote forward success` の各行のタイムスタンプを取得。Django：sshd → `AuthorizedKeysCommand` → curl → `/api/reverse/internal/keys`。Rust：プロセス内ゲートウェイ、DB 検索。
- **ダッシュボードでオンライン**：ssh の開始から、`GET /api/reverse/server/dashboard` がそのポートを待ち受け中と報告するまでの時間。Django：3 秒ごとの `ss` → Redis → リクエスト時に読み取り。Rust：フォワード登録時にステータスを直接更新。
- **HTTP 負荷**：ApacheBench 2.3、`-n 2000 -c 50`（3 回）と `-n 5000 -c 200`、Bearer トークン付き。直接の測定には `-l` を付与。「直接」とは、compose ネットワーク内のコンテナから Traefik を迂回して `backend:8000` に対して実行することです。
- **ターミナル**：WebSocket クライアントが `/ws/terminal/` で認証し、プロンプトを待ってから `head -c 40M /dev/zero | base64 -w0` を送信、終了マーカーまでに受信したテキストのバイト数を測定。Django：PTY → asyncio reader → Channels。Rust：PTY → tokio → axum。
- **コールドスタート**：`docker compose up -d --force-recreate --no-deps backend` から、ヘルスチェックのエンドポイントが応答するまで（Django は待ち受け前に collectstatic と migrate を実行）。
- **メモリ**：`docker stats --no-stream`、バックエンドの役割に属するコンテナを合算。

未測定：リモートブラウザ中継の CPU（実際の KasmVNC セッションとブラウザが必要）、多数デバイスでの規模（デバイスは 1 台のみ）。Django 時代の制約でもう一点挙げておくと、旧スタックではコミットされていなかった 2 つの Django マイグレーション（`user_management`、`site_settings`）をコンテナ内で生成しないと、プロフィールのエンドポイントが動きませんでした。
