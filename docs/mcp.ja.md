# AI ツールからのアクセス（MCP）

<p align="center"><a href="./mcp.md">English</a> | <a href="./mcp.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

> Claude Code、Claude Desktop / claude.ai、Cursor など MCP に対応した AI ツールが、ユーザー自身の権限で Telepy を操作できるようにします。
> トンネルの状態の確認、**自動で閉じる** SSH セッションの作成、コマンドの実行、対話シェルによる TUI の操作、ファイルの読み書き、デバイス経由のリモートブラウザの起動ができます。
> 関連 issue：#93、#107。
> バックエンドのコード：`oauth/`、`api/oauth.rs`、`db/oauth.rs`、`auth/mcp.rs`（OAuth 2.1 と個人用 API トークン）、`mcp/`（MCP サーバー）、
> `ai/`（SSH セッションと reaper。`ai/shell.rs` は対話シェル、`ai/browser.rs` はエージェントのブラウザ）、`api/ai.rs`、`api/browser.rs`、
> `db/ai_audit.rs`（セッション一覧、REST 版、監査）。

## 接続方法

![スコープごとに MCP アプリが届く範囲](images/ja/agent-reach.png)

MCP のエンドポイントは `https://<あなたのホスト>/mcp`（Streamable HTTP）です。本番環境では `.env` に `PUBLIC_URL`
（例：`https://telepy.example.com`）を設定してください。OAuth の issuer も MCP の resource もこの値から決まります。未設定の場合は、リクエストの
`X-Forwarded-Proto` / `X-Forwarded-Host` / `Host` から導き出します。

| クライアント | 設定 |
| --- | --- |
| Claude Code | `claude mcp add --transport http telepy https://telepy.example.com/mcp` を実行し、その後、会話の中で `/mcp` を実行して認可を完了します |
| Claude Desktop / claude.ai | Settings → Connectors → Add custom connector で、URL に `https://telepy.example.com/mcp` を入力します |
| Cursor など | `mcp.json`：`{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp"}}}` |

トークンを手動で作る必要はありません。最初の呼び出しでクライアントが 401 を受け取り、以下の OAuth フローを自動で最後まで進めます。

ブラウザのないエージェントや CI では、**個人用 API トークン**（`tpt_…`、左サイドバーの **API** ページで作成）を Bearer として使えます。
`{"mcpServers": {"telepy": {"url": "https://telepy.example.com/mcp", "headers": {"Authorization": "Bearer tpt_…"}}}}`
`/mcp` では、トークンのツール、スコープ、トンネルの制限は OAuth アプリと同じです（その人の「API トークン」と「MCP アプリ」の両方の機能がオンである必要があります）。
そのセッション、シェル、ブラウザはそのトークンだけのものになり、監査上のアプリ名は `API token "<名前>"` です。ツール呼び出しは、AI の監査に加えて
API ページの「アクティビティ」にも記録されます（`MCP <tool>`。200、ツールがエラーを返したときは 400）。トークンを失効させると、開いているセッションはすぐに閉じます。同じ操作には
REST 版もあります：`/api/ai/sessions*`（コマンド）と `/api/browser/sessions*`（リモートブラウザ。後述）で、`telepy exec` / `telepy browse` はこれらを使っています
（[cli.ja.md](cli.ja.md) を参照）。

左サイドバーの **AI → MCP**（`/tunnels/mcp`）には、実際に入力するエンドポイントの URL（discovery の `resource` から取得するので、
`PUBLIC_URL` が反映されます）、上の表の 3 種類のクライアント向けにそのままコピーできる設定、各権限に対応するツール、セッションが閉じる条件、そして接続済みの MCP アプリが表示されます。
右上の「MCP アプリが届く範囲」ボタンで図が開きます。MCP アプリ ─ Telepy ─ デバイス ─ LAN / インターネットの順で、選んだ接続済みアプリの権限に応じて該当する枝が点灯します
（`lib/aiAccess.ts` の `reachFor`）。

