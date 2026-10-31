# Remote Browser (KasmVNC)

<p align="center"><a href="./remote-browser.md">English</a> | <a href="./remote-browser.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

> ユーザーがウェブ上で、通信が対象マシンの出口から出ていく本物の Chromium デスクトップを操作できるようにします。
> 本書は KasmVNC 版の**アーキテクチャ文書**です(2026-07-03 に移行完了。経緯は
> [`articles/2026-07-03-kasmvnc-migration-warstory.md`](engineering/articles/2026-07-03-kasmvnc-migration-warstory.md) を参照)。
>
> **現状(2026-10):** バックエンドは Rust の単一プロセスに書き直されました([`rust-migration-plan.md`](engineering/rust-migration-plan.md) を参照):
> - セッションストアはメモリ上にあります(小さなテーブル `telepy_remote_browser_session` を別に持ちますが、これは再起動後に kasm 側の孤立セッションを片付けるためだけのものです)。
>   gunicorn のマルチワーカーも Redis もありません。
> - SOCKS プロキシは**プロセス内**で動きます(`ssh/socks.rs`)。CONNECT 1 本ごとに、コネクションプール上のデバイス接続に direct-tcpip チャネルを 1 本開き、
>   デバイスの sshd が接続先へ出ていきます。以前の `ssh -D` と同じ仕組みですが、子プロセスは起動しません。
> - KasmVNC、Chromium、session-manager、WS ハンドシェイク、ボット検出対策のフラグは変わっていません。
>
> 「歴史」と書かれた段落は Django 版の `ssh -D` / Redis / gunicorn の話で、設計の経緯として残しているだけです。

## アーキテクチャ概要

```
Browser (vendored KasmVNC noVNC-fork client)
   │  wss /ws/remote-browser/<session_id>/ (JWT は最初のメッセージで認証)
   ▼
backend ws/remote_browser.rs (Rust)
   │  1. JWT(最初のメッセージ)+ 機能権限 remote_browser(4012)+ トンネルの VIEW 権限を検証(session の server_id で再確認)
   │  2. WS↔WS の透過リレー(メッセージ単位で転送し、プロトコルは解析しない)。ws::Heartbeat が 20 秒ごとに Ping、40 秒応答がなければ相手が去ったとみなす
   ▼
kasm-browser コンテナ :<ws_port> (KasmVNC websocket、Basic Auth)
   ├─ Xkasmvnc :N (セッションごとに 1 display。ws_port = 8443 + N)
   ├─ openbox + chromium (respawn ループで包む。セッションごとに専用の一時プロファイル)
   └─ session-manager (:7000、X-Internal-Token で守られた HTTP API)

chromium --proxy-server=socks5://backend:<port> --proxy-bypass-list='<-loopback>'
   ▲
   └─ backend プロセス内の SOCKS5 (ssh/socks.rs、CONNECT のみ・認証なし、ポートは docker ネットワーク内だけ)
      CONNECT 1 本 = プール上のデバイス接続に開く direct-tcpip。デバイスの sshd が接続先へ出る = 出口 IP
      (localhost/127.0.0.1 もここ経由で対象マシンに届く。下の --proxy-bypass-list の説明を参照。
       名前の接続先は先に ssh::resolve を通す。macOS の sshd は名前への direct-tcpip を受け取ると接続ごと切れるため)
```

- **なぜ raw-RFB の TCP ではなく WS↔WS なのか:** KasmVNC は RFB 仕様から外れており、
  websocket しか開かず従来の VNC ポートは開きません。また**標準の noVNC では接続できず**(画面が真っ黒になります)、
  KasmVNC 独自のフォーク版クライアントが必要です(vendor 済み。下記参照)。
- **ハンドシェイクの順序**(VNC はサーバーが先に話すので、greeting を取りこぼせません): フロントエンドが `auth` を送る →
  バックエンドが上流に接続して `ready` を返す → フロントエンドが同じ WS を RFB クライアントに渡して `begin` を返す →
  そこで初めてバックエンドが上流のバイト列を流し始めます。
