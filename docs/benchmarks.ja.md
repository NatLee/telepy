# バックエンドのベンチマーク：Django 対 Rust

<p align="center"><a href="./benchmarks.md">English</a> | <a href="./benchmarks.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

> [!NOTE]
> これは 2026-10-22 のスナップショットです。Rust バックエンドへの切り替え（#88–#91）の直後に測定し、#94 で追加しました。この移行の前後比較であり、現在の測定値ではありません。
>
> その後 Django 版はリポジトリから削除され、Telepy も変わり続けています。Compose は現在 5 つのコンテナを動かし、リモートデスクトップ用に guacd が加わりました。Web ターミナルは OpenSSH クライアントを起動する代わりに、トンネルとアカウントごとに 1 本のプール済み接続の上で russh の PTY チャネルとして動きます。移行の計画は [`rust-migration-plan.md`](engineering/rust-migration-plan.md) にあります。

同じマシン、同じデバイスで、2 つのバックエンドを並べて動かしました。ほぼすべての行で Rust が勝っています。例外は 2 つです。1 つはターミナルの最初の出力で、どちらもデバイスとの同じ SSH ハンドシェイクを待っています（デバイスのほうは、誰が何の言語で待っていようと知ったことではありません）。もう 1 つは Traefik 経由の p99 で、下に専用の節があります。

## 測定環境

- **バージョン**：Django は `a622634`、Rust は `main` @ `464d207`。
- **マシン**：Apple Silicon のマシン 1 台、10 コア、24 GB、OrbStack 経由の Docker。測定日は 2026-10-22。
- **並べて実行**：2 つのスタックを別々の worktree から同時に動かし、それぞれ専用のポートとデータディレクトリを使いました。
- **デバイス**：`linuxserver/openssh-server` コンテナ 1 つ。両方のトンネルをこの同じデバイスにつないでいます。
- **数値**：記載した実行回数の中央値です。生の出力は、このファイルを追加した PR（#94）にあります。

## 結果

### デバイスとトンネル

| 指標 | Django | Rust | 変化 |
|---|---|---|---|
| デバイスの SSH 認証（接続 → `Authenticated to`） | 54 ms | 12 ms | 4.5 倍高速 |
| デバイス接続 → ダッシュボードにオンライン表示 | 2.90 s | 0.16 s | 18.1 倍高速 |
| 接続中のデバイス 1 台あたりのプロセス | sshd 2 つ + 3〜15 秒ごとのサンプリングスクリプトのサブプロセス | 0（tokio タスク 1 つ） | — |

### HTTP API、バックエンドに直接

| リクエスト | Django | Rust | 変化 |
|---|---|---|---|
| `GET /api/reverse/server/dashboard`、同時 50 | 561 req/s、p50 84 ms、p99 235 ms | 4726 req/s、p50 10 ms、p99 27 ms | スループット 8.4 倍、p99 は 8.7 倍低い |
| `GET /api/auth/user/profile`、同時 50 | 943 req/s、p50 50 ms、p99 105 ms | 5727 req/s、p50 8 ms、p99 26 ms | スループット 6.1 倍 |
| `GET /api/reverse/server/dashboard`、同時 200 | 350 req/s、p50 546 ms、p99 895 ms | 4470 req/s、p50 32 ms、p99 78 ms | スループット 12.8 倍 |

### Web ターミナル

| 指標 | Django | Rust | 変化 |
|---|---|---|---|
| スループット（40 MB の base64 ストリームを PTY に通す） | 35.1 MB/s | 96.9 MB/s | 2.8 倍 |
| 認証後から最初の PTY 出力までの時間 | 103 ms | 123 ms | ほぼ同じ（デバイスとの ssh ハンドシェイクが大半） |

### 起動とリソース

| 指標 | Django | Rust | 変化 |
|---|---|---|---|
| コールドスタート（`compose up --force-recreate backend` → `/api/auth/setup-status` が応答） | 14.2 s（各回：14.2、24.9、13.6） | 0.7 s（各回：1.69、0.71、0.49） | 20.1 倍高速 |
| メモリ、アイドル時（backend + redis + ssh コンテナ vs backend のみ） | 329 MiB | 20 MiB | 16.5 倍小さい |
| メモリ、負荷とターミナルの実行後 | 341 MiB | 23 MiB | 14.8 倍小さい |
| コンテナ数 | 6（traefik、frontend、backend、redis、ssh、kasm-browser） | 4 | — |

## Traefik 経由（ブラウザから見える値）

`ab` はリクエストごとに新しい HTTP/1.0 接続を開きます。Traefik 経由で同時 50〜200 接続にすると、どちらのスタックでも約 1 秒の外れ値がときどき出ます。accept キューが一時的に満杯になり、SYN が再送されるためです。速い側のスタックでは p99 がこの外れ値で決まるので、下の表の Rust の p99 はちょうど 1 秒前後になっています。

同時 50 での 3 回の中央値です。

| エンドポイント | Django | Rust |
|---|---|---|
| `/api/reverse/server/dashboard` | 268 req/s、p50 152 ms、p99 707 ms | 1340 req/s、p50 6 ms、p99 1006 ms |
| `/api/auth/user/profile` | 538 req/s、p50 83 ms、p99 203 ms | 1391 req/s、p50 6 ms、p99 1004 ms |

## 測定方法

- **デバイスの SSH 認証／フォワード**：デバイスのコンテナから `ssh -v -N -R '*:<port>:localhost:2222' telepy@host` を実行し、デバッグ出力の `Connecting to`、`Authenticated to`、`remote forward success` の各行でタイムスタンプを取りました。Django：sshd → `AuthorizedKeysCommand` → curl → `/api/reverse/internal/keys`。Rust：プロセス内の gateway、DB 検索。
- **ダッシュボードでオンライン**：ssh の開始から、`GET /api/reverse/server/dashboard` がそのポートを待ち受け中と報告するまでの時間です。Django：3 秒ごとの `ss` → Redis → リクエスト時に読み取り。Rust：フォワードの登録時にステータスを直接更新。
- **HTTP 負荷**：ApacheBench 2.3、`-n 2000 -c 50`（3 回）と `-n 5000 -c 200`、Bearer トークン付き。直接の測定には `-l` を付けています。「直接」とは、Compose ネットワーク内のコンテナから Traefik を通さずに `backend:8000` へリクエストすることです。
- **ターミナル**：WebSocket クライアントが `/ws/terminal/` で認証し、プロンプトを待ってから `head -c 40M /dev/zero | base64 -w0` を送り、終了マーカーまでに受信したテキストのバイト数を測りました。Django：PTY → asyncio reader → Channels。Rust：PTY → tokio → axum。
- **コールドスタート**：`docker compose up -d --force-recreate --no-deps backend` から、ヘルスチェックのエンドポイントが応答するまでです。Django は待ち受けを始める前に collectstatic と migrate を実行します。
- **メモリ**：`docker stats --no-stream` で、バックエンドの役割に属するコンテナを合計しました。

## 測っていないもの

- リモートブラウザ中継の CPU。実際の KasmVNC セッションとブラウザが必要です。
- 多数のデバイスでの規模。今回使ったデバイスは 1 台だけです。

Django 時代の制約でもう 1 つ挙げておくと、旧スタックではコミットされていなかった 2 つの Django マイグレーション（`user_management`、`site_settings`）をコンテナ内で生成しないと、プロフィールのエンドポイントが動きませんでした。