## 認可フロー（OAuth 2.1）

```
MCP client ── POST /mcp ──────────────────────────────▶ 401 + WWW-Authenticate: Bearer resource_metadata="…/.well-known/oauth-protected-resource/mcp"
           ── GET /.well-known/oauth-protected-resource/mcp   （RFC 9728：authorization_servers）
           ── GET /.well-known/oauth-authorization-server     （RFC 8414：エンドポイント、S256）
           ── POST /api/oauth/register                        （RFC 7591 動的登録、公開）
           ── ブラウザを開く → /oauth/authorize（フロントエンドの同意ページ。未ログインなら先に /oauth/login へ。通常のログインページとは見た目が異なり、
                 ログイン前でも公開の GET /api/oauth/authorize/preview でアプリ、戻り先、権限を表示し、そのままキャンセルできる）
                 ユーザーは Web のログイン状態で承認する：アプリ名と戻り先、現在のアカウント（別のアカウントに切り替え可）を確認し、権限にチェックを入れ、使えるトンネルを制限する。
                 同じアプリの以前の接続は「置き換え」にチェックでき、クライアントが新しいトークンを受け取った時点で以前のものは失効する
                 フロントエンドが POST /api/oauth/authorize → {redirect_to: <redirect_uri>?code=…&state=…&iss=…}
           ── POST /api/oauth/token  (authorization_code + PKCE S256) → アクセストークン（1 時間）+ リフレッシュトークン（30 日、交換のたびにローテーション）
           ── POST /mcp  Authorization: Bearer <アクセストークン>
```

- 同意ページの権限（スコープ）：

  | スコープ | 許可する内容 |
  | --- | --- |
  | `tunnels:read` | `list_tunnels`、`tunnel_status`、`lan_hosts` |
  | `ssh:exec` | `ssh_session_open`、`ssh_exec`、`shell_open` / `shell_send` / `shell_read` / `shell_resize` / `shell_close` |
  | `ssh:files` | `ssh_session_open`、`sftp_list` / `sftp_read` / `sftp_write` |
  | `network:scan` | `lan_scan`（デバイスの背後の LAN をスキャン。自分が所有する、または ADMIN のトンネルのみ） |
  | `browser:use` | `browser_open` / `browser_navigate` / `browser_read` / `browser_screenshot` / `browser_click` / `browser_type` / `browser_close`（デバイス経由でネットに出る本物のブラウザ。同意ページでは「変更を加える」と表示） |

  ユーザーはどの項目のチェックも外せますし、アプリを一部のトンネルだけに制限することもできます。
- アクセストークンは `token_type: "mcp_access"` の JWT です。Web のトークンで `/mcp` は呼べません。REST API がこのトークンを受け付けるのは、トークンの許可リスト
  （`auth::api_tokens::ROUTES`。[cli.ja.md](cli.ja.md) を参照）にあるルートだけで、`telepy` コマンドラインのブラウザサインインはこの形で使っています。
- `/mcp` へのリクエストのたびに grant とユーザーを再確認します。そのため、**MCP ページ**、**環境設定 → MCP アプリ**、または AI アクティビティページの
  「あなたの MCP アプリ」で失効させると即座に無効になり、そのアプリが開いている SSH セッション、シェル、ブラウザもすぐに閉じます（管理者は「ユーザーを管理」ダイアログから
  誰のものでも失効できます）。
- アカウントが無効化されると、grant と個人用 API トークンは失効せず**一時停止**になります。`/mcp` は即座に拒否し、開いているセッションは閉じ、再度有効にすればそのまま使えます。
  管理者がその人の「MCP アプリ」機能をオフにすると、すべてのアプリが 401（失効したときと同様）を受け取り、開いているエージェントのセッションも終了します。機能をオンに戻せば復旧します。