- **chromium に `--proxy-bypass-list='<-loopback>'` が必要な理由:** chromium は loopback
  宛て(`localhost` / `127.0.0.1/8` / `::1` / `*.localhost`)に対して、**「常に直結し、プロキシを通さない」という暗黙のルールを内蔵**しています。このフラグがないと、
  プロキシ経由のブラウザで `http://localhost:PORT` を入力したとき、chromium は kasm-browser **コンテナ自身**の loopback(中身は空)へ**直結**してしまい、
  対象マシンには届きません。「プロキシブラウザが対象マシンとして完全には振る舞えず、localhost にすら届かない」という報告の原因がこれです。
  `<-loopback>` は chromium がこの暗黙の loopback バイパスを**取り除く**ために用意しているトークンで、
  取り除くと loopback 宛ては `--proxy-server` の SOCKS 経由で対象マシンへ送られ、
  対象マシン上で `connect(127.0.0.1:PORT)` が行われます(この SOCKS の出口は対象マシンの sshd なので、`127.0.0.1` = 対象マシン自身)。
  これでプロキシブラウザは、ローカルのサービスにも本当に「完全に対象マシンとして」アクセスできます。**シングルクォートは省けません:** `BROWSER_CMD` 全体は
  `open-browser.sh` の `sh -c "$BROWSER_CMD"` で**もう一度**シェルに解釈されるので、`<` / `>` を引用符で囲まないとリダイレクトの
  メタ文字として扱われます。通常のインターネット閲覧はこれまでどおりプロキシ(出口 IP)を通ります。`<-loopback>` が取り除くのは chromium の
  loopback **および link-local** に対する暗黙のバイパス(一式は `localhost` / `*.localhost` / `[::1]` /
  `127.0.0.1/8` / `169.254/16` / `[FE80::]/10`)で、これらの「ローカルアドレス」もプロキシ経由で対象マシンのネットワークへ向かいます
  (この用途では無害で、むしろ「対象マシンとして」の狙いどおりです)。VNC の転送(Xkasmvnc 自前の websocket。chromium の
  ネットワーク層とは無関係)には影響しません。

## コンポーネントマップ

| コンポーネント | 場所 | 役割 |
|---|---|---|
| REST start/stop/ping | `src/backend-api/src/api/remote_browser.rs` + `remote_browser/mod.rs` | プールのデバイス接続を借りる、プロセス内 SOCKS を開く(リトライ付き)、session-manager を呼ぶ、メモリ上のセッションストア(再起動後の回収用の小さなテーブル付き)、reaper |
| プロセス内 SOCKS5 | `src/backend-api/src/ssh/socks.rs` | CONNECT のみ。接続 1 本 = デバイス接続上の direct-tcpip(トランスポート lease で、セッションの枠は使わない) |
| session-manager クライアント | `src/backend-api/src/remote_browser/kasm.rs` | kasm-browser :7000 への HTTP クライアント(作成 / 停止 / CDP) |
| WS リレー | `src/backend-api/src/ws/remote_browser.rs` | JWT + 機能 + 権限、上流への接続(scheme/path の自動フォールバック付き)、双方向ポンプ、presence、ハートビート |
| エージェント / スクリプトが開くブラウザ | `src/backend-api/src/ai/browser.rs`、`mcp/`、`api/browser.rs` | MCP の `browser_*` ツールと REST `/api/browser/sessions*`(下の「MCP エージェントとスクリプト操作」を参照) |
| session-manager | `docker/kasm-browser/session_manager.py` | セッションごとに Xkasmvnc + openbox + chromium(respawn ループ、一時プロファイル) |
| CDP 中継 | `docker/kasm-browser/cdp.py` | session-manager が受けた操作を、コンテナ内 loopback 上の Chromium DevTools に渡す |
| フロントエンドのパネル | `src/frontend/src/components/tunnels/RemoteBrowserPanel.tsx` | ターミナルページの Browser のメイン画面(トンネル一覧の Browser ボタン)。ハンドシェイク、IME の textarea、クリップボード / IME / マウスの設定 |
| Vendored クライアント | `src/frontend/src/vendor/kasm-novnc/` | kasmtech/noVNC v1.3.0。**組み込みの要件はその README を参照(必読)** |

## KasmVNC 事実表(実測で確定済み。調べ直さないこと)

| 項目 | 値 |
|---|---|
| 標準の noVNC と互換? | **互換なし。** kasmtech/noVNC フォークを使う必要があります(サーバー 1.4.0 ↔ クライアント 1.3.0) |
| トランスポート | プレーンな ws(`-sslOnly` は既定でオフ)。エンドポイントは **`/websockify`**、サブプロトコルは `binary` |
| `Sec-WebSocket-Origin` | **必須**(Hixie 時代の legacy ヘッダーで、値は検証されません)。ないと 404 "failed websocket checks" が返ります(401 ではありません!) |
| Basic Auth | 既定でオン。`-disableBasicAuth` は 1.4.0 では効かない → `kasmvncpasswd` でユーザーを作り、接続時に `Authorization: Basic` を付ける |
| パスワードファイル | 固定パス `-KasmPasswordFile /etc/kasmvnc/kasmpasswd`(**`$HOME` に頼らないこと**: ビルド時と実行時で HOME が違い、常に 401 になる) |
| ws_port | `8443 + display`(`WS_BASE` で調整可) |

## セッションのライフサイクル

![リモートブラウザを段階的に起動](images/ja/browser-start.gif)

- **作成:** `POST /api/reverse/server/{id}/remote-browser/start` `{username?}`。機能権限 `remote_browser`、
  トンネルの VIEW、step-up(機密トンネル)、`username` が `permissions::allowed_usernames` に含まれること(省略 = トンネルの既定アカウント、なければ最初の
  許可アカウント)、`remote_browser_max_sessions` を確認 → プールのデバイス接続を借り、プロセス内 SOCKS を開く → session-manager が
  Xkasmvnc/openbox/chromium を起動 → セッションをメモリに入れる(あわせて `telepy_remote_browser_session` に 1 行書く)→ `{session_id, ws_path}` を返します。
- **SOCKS のコールドスタート / リトライ:** 1 回の試行 = `ssh::pool` からトランスポート lease を 1 つ借りる(同じ (トンネル, アカウント) のターミナルやファイルがすでにログイン済みならそのまま共有)
  + `SocksProxy::start`。全体は `remote_browser_ssh_timeout` が上限で、失敗したら `remote_browser_ssh_attempts` 回までリトライします
  (既定は 30 秒 / 2 回。設定名は `ssh -D` 時代のまま)。gateway にこのトンネルの forward がなければ(デバイスがオフライン)、待たずにすぐ失敗し、
  500 + `code: device_offline` を返します(フロントエンドが `browser.*` のメッセージに翻訳します)。
- **歴史(Django 版の `ssh -D`):** `username@reverse` は 2 ホップでした(ProxyCommand → telepy-ssh → デバイスの sshd への
  リバーストンネル)。`_spawn_socks_proxy` は強化したオプション(`BatchMode` / `ExitOnForwardFailure` /
  `ConnectTimeout` / `ServerAlive`。認証で無限に固まらないようにし、stderr を残すため `-q` は付けない)を使い、
  `start_remote_browser` は自動でリトライしました(既定 2 回、`remote_browser_ssh_attempts`)。
  本当にオフラインのデバイス(reverse ポートが存在しない)は待たずに即失敗します。失敗時は ssh の stderr が backend のログに書かれました。
- **歴史: その -D は `ControlMaster=no` + `ControlPath=none` が必須だった(痛い目に遭った実測。プロセス内 SOCKS にはこの問題はありません):** ssh config が
  `Host reverse` に `ControlMaster auto` + `ControlPersist` を設定していたため、コールドスタート時に ssh が**バックグラウンドの
  master** を fork してフォアグラウンドのクライアントをすぐ終了させ → `Popen.poll()` が「ssh が死んだ」と誤判定 → 1 回目の試行がいつも偽の失敗になりました
  (ログには `attempt 1/2 did not bind ... no stderr` が出続け、0.2 秒で諦める)。一方 master は少し遅れて
  -D をバインドし、**誰も管理しない孤立リスナー**になりました(実測で 16 時間生き続けた)。mux を無効にすると、その -D の寿命
  = その Popen となり、poll()/terminate() の意味が正しくなり、セッション同士も分離されます。ProxyCommand の最初のホップ
  (telepy-ssh)は引き続き自前の mux を使い、コールドスタートで遅くなるのは 2 ホップ目のハンドシェイクだけです(`remote_browser_ssh_timeout` で制御。
  遅いトンネルではサイト設定で大きくできます)。
- **プロファイル:** セッションごとに専用の `mkdtemp` ディレクトリを作り、**停止時に削除**します(履歴は残さない)。
  共有は絶対にしません。Chromium の SingletonLock のせいで、2 つ目の同時セッションの chromium が最初のセッションに処理を委譲して
  終了し(ログ: `Opening in existing browser session.`)、両方が失敗するためです。
  ブラウザプロセスの `HOME` もこのディレクトリを指します(dotfile などホームへの書き込みはセッションとともに削除されます)。