- **`telepy login` は MCP アプリには数えません。** コマンドラインのブラウザサインインも同じ OAuth を通り（同意ページには CLI からの要求だと表示されます）、サインインのたびに
  `telepy CLI (<コンピューター名>)` として登録されます。これらの grant は API ページの「CLI のサインイン」タブ（`/tunnels/api?tab=cli`）に一覧され、MCP ページ、環境設定、
  AI アクティビティページの MCP アプリ一覧には表示されません。同じコンピューターでもう一度サインインすると、以前のものを置き換えるか確認されます。CLI のサインインは 1 人あたり最大 10 件まで保持され、11 件目では
  最も長く使われていないものがサインアウトされます。CLI のサインインも「MCP アプリ」機能のスイッチに従います（[cli.ja.md](cli.ja.md) を参照）。名前はクライアント自身の申告で、表示の分類にだけ使います。

## ツール

| ツール | 説明 |
| --- | --- |
| `list_tunnels` | 見えるトンネル：id、名前、オンラインかどうか、レイテンシ、自分の権限、使えるターゲットの username、このアプリが開いているセッション |
| `tunnel_status(tunnel_id)` | オンライン / 健全性（online / degraded = トンネルは生きているがデバイスの sshd が応答しない / offline）、レイテンシ、24 時間の稼働率、デバイスの基本情報 `facts`（OS、カーネル、稼働秒数、CPU、メモリ / ルートディスク（KB）、負荷、ssh のバージョン、再起動が必要か。デバイスにログインできる人にだけ返す）と `warnings`、直近 10 件のゲートウェイイベント |
| `ssh_session_open(tunnel_id, username?, idle_timeout_s?, max_lifetime_s?)` | セッションを開き `session_id` を返す。username を省略するとトンネルのデフォルトを使う（1 つだけなら自動で選ぶ） |
| `ssh_exec(session_id, command, timeout_s?, max_output_bytes?)` | コマンドを実行（TTY なし）：`exit_code`、`stdout`、`stderr`、`timed_out`、`truncated` |
| `ssh_session_list` | このアプリが開いているセッションと残り時間 |
| `ssh_session_close(session_id)` | セッションを閉じる |
| `sftp_list(session_id, path?)` | ディレクトリを一覧（`~` = ホームディレクトリ） |
| `sftp_read(session_id, path, offset?, max_bytes?)` | ファイルを読む。テキストは UTF-8、それ以外は base64 で返す。ページ分割可 |
| `sftp_write(session_id, path, content, encoding?, append?)` | ファイルを書く、または追記する（`encoding`：`utf-8` / `base64`） |
| `lan_hosts(tunnel_id)` | デバイスの背後の LAN ホスト（スキャンで見つかったものと手動で追加したもの）：アドレス、名前、開いているポート、SSH バナー、ラベル、ログインアカウント |
| `lan_scan(tunnel_id, username?, subnets?, ports?)` | デバイスの sshd 経由で LAN をスキャン（プライベートレンジのみ、最大 1024 アドレス、約 1 分）し、結果をホスト一覧に保存する。`network:scan` と所有者 / ADMIN の権限が必要 |
| `shell_open(session_id, cols?, rows?)` | セッション上で対話シェルを開く（PTY、`xterm-256color`、デフォルトは 120×40）。`shell_id` を返す。1 セッションにつき最大 2 つ |
| `shell_send(shell_id, input, press_enter?)` | 入力する：そのまま送る（制御文字も可。`\u0003` = Ctrl+C、`\u001b` = Esc）。`press_enter` で Enter を 1 つ追加する。1 回あたり 64 KiB まで |
| `shell_read(shell_id, timeout_ms?, max_bytes?, screen?)` | 読み取る：`output` = 前回以降の生の出力、`screen` = 現在の画面（vt100 モデル、1 行 1 行のプレーンテキスト）、`cursor`、`size`、`more`、`exited`。新しい出力がないときは最大 `timeout_ms` 待つ（デフォルト 1.5 秒、上限 10 秒）。読まれていない出力は最大 256 KiB まで保持する（超えると古いものから捨て、`dropped_bytes` を返す） |
| `shell_resize(shell_id, cols, rows)` / `shell_close(shell_id)` | サイズ変更 / 閉じる |
| `browser_open(tunnel_id, username?, url?, idle_timeout_s?, max_lifetime_s?)` | デバイス経由でリモートブラウザ（Chromium。通信はデバイスから出るので、デバイスの LAN、localhost、グローバル IP が見える）を開き、`browser_id` を返す。同時に `url` を開ける |
| `browser_navigate(browser_id, url)` | URL に移動（http / https のみ。省略時は `https://` を補う）。ページの読み込みを待ち、最終的な URL とタイトルを返す |
| `browser_read(browser_id, selector?)` | ページのテキスト：タイトル、URL、見えているテキスト（最大 10 万文字）、リンク。`selector` で一部だけ読める |
| `browser_screenshot(browser_id)` | PNG のスクリーンショット（幅 1280 px まで縮小）を MCP の image content block として返す |
| `browser_click(browser_id, selector? \| text?)` | CSS セレクターまたは見えているテキスト（リンク、ボタン、ラベル）でクリックする（本物のマウスイベント） |
| `browser_type(browser_id, selector, text, press_enter?, sensitive?)` | フィールドに入力する。Enter で送信もできる。`sensitive` のデフォルトは true = 監査には長さだけを記録する |
| `browser_close(browser_id)` | ブラウザを閉じる |