- **Chromium を閉じた / 最小化した / 消えた場合:** 最小化したウィンドウは**タスクバー**から戻せます。ウィンドウを閉じた場合(chromium プロセスは
  バックグラウンドモードで生きています)は、パネルの**「ブラウザを開く」ショートカット**(open-browser.sh)でもう一度開けます。このショートカットはまず
  既存のウィンドウにフォーカス / 復元を試み、ウィンドウがないときだけ新規起動します(バックグラウンドモードで残った本体プロセスも片付けるので、
  「Opening in existing browser session」と出るだけでウィンドウが開かない事態を避けられます)。**chromium プロセスが完全になくなった**場合(クラッシュ / 全終了)は、
  session-manager の**ウォッチドッグ**が 10 秒ごとに確認し(`--user-data-dir` で /proc を走査)、同じ
  open-browser.sh で自動的に再起動します(作成後 15 秒の猶予、再起動のクールダウン 30 秒。`REMOTE_BROWSER_RESPAWN=0` で無効化)。
  実際に、セッションに戻ったら空のデスクトップだけで、機能全体が壊れたと思ったユーザーがいました。セッションの意味はあのブラウザそのものです。
- **デスクトップからの起動経路はすべて open-browser.sh に集約:** openbox のルートメニュー(デスクトップの右クリック)はカスタムの
  `openbox-menu.xml` に差し替えました(Debian 既定メニューの「Web browser」= 素の `x-www-browser` → root だとサンドボックスなしで即終了し、
  ユーザーには「クリックしても何も起きない」としか見えません)。`BROWSER_CMD` は session-manager が環境変数として openbox/tint2/
  ウォッチドッグに渡し、さらに **display ごとの env ファイル** `/tmp/telepy-browser-<display>.env` も書き出します(セッション停止時に
  削除)。open-browser.sh は環境が失われているとき `$DISPLAY` でそのファイルを source するので、どの起動経路でも開けます
  (痛い目に遭った実測: 古い openbox は env を渡さず、デスクトップメニューからブラウザを開いたユーザーに `BROWSER_CMD not set` が出ました)。
- **ダウンロード:** Chromium の管理ポリシー(`/etc/chromium/policies/managed/telepy.json`)
  `DownloadRestrictions: 3` で**全面ブロック**します。コンテナ内でダウンロードしたファイルは、そもそもユーザーが受け取れず
  (取り出す経路がない)、コンテナのディスクを食うだけだからです。許可するなら、クォータとファイル取得の仕組みを併せて設計する必要があります。
- **停止:** WS が切れるとセッション全体を回収します(SOCKS プロキシ + lease の返却、kasm セッション、その 1 行の記録)。
  `POST /api/reverse/server/remote-browser/{sid}/stop`(パネルを閉じたとき、タブの `beforeunload`)も同じ経路で、reaper が最後の保険です。
  kasm 側のプロセスは `killpg(p.pid)` でグループごと終了させます(`start_new_session` ⇒ pgid == pid。`getpgid` は使わないこと。
  グループリーダーが先に死ぬと raise して、孤立プロセスを取りこぼします)。
- **生存更新とヘルスチェック:** WS が接続されている間は、リレー自身が 20 秒ごとに生存を更新し(サーバー側タイマーなので、バックグラウンドタブのスロットリングの影響を受けません)、フロントエンドのパネルも別に 15 秒ごとに
  `POST …/remote-browser/{sid}/ping` を呼びます。ping はまずそのセッションの SOCKS ポート(`127.0.0.1:proxy_port`)を調べ、**ポートが listen していなければ
  プロキシは死んでいる** → その場で回収して 404 を返し、フロントエンドはそれを受けて画面を閉じ「セッションは終了しました」と表示します。reaper は 10 秒ごとに確認し、下のデバイス接続が切れた場合
  (`SocksProxy::alive`)、または `remote_browser_session_idle_timeout` + 30 秒を超えて更新がない場合に回収します。
- **再起動後の孤立セッション:** プロセスは 1 つなので、再起動するとメモリ上のセッションとプロキシは失われます。起動時に `cleanup_orphans` が小さなテーブルに基づいて、kasm 側に
  残ったセッションをすべて停止し、記録を削除します。
- **歴史(gunicorn マルチワーカー + Redis):** SOCKS ポートの ping 確認は「全ワーカーが同じ netns を共有している」ことに頼っていました。アイドル GC は「Redis に記録があり、
  このプロセスのものではなく、ポートも listen していない」孤立セッション(所有ワーカーが再起動済みで、誰も ssh ハンドルを持っていない)も代わりに回収し、kasm セッションと Redis の記録を片付けました。
- **誰が使っているか、終了させられること:** WS リレーは presence に参加します(kind `browser`、使っているデバイスアカウント付き)。所有者 / ADMIN はトンネル一覧の使用中ボタンと
  ライブセッションページ(`/tunnels/sessions`)で確認でき、終了させられます(4009、reason = 誰が)。gateway イベント `browser_open` / `browser_close`
  (所要時間付き)がそのトンネルの Logs に書かれ、開始時には所有者と ADMIN(本人を除く)に `session.started` webhook が送られます。
- **権限を失うと終了:**(`access_recheck.rs`。ターミナル / ファイル / デスクトップと同じ仕組み)共有の解除、許可リストの縮小、機能 `remote_browser`
  のオフ、アカウントの無効化など → 4009、reason `Telepy (access changed)`。`browser_close` に理由が付き、本人には `SESSION-ENDED` が届きます。リレーは
  後片付けの際に kasm セッションも停止します。テストは `remote_browser_ends_when_access_is_lost`。
- **切断の検知:** リレーは `ws::Heartbeat` 経由でソケットを読みます(`WS_PING_INTERVAL_SECS` = 20 秒ごとに WebSocket Ping を送り、ping の後
  `WS_PEER_TIMEOUT_SECS` = 40 秒以内に何も受信しなければ相手が去ったとみなす)。そのため、ノート PC のスリープ、ネットワークの切り替え、プロキシの切断でセッションと presence が永遠に残ることはなくなりました。
- **ゾンビプロセス:** kasm-browser は `init: true`(tini)を PID 1 にして、親を失った孤立プロセスを回収します。
- **ウィンドウ:** openbox は `--config-file /app/openbox-rc.xml` で起動します(ビルド時に既定の
  rc.xml へ applications ルールをマージ)。`<decor>no</decor>` でタイトルバーを外し、`<maximized>true</maximized>` で
  display いっぱいに広げます。chromium 自身の `--start-maximized` は実測で 1050×720 にしかならず、余白とタイトルバーが残りました。
- **サンドボックス:** `--no-sandbox` は、コンテナ内で root として動かすうえでの必要悪です(Docker 既定の
  seccomp が unprivileged userns をブロックする)。`--test-type` は黄色い警告バーを抑えます。本物の
  サンドボックスにするには、compose でカスタム seccomp プロファイルをマウントする必要があります(未実施。隔離の境界 = コンテナ)。実測では `--test-type` は
  JS フィンガープリント(webdriver/chrome/languages/plugins/vendor)にまったく影響せず、警告バーもウェブページからは見えません。

## ボット検出対策(anti-detection)

本物の人間が VNC 経由で操作し、対象マシンの出口 IP を使うこと自体が、最強の検出回避条件です。フラグはあくまで上乗せです。

- `--disable-blink-features=AutomationControlled` → `navigator.webdriver = false`。
- 言語: `--lang` + `--accept-lang` で、空でなく一貫した言語を渡します(`navigator.languages` が
  空なのはボットの特徴です)。
- **`--accept-lang` には q 値を含まない、きれいな言語タグを渡すこと**(`_accept_lang` は `zh-TW,zh,en` を返す)。
  chromium はこの値から HTTP の `Accept-Language` ヘッダー **と** `navigator.languages` の両方を決め、
  ヘッダーの q 値は自分で計算します。こちらが先に q を入れてしまうと(昔のバグ):
  - `Accept-Language` ヘッダーが `zh-TW,zh;q=0.9,zh;q=0.9;q=0.8,en;q=0.8;q=0.7` と重なる(q が二重)
  - `navigator.languages` が `['zh-TW','zh;q=0.9','en;q=0.8']` になる(q が漏れる)

  どちらも本物のブラウザには絶対に現れない決定的な特徴で、あちこちで CAPTCHA が出ます。きれいなタグなら、ヘッダーは正しく
  `zh-TW,zh;q=0.9,en;q=0.8`、`navigator.languages` は `['zh-TW','zh','en']` になります。
- **WebGL(`--enable-unsafe-swiftshader`。**これだけ**)**: コンテナには GPU がなく、GPU のない X display 上の headed chromium は
  GPU の初期化に失敗し → `canvas.getContext("webgl")` が **null** を返します(実測)。「WebGL がまったく
  ない」のは強いボットの特徴です(YouTube の「ログインしてボットでないことを確認」が調べます)。`--enable-unsafe-swiftshader`
  は WebGL コンテキストだけを SwiftShader にフォールバックさせ、コンポジタには触れないので → WebGL が正常に動きます(`OK ANGLE (SwiftShader...)`)。
  **踏んだ地雷:** WebGL を確実にしようと `--use-gl=angle --use-angle=swiftshader` を加えたところ、GL の**コンポジタ**全体まで
  ソフトウェアの SwiftShader に強制され → **YouTube の動画が再生できなくなりました**。実測(実際の VP9 デコード、640x480): swiftshader 強制は
  4 フレーム落ち、`--enable-unsafe-swiftshader` 単独とベースラインはどちらも 0 フレーム落ちで、単独でも WebGL は同様に正常でした。720p/1080p
  では強制版のフレーム落ちが再生不能なほどひどくなります。**結論: `--enable-unsafe-swiftshader` だけを残し、`--use-gl` は絶対に加えない。**
  補足: renderer は SwiftShader(本物の GPU ではない)と表示され、これは依然として弱いシグナルです。もっと実機らしくするには、クライアント側で
  `getParameter` の renderer 文字列を偽装する必要があります(未実施)。