権限は Web のルールそのままです。そのトンネルの VIEW 権限が必要で、ターゲットの username は許可リストに含まれている必要があります（共有されたトンネルでは、共有時に許可された
username だけが使え、Web ターミナルと同じです）。さらに次のとおりです。

- **機能の権限**（管理 → ユーザーとアクセス → 機能の権限、`/tunnels/admin/access`）も適用されます。管理者がその人の機能をオフにすると、対応するツールはその旨のエラー（`isError`）を返します。
  `ssh:exec` のツールには「Web ターミナル」、`ssh:files` には「ファイルマネージャー」、`lan_hosts` と `lan_scan` には「LAN 探索」、`browser:use`
  には「リモートブラウザ」が必要です。スコープ自体が与えられていない場合、エラーはエージェントに、ユーザーに再接続してそのスコープを承認してもらうよう伝えます。
- **ステップアップが必要なトンネル**（セッションの前に毎回、ユーザーが第二要素で確認する必要があるもの）では、エージェントによる SSH セッション、ブラウザ、`lan_scan` の起動は拒否されます。
  `list_tunnels` の `requires_step_up` で、事前にエージェントへ知らせます。

### コマンドルール（`ssh_exec`）

![コマンドの判定：分解、サイト全体のルール、個人のルール、結果](images/ja/command-decision.png)

Web の「コマンドルール」ページ（`/tunnels/commands`）のルールは、エージェントのコマンドにも適用されます。ルールは 2 種類あります。

- **個人ルール**：各自が自分で書きます。対象が「全員」または「共有された人のみ」の場合、作者が**現在**オーナーまたは ADMIN であるトンネルでのみ有効です。
  「自分のみ」は作者自身のコマンドだけが対象で、作者が使うどのトンネルでも有効です。たとえば、他の人のトンネルで動かす自分の MCP エージェントへのガードとして使えます。
  「自分のみ」のルールは他の人には見えません。
- **サイト全体のルール**：管理者が書きます（管理エリアの「ルールと通知 → コマンドルール」）。デフォルトでは上書き可能で、トンネルのオーナー / ADMIN は自分が管理するトンネルでオフにできます。
  管理者が「ユーザーによる上書きを許可」をオフにすると強制となり、誰もオフにできません。

ルールは MCP エージェントだけを対象にもできます（`via: agents`）。1 つのコマンドが複数のルールに一致した場合は、ブロック > 承認が必要 > リマインドの順に優先されます。各アクションがエージェントに与える効果は次のとおりです。