### 限界(正直な説明)

フラグが扱うのは**ブラウザのフィンガープリント**だけです。YouTube のようなブロックを左右するのは別の 2 つの要因で、フラグでは解決できません。

1. **出口 IP の評判**: トラフィックは対象マシンの IP から出ます(デバイスの sshd 経由の SOCKS)。対象マシンがデータセンター / クラウド / VPN の IP である場合や、その IP が
   大量の自動アクセスで汚れている場合、YouTube/Cloudflare は即座にブロックします。**ブラウザのフィンガープリントとは完全に無関係**です。回避するには
   住宅 IP の対象マシンに替えるしかありません。
2. **cookie / ログインの信頼がない**: プロファイルはセッションごとに真っさらです(プライバシー要件。履歴は残さない)。YouTube は、ログイン済みや
   閲覧履歴のあるセッションをはるかに信頼します。真っさらなセッションは、生まれつき認証を求められやすいのです。これは「履歴を残さない」と
   正面から衝突します。

   > **決定済み(2026-07-04): セッションごとに真っさらなプロファイルを維持し、プライバシーを優先する。** 「YouTube にログインを求められる」
   > 退行が出ましたが、調査の結果、原因は 967ea75(プロファイルを ephemeral にした変更)でした。cookie が溜まらないため、YouTube は毎回を
   > 怪しい新規訪問者として扱います。折衷案として「cookie / ログインだけ永続化し、閲覧履歴は残さない」も考えられますが、ユーザーはプライバシー優先を選び、
   > ときどきログインを求められることを受け入れました(そもそも決め手は出口 IP です)。**今後ブロックを減らしたいなら、プロファイルをいじるより先に、住宅 IP の
   > 対象マシンに替えてください。** ユーザーの同意なしに、プロファイルの永続化を戻してはいけません。

## MCP エージェントとスクリプト操作(CDP)

MCP エージェント(scope `browser:use`)は、ブラウザを自分で開いて操作できます。[`mcp.md`](mcp.md) を参照してください。同じ操作の REST 版
`/api/browser/sessions*` もあります(`api/browser.rs`: 開く `{tunnel_id, username?, url?}`、`navigate`、`text?selector=`、`screenshot`(image/png)、
`click`、`type`、`DELETE`、一覧)。個人 API トークン(scope `browser:use`)、`telepy browse` コマンド([`cli.md`](cli.md) を参照)、ウェブのサインインから使えます。
いずれも通常の remote-browser セッションです(同じ SOCKS、同じ kasm セッションで、`remote_browser_max_sessions` にも数えられます)。
違いは、VNC で接続している人がいないことだけです。

- ブラウザは、それを開いた認証情報(OAuth アプリ、API トークン、ウェブのサインイン)に属します。エージェントの SSH セッションと合わせて
  `ai_max_sessions_per_user` に数えられ、アイドル / 寿命 / 取り消し / 権限の喪失 / デバイスのオフラインは `crate::ai` の reaper が回収します(ルールには OAuth grant が含まれ、上の access recheck は通りません。同じトリガーから `ai::recheck` も呼ばれ、すぐに 1 回実行されます)。
- presence kind は `browser`、client = アプリ名で、ライブセッションページに表示され、終了させることもできます(以降の操作は「誰に終了されたか」を返します)。
  開閉は `browser_open` / `browser_close` イベントに書かれ、操作ごとに AI 監査が書かれます(`browser_type` のテキストは、`sensitive: false` でない限り長さだけを記録します)。
- step-up のトンネルは常に拒否されます(403 `step_up_refused` / tool error)。機能 `remote_browser` をオフにすると、開くことも操作することもできません(一覧と終了は従来どおり使えます)。

```
MCP tool (browser_navigate / read / click / type / screenshot) または REST /api/browser/sessions/{id}/…
  → backend ai/browser.rs → remote_browser::RemoteBrowser::cdp
  → session-manager POST /sessions/<id>/cdp (X-Internal-Token)
  → cdp.py → ws://127.0.0.1:<CDP_BASE + display> (chromium --remote-debugging-port、コンテナ内 loopback のみ listen)
```

- DevTools のポートはコンテナ内の 127.0.0.1 だけにあり、backend が CDP に直接接続することはありません。1 操作あたりの上限は 30 秒です(`CDP_ACTION_TIMEOUT`)。
- 操作: `navigate`(http / https のみ。コンテナ自身のファイルを読まれないよう、バックエンドでも `file:` などは拒否します)、`screenshot`(CDP の clip.scale で
  幅 1280 px 以下に縮小)、`read`(innerText + リンク。selector 指定可)、`click`(selector または見えているテキスト。本物のマウスイベント
  `Input.dispatchMouseEvent`)、`type`(focus + `Input.insertText`。Enter も押せます)。
- 操作対象のタブ = `/json/list` の最初の通常のウェブページ。すべて閉じられている場合は `about:blank` を 1 つ開きます。
- `cdp.py` は標準ライブラリだけを使います(最小限の WebSocket クライアントを内蔵)。テストは `tests/test_cdp.py` にあります。

## WS クローズコード(`/ws/remote-browser/<sid>/`)

| コード | 意味 |
|---|---|
| 4000 / 4001 | 最初のメッセージの認証失敗(形式 / トークン) |
| 4007 | サイトが 2 段階認証を必須にしているが、このアカウントは未設定 |
| 4012 | 機能 `remote_browser` がこのユーザーに対してオフ(reason = 機能 id) |
| 4404 | セッションが存在しない(またはまだ準備できていない) |
| 4403 | このトンネルの VIEW 権限がない |
| 4011 | kasm-browser の KasmVNC websocket に接続できない |
| 4013 | 上流(KasmVNC)が閉じた、または書き込めない |
| 4009 | ライブセッションページから終了された、または権限を失った(reason = 誰が / `Telepy (access changed)`) |
| 4010 | このブラウザのウェブサインインがサインアウトされた(reason = user / admin / logout / reuse / disabled) |

フロントエンドの `RemoteBrowserPanel` は、4403 / 4404 / 4011 / 4013 を `browser.*` の翻訳に対応づけます。

## サイト設定(Settings → リモートブラウザ)

| key | 既定値 | 説明 |
|---|---|---|
| `remote_browser_session_idle_timeout` | 60 | 更新がないまま何秒(さらに猶予 30 秒)でセッションを回収するか(秒) |
| `remote_browser_max_sessions` | 10 | サイト全体の同時上限(エージェント / スクリプトが開いたものを含む)。0 = 無制限 |
| `remote_browser_geometry` | `1280x720` | 各ブラウザデスクトップの解像度 |
| `remote_browser_ssh_timeout` / `remote_browser_ssh_attempts` | 30 / 2 | SOCKS プロキシを起動する 1 回ごとのタイムアウト(秒)と試行回数(名前は `ssh -D` 時代のまま) |
| `remote_browser_kasm_create_timeout` | 30 | session-manager が Xkasmvnc + chromium を起動し終えるのを待つタイムアウト(秒) |
| `remote_browser_homepage` / `remote_browser_language` | Google / `zh-TW` | ホームページ / 言語(次にブラウザを開いたときから有効。未入力なら kasm-browser の環境変数にフォールバック) |

## 環境変数(すべて既定値あり。通常は設定不要)

backend 側: `KASM_BROWSER_API`(既定 `http://kasm-browser:7000`、session-manager)、`KASM_BROWSER_HOST`(既定 `kasm-browser`、
KasmVNC websocket への接続に使用)、`INTERNAL_API_TOKEN`(backend → session-manager の `X-Internal-Token`)。kasm-browser コンテナと、双方で共有するもの:

| 変数 | 既定値 | 用途 |
|---|---|---|
| `KASM_WS_USER` / `KASM_WS_PASSWORD` | `telepy` / `telepyvnc` | KasmVNC の web 層の Basic Auth(backend が接続時に付け、kasm-browser のビルド時に作成。同じ .env で制御) |
| `KASM_WS_SCHEME` / `KASM_WS_PATH` / `KASM_WS_SUBPROTOCOL` | `ws` / `/websockify` / `binary` | 上流 ws で最初に試す値(バックエンドのリレーは他の組み合わせへ自動でフォールバックします) |
| `KASM_PASSWORD_FILE` | `/etc/kasmvnc/kasmpasswd` | パスワードファイルの固定パス |
| `REMOTE_BROWSER_HOMEPAGE` / `REMOTE_BROWSER_LANG` | Google / `zh-TW` | ホームページ / 言語(言語は navigator.languages に影響し、ボット検出対策にも関わる) |
| `REMOTE_BROWSER_PROFILE_TMP` / `WS_BASE` | `/tmp` / `8443` | 一時プロファイルの親ディレクトリ / ws ポートの基数 |
| `CDP_BASE` / `CDP_ACTION_TIMEOUT` | `9300` / `30` | MCP エージェント用の DevTools ポートの基数(ポート = `CDP_BASE + display`、127.0.0.1 のみ listen)/ 1 操作あたりの秒数上限 |

## トラブルシューティング

```bash
# バックエンドのテスト(実スタック):
(cd src/backend-api && cargo test)   # tests/remote_browser_api.rs を含む: SSH lab 上の本物のデバイス(プロセス内 SOCKS)+ 偽の session-manager + 偽の KasmVNC ws によるエンドツーエンド。tests/socks_e2e.rs は SOCKS 自体をテスト
# session-manager のテスト(標準ライブラリのみ):
cd docker/kasm-browser && python3 -m unittest discover -s tests -p "test_*.py"

# 上流の ws に接続できない? 単独の Xkasmvnc + プローブスクリプトを起動する(セッションのように回収されない):
docker compose exec kasm-browser bash -lc \
  'Xkasmvnc :20 -geometry 1280x720 -depth 24 -SecurityTypes None \
   -KasmPasswordFile /etc/kasmvnc/kasmpasswd -websocketPort 8463 \
   -httpd /usr/share/kasmvnc/www -interface 0.0.0.0 & sleep 3'
docker compose cp dev-scripts/phase0_kasmvnc_probe.py kasm-browser:/tmp/probe.py
docker compose exec kasm-browser python3 /tmp/probe.py --port 8463 \
  --user telepy --password telepyvnc
```

- **Chromium が起動した直後に音もなく消える(SIGTRAP/exit 133。ウォッチドッグが 30 秒ごとに再生成するが、すぐまた死ぬ)** →
  Debian chromium 150.0.7871.46 のパッケージングのバグ([#1141488](https://bugs.debian.org/1141488)、2026-07):
  ungoogled 系のパッチが `{google:searchSource}` トークンの処理を削除したのに、組み込みの prepopulated Google
  検索テンプレートにはまだそのトークンが残っており → 展開した瞬間に `NOTREACHED()` で音もなく SIGTRAP します(`--v=1` でも FATAL は出ません)。
  このコンテナで発動する条件: **`--no-first-run` + 真っさらなプロファイルは必ずクラッシュ**(毎セッションが真っさらなプロファイルです!)、
  `--headless=new` もクラッシュし、ユーザーが既定の検索を組み込みの Google に戻して検索した場合もクラッシュします。適用済みの修正(以降の
  バージョンでも無害。修正版が出た後も残してよい): (1) `DEFAULT_BROWSER_CMD` から **`--no-first-run` を削除**(実測: Debian
  ビルドには first-run ウィザードがなく、効果ゼロで致命的なだけ。戻さないこと)、(2) chromium-policy.json の `DefaultSearchProvider*` で、既定の検索を**きれいなテンプレートの Google** に固定
  (`{searchTerms}` だけを使い、prepopulated テンプレートを経由しない。そのビルドの既定の DuckDuckGo も Google に戻し、クラッシュする
  組み込みの Google 項目への切り替えもロックします。**このポリシー群を削除しないこと**)。緊急の代替策: 
  149.0.7827.196-1~deb12u1 に固定し戻す(snapshot.debian.org 20260703T000000Z)方法もありますが、セキュリティ更新が止まるため推奨しません。
- `404 failed websocket checks` → `Sec-WebSocket-Origin` ヘッダーが欠けています(プローブもバックエンドのリレーも、すでに付けています)。
- `401` → 認証情報かパスワードファイルの問題です。`ls -l /etc/kasmvnc/kasmpasswd; wc -c` で空でないことを確認してください。
- ws はつながっているのにフロントエンドが真っ黒 → クライアントが Kasm フォークではないか、vendor README の組み込み要件
  (mouseButtonMapper、compositionend のリセット)が実施されていません。
- 生きているプロセスを調べるときは、`pgrep -f` が自分の外側のシェルのコマンドラインにもマッチする点に注意し、
  `ps ax | grep "[c]hromium"` という括弧のテクニックを使ってください。