- **ブロック**：実行せず、ツールはエラー（`isError`）を返します。内容にはどのルールか、そのルールの説明が書かれます。
- **承認が必要**：Telepy が承認リクエストを出します（承認者はルールで指定された人。指定がなければトンネルのオーナーと ADMIN。「自分のみ」のルールは作者本人です。
  Web アプリの右下に表示され、コマンドルールページでも処理できます）。このツール呼び出しは
  最大 45 秒待ちます。承認されれば通常どおり実行して結果を返し、拒否またはタイムアウトならエラーを返します。まだ誰も判断していない場合は「待機中」というエラーを返すので、エージェントからユーザーに伝えてもらい、
  承認後に**まったく同じコマンド**でもう一度呼び出してもらいます。承認は 10 分以内に 1 回だけ使えます（同じアプリ、トンネル、アカウント、コマンドの場合）。
- **リマインド**：通常どおり実行し、`ssh_exec` の結果に `reminder`（ルールの説明。説明がなければ一致パターン）が加わるので、エージェントはそれをユーザーに伝えてください。
  REST 版の `POST /api/ai/sessions/{id}/exec` も同じです。誰かを待つことはなく、コマンドルールページの「履歴」にも載りません。強制ではないリマインドは、各自が自分用にミュートできます。
- **許可（例外）**：一致するコマンドを、**同じ作者**のブロック / 承認が必要ルールの対象から外します（サイト全体の例外はサイト全体のルールを、個人の例外は同じ人のルールを免除します。
  加えて、トンネルのオーナー / ADMIN の例外は、その人が管理するトンネルでは上書き可能なサイト全体のルールも免除しますが、強制のものは免除しません）。他の人の例外では、あなたのルールは覆せません。
- エージェントがトンネルのオーナーとして動く場合でも、オーナーが承認ボタンを押す必要があります（human in the loop）。
- ブロック、待機、拒否はすべて AI の監査に失敗した `ssh_exec` として記録され、リクエストと結果はコマンドルールページの「履歴」にも並びます。
- **対話シェルも同様です**：`shell_send` でシェルのプロンプトで押された Enter ごとに、Web ターミナルと同じ画面の読み取り方（`TerminalGuard`）でその行を読み出して照合します。
  ブロック → 代わりに Ctrl+C を送り、ツールはエラーを返します。承認が必要 → `ssh_exec` と同じく最大 45 秒待ち、承認されれば Enter を送ります。待機中はその行を
  プロンプトに残し、承認後にエージェントが `input: ""`、`press_enter: true` を送ると実行されます（これも 10 分以内に 1 回）。送られなかった Enter の後に入力された内容は破棄されます
  （ツールが何バイトか伝えます）。リマインドルールに一致した行はそのまま送られ、`shell_send` の結果に `reminders`（ルールごとに 1 文）が付きます。全画面プログラム（vim、less）内の Enter はチェックしません。

## 対話シェル

- シェル 1 つは、AI セッションが持つ接続上の PTY チャネル 1 本です。`ssh_exec` とセッションごとのチャネル枠 4 本を共有し、最大 2 つまでです。
- 出力は常にバックグラウンドで読み取られる（画面モデルと録画に流す）ので、エージェントが読んでいなくてもデバイスが詰まることはありません。
- 閉じるのは、`shell_close`、セッションが閉じたとき（どんな理由でも）、またはセッションの `idle_timeout` を超えて send / read がなかったときです（reaper は 30 秒ごと）。
  シェルを使うこともセッションが使われているとみなすので、セッションがアイドルタイムアウトになることはありません。
- **録画**：トンネルで「Web ターミナルを録画」がオンなら、エージェントのシェルも asciicast として録画されます（`kind: agent`、録画ページでは「MCP agent」と表示）。
- ライブセッションページのエージェントセッションの行には、開いているシェルの数が表示されます（`/api/sessions` の `shells`、`/api/ai/sessions` の `shells`）。

## リモートブラウザ（`browser:use`）

- 通常の remote-browser セッションそのものです（`remote_browser/`：デバイス経由の SOCKS、kasm-browser 内の Chromium。
  `remote_browser_max_sessions` に数えます）。違いは、エージェントが session-manager の CDP エンドポイント経由で操作する点だけです（[remote-browser.ja.md](remote-browser.ja.md) の「MCP エージェントとスクリプトからの操作」を参照）。
  バックエンドが Chromium の DevTools に直接接続することはありません。
- SSH セッションと 1 人あたりの上限 `ai_max_sessions_per_user` を共有し、同じアイドル / 寿命の制限と reaper が適用されます（デバイスのオフライン、grant の失効、権限や username
  の削除、remote-browser セッションの消失で閉じます）。ステップアップが必要なトンネルでは拒否されます。
- 「誰が使っているか」とライブセッションページに表示され（kind `browser`、client = アプリ名）、そこから終了できます。終了後のツール呼び出しは「ended by <誰>」を返します。
- 開くとき / 閉じるときに `browser_open` / `browser_close` のゲートウェイイベント（トンネルの Logs）を書き、通知は `AI-SESSION-OPENED` / `AI-SESSION-CLOSED` を流用します
  （`kind: "browser"` が加わり、webhook `mcp.session_*` の data にも `kind` が入ります）。
- 監査：URL とセレクター。`browser_type` のテキストはデフォルトでは長さだけを記録します（`sensitive: false` のときだけ内容を記録）。スクリーンショット自体は保存しません。
- **REST 版**（`api/browser.rs`、スクリプトと `telepy browse` 向け）：`POST /api/browser/sessions {tunnel_id, username?, url?}` → `{id, …}`、
  `POST …/{id}/navigate {url}`、`GET …/{id}/text?selector=`、`GET …/{id}/screenshot`（image/png）、`POST …/{id}/click {selector | text}`、
  `POST …/{id}/type {selector, text, press_enter?, sensitive?}`、`DELETE …/{id}`、`GET /api/browser/sessions`。`ai::browser`
  （`open_at` / `lookup` / `run_action`）を共有するので、上限、presence、ライブセッション、reaper、監査は MCP と同じです。個人用 API トークンや OAuth アプリの
  トークンには `browser:use` が必要で、Web のサインインからも呼べます（クライアント名は「Telepy web sign-in」）。ブラウザは開いた資格情報だけのものです。ステップアップが必要なトンネルは 403
  `step_up_refused` を返します。

## セッションのライフサイクル

セッション 1 つは、デバイスへの russh 接続 1 本で、すべてのコマンドで共有します（コマンドごとにハンドシェイクし直すことはありません）。コマンドは各自 exec チャネルを 1 本開き、
1 セッションにつき同時に最大 4 本です。

| 閉じる条件 | 理由（通知と監査の `reason`） |
| --- | --- |
| エージェントが `ssh_session_close` を呼ぶ | `closed_by_agent` |
| ユーザー / トンネルのオーナー / 管理者が Web で閉じる（AI アクティビティページまたはライブセッションページ、`DELETE /api/ai/sessions/{id}`）。管理者がその人の「MCP アプリ」機能をオフにする | `closed_by_user` |
| `ai_session_idle_timeout`（デフォルト 600 秒。実行中のコマンドはアイドルに数えない）を超えてアイドル | `idle` |
| `ai_session_max_lifetime`（デフォルト 7200 秒。必ず閉じる）を超えて存続 | `max_lifetime` |
| デバイスがオフラインになる、接続が切れる | `device_offline` / `disconnected` |
| grant または個人用 API トークンが失効 / 期限切れ、アカウントが無効化 | `revoked` |
| トンネルが削除される | `tunnel_deleted` |
| 権限や username が取り除かれる（共有解除、共有の期限切れ、許可リストの縮小など） | `permission_removed` |

- reaper は 30 秒ごとに確認します。grant / トークンを失効させたときは即座に閉じ、共有解除や権限変更などの変更でもすぐに再確認が走ります（`ai::recheck`）。
- エージェントはより短い `idle_timeout_s` / `max_lifetime_s` を要求できますが、サイト設定を超えることはできません（最短 10 秒）。
- 1 ユーザーあたり同時に最大 `ai_max_sessions_per_user` 個です（デフォルト 3。すべてのアプリの合計で、SSH セッションとエージェントのブラウザを合わせて数えます。0 = AI によるセッションの作成を許可しない）。
- コマンドのタイムアウトはデフォルト 60 秒、最大 600 秒です。タイムアウトすると `KILL` を送ってチャネルを閉じます。出力ストリームごとにデフォルトで 64 KiB、最大 1 MiB まで保持し、
  超えた場合は先頭の 1/4 と末尾の 3/4 を残します。
- MCP 2026-07-28 版にはトランスポートセッションがないので、SSH セッションは MCP の接続ではなく資格情報（どの OAuth grant か、どの個人用 API トークンか）に紐づきます。
  別のアプリ / トークンのセッションは互いに見えません。

3 つの上限は、管理者の **サイト設定 → AI アクセス（MCP）** タブ（`/tunnels/settings?tab=ai`。同じページに MCP エンドポイントの URL も表示）にあり、変更は新しく開くセッションから有効になります。

## 通知と監査

- セッションの開閉時に、`/ws/notifications` が `AI-SESSION-OPENED` / `AI-SESSION-CLOSED`
  （`details`、`tunnel_id`、`session_id`、`by`、`client`、閉じるときは `reason` も）をセッションのユーザーとトンネルのオーナーに送ります。
  共有されたユーザーが AI で他の人のトンネルに接続すると、オーナーに伝わります。
- ツール呼び出しのたびに `telepy_ai_audit_event` に 1 行書きます（最大 10 万行を保持し、90 日後に削除。ハッシュチェーンで改ざんを防ぎます）：誰が、どのアプリで、
  どのトンネルと username で、コマンドまたはパス（最大 2000 文字）、終了コード、所要時間、出力バイト数、エラー、接続元 IP。**コマンドの原文が記録されます**。
  エージェントにコマンドラインへパスワードを含めさせないでください。
- `GET /api/ai/activity` と `GET /api/ai/sessions` はデフォルトで `?scope=mine`（管理者も同じ）です：自分の分に加えて、自分が所有するトンネルの分が返ります。
  `scope=all` = すべてで、管理者だけです（それ以外は 403 `admin_only`）。`activity` は `tunnel_id`、`user_id`、`grant_id` でも絞り込めます。
- Web では、**AI アクティビティ**（`/tunnels/activity`）が自分の分（開いているセッションとあなたの MCP アプリを含む）です。管理者向けのサイト全体版は、管理エリアの
  **全体の AI アクティビティ**（`/tunnels/admin/activity`）です。

## 手動での確認

```bash
# 401 が返り、discovery がメタデータを指す
curl -si -X POST https://telepy.example.com/mcp -H 'content-type: application/json' -d '{}' | grep -i www-authenticate
curl -s https://telepy.example.com/.well-known/oauth-protected-resource/mcp
curl -s https://telepy.example.com/.well-known/oauth-authorization-server
```

自動テスト：`tests/oauth_api.rs`（OAuth フロー）、`tests/mcp_api.rs`（偽のデバイス sshd を使ったエンドツーエンドで exec / SFTP /
タイムアウト / 切り詰め / スコープ / 上限 / 失効 / reaper / 共有通知、対話シェル（PTY の echo シェル：画面、制御文字、録画、コマンドルール）、
および偽の session-manager を使ったエージェントのブラウザ）、`tests/api_tokens.rs`（個人用 API トークンで `/mcp` と REST を呼ぶ）、`tests/api_token_calls.rs`
（呼び出しログ）、`tests/features.rs`（機能の権限によるツールのブロック）、`docker/kasm-browser/tests/test_cdp.py`（CDP の操作、WebSocket
フレーム、/cdp ルート）。
