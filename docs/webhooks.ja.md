# Webhooks

<p align="center"><a href="./webhooks.md">English</a> | <a href="./webhooks.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

> 自分に届く Telepy の通知を、Slack、Discord、Google Chat、Microsoft Teams、Telegram、ntfy（スマートフォンへのプッシュ）
> または自分のサービスに送れます。管理者はさらに「サイト全体」の Webhook を共同で管理し、サーバー全体の重要なイベントを受け取れます。
> バックエンド：`webhooks/`（`catalog.rs` イベントカタログ、`text.rs` 3 言語の文面、`format.rs` サービスごとの形式、`sign.rs` 署名、
> `target.rs` アドレス検査、`mod.rs` 送信）、`api/webhooks.rs`、`db/webhooks.rs`。状態アラートのタイミングは `monitor/alerts.rs` + `monitor/runner.rs` にあります。
> フロントエンド：`/tunnels/webhooks` ＝ 自分の Webhook（管理者でもここには自分のものだけが表示され、その下にサイト全体の Webhook が読み取り専用で並びます）、`/tunnels/admin/webhooks` ＝
> サイト全体の Webhook（サイドバーの管理セクション「ルールと通知 → Webhooks」）。2 つのページは `components/webhooks/WebhooksView.tsx`（`hooks/useWebhooksPage.ts`、
> `lib/webhooks.ts`）を共有し、対象外にするためのダイアログは `components/webhooks/OptOut.tsx` にあります。

## 2 種類の Webhook

| | 個人 Webhook | サイト全体の Webhook |
| --- | --- | --- |
| 作成・管理する人 | 各自が自分用に作成（他の人には見えません） | 管理者。どの管理者でも見られ、編集できます |
| 受け取るもの | その人が Web 上ですでに受け取る通知 | 厳選した重要なイベント（状態、デバイスの識別とセキュリティ、アカウント） |
| 対象範囲 | 自分が所有する、または共有されたトンネル（数本に絞ることも可能） | すべてのトンネルとすべてのアカウント（任意のトンネルに絞ることも可能） |
| 内部ネットワークのアドレス | 既定では不可（「アドレス検査」を参照） | 可 |
| 他の人に見えるもの | 何も見えません | 各自の Webhooks ページで概要が見えます（URL・ヘッダー・シークレットは含みません） |
| トンネルを除外できるか | — | 「既定」モード：トンネルのオーナーと ADMIN の共有先は自分のトンネルを対象外にできます。「強制」モード：できません |

サイト設定 → 通知タブ（`notify_*`）：

- `notify_user_webhooks`（既定でオン）：オフにするとすべての個人 Webhook が停止します。サイト全体の Webhook には影響しません。
- `notify_private_targets`（既定でオフ）：個人 Webhook が内部ネットワーク、ローカルホスト、クラウドのメタデータに接続できるかどうか。
- `notify_max_webhooks`（既定 10、0〜100）：1 人あたりの上限。

管理者は、ユーザーとアクセス → 機能の権限（`/tunnels/admin/access`）で、特定の人（またはユーザーグループ）に対して「個人 Webhook」機能をオフにすることもできます。
その人の Webhooks ページは説明に置き換わり、`/api/webhooks*` は 403 `feature_disabled` を返します（サイト全体の Webhook を対象外にする 2 つのルートは影響を受けません）。
アカウントが無効になると、その人の個人 Webhook は送信されなくなります。

以前の単一のアラート URL（`notify_webhook_url` / `notify_down_delay`）は、アップグレード時（データ移行
`2026-10-26-site-webhook-from-settings`）に「Status alerts」という名前のサイト全体の Webhook に移されました。
同じ 4 つの状態イベントに `tunnel.ip_changed` を加え、遅延も同じで、元の設定はクリアされます。

## サイト全体の Webhook：誰に見えて、誰が対象外にできるか

![トンネルのイベントの行き先：イベント、サイト全体の Webhook、対象外、チャンネル](images/ja/webhook-optout.png)

**誰でも見られます。** 個人の Webhooks ページには、自分の Webhook の下に読み取り専用の「サイト全体の Webhook」セクションがあります。名前、サービス（Slack、Teams など）、
イベント、対象となるトンネル（その人が見られるものだけを表示し、残りは本数のみ）、オン／一時停止が表示されます。
URL、カスタムヘッダー、署名シークレット、配信履歴、作成者は表示されません。
一般ユーザーに見えるのは、オンのものと、失敗が続いて一時停止中のものだけです。管理者にはここに「管理」リンクが表示されますが、変更は引き続き管理セクションのサイト全体の Webhook ページで行います。

**2 つのモード**（`mode`。サイト全体の Webhook のみ）：

- **既定**（`default`）：管理者のダイアログで「ユーザーによる上書きを許可」がオンの状態です（新規作成時の既定で、アップグレード前からあるサイト全体の Webhook もこれです）。
  トンネルの**オーナーまたは ADMIN の共有先**は、そのトンネルをこの Webhook の対象外にできます。Webhooks ページのサイト全体セクションで「自分のトンネルを外す」を押し、
  トンネルごとにスイッチを切り替えます（自分が管理していて、かつこの Webhook が対象としているトンネルだけが表示されます。他の人がすでに外したものも表示されます）。
- **強制**（`enforced`）：「ユーザーによる上書きを許可」がオフで、カードに「強制」チップが付きます。対象のトンネルは常に送信され、誰も対象外にできません。それまでの対象外設定は一時的に無効になります。

送信時のルール（`webhooks::opted_out`）：トンネルに関するイベントは、そのトンネルの**現在の**管理者（オーナーと、現在の権限が ADMIN の共有先。送信の瞬間に読み取ります）の
**誰か 1 人でも**対象外にしていれば、既定モードのサイト全体の Webhook には送信されません。ADMIN でなくなった人の対象外設定は無効になります。
アカウントのイベント（サインイン失敗、新規ユーザー）は対象外にできません。個人 Webhook には対象外という考え方がありません。状態アラート（offline / online / degraded / recovered）も同じルールに従います。
テスト送信と再送は、対象外設定を見ません。

管理者には、サイト全体の Webhook のカードに「N 本が対象外」と表示されます。開くと、どのトンネルを、誰が、いつ外したか、今も有効かが分かります。対象外にした、または元に戻すたびに、
そのトンネルの Logs に `webhook_optout` イベントが 1 件記録されます。トンネルや Webhook を削除すると、関連する対象外設定も一緒に削除されます。サイト全体セクションの「対象外の仕組み」ボタンでは図が開きます。
イベント ─ サイト全体の Webhook ─ 対象外 ─ 管理者のチャンネル。Webhook とトンネルを 1 つずつ選ぶと、送信されるかどうかと、どの層が決めているかが点灯します。

## イベント

受信者は常に同じ出来事のアプリ内通知の宛先に従うため、Web 上で見えないことを Webhook が誰かに知らせることはありません。共有を解除したり権限を下げたりすると、
そのトンネルのイベントはその人には送られなくなります。

| イベント | グループ | 個人 Webhook の受信者 | サイト全体 |
| --- | --- | --- | --- |
| `tunnel.offline` / `tunnel.online` | トンネルの状態 | オーナーとすべての共有先 | ✓ |
| `tunnel.degraded` / `tunnel.recovered` | トンネルの状態 | オーナーとすべての共有先 | ✓ |
| `tunnel.ip_changed` | デバイスの識別 | オーナーと ADMIN の共有先 | ✓ |
| `tunnel.host_key_changed` | デバイスの識別 | オーナーとすべての共有先 | ✓ |
| `device.claim_attempt` | デバイスの識別 | オーナーと ADMIN の共有先 | ✓ |
| `tunnel.device_warning` | デバイスの識別 | オーナーと ADMIN の共有先（ルートディスクの空きが 10 % または 2 GB 未満、使用可能メモリが 10 % 未満、1 分間のロードが CPU 数の 2 倍超、再起動待ち。トンネルごと・種類ごとに 1 日 1 回まで。data には `warning` / `detail` / `avail` / `total` / `load1` / `cpus` が入ります） | ✓ |
| `share.received` | 共有とアクセス | 共有された人 | |
| `share.ended` | 共有とアクセス | 共有の双方（操作した人を除く） | |
| `access.requested` | 共有とアクセス | オーナーと ADMIN（申請者を除く） | |
| `access.decided` | 共有とアクセス | 申請者 | |
| `command.approval_requested` | コマンドルール | そのルールの承認者（ルールで指定があればその人たち、なければオーナーと ADMIN。自分のターミナルで入力したコマンドは送られず、自分の MCP エージェントのコマンドは送られます） | |
| `command.approval_decided` | コマンドルール | 申請者（自分で決定または取り消した場合は送られません） | |
| `command.blocked` | コマンドルール | オーナーと ADMIN（本人を除く）。メッセージにコマンドを含みます | |
| `session.started` | 接続 | オーナーと ADMIN（本人を除く）（ターミナル、LAN ターミナル、ファイル、ブラウザー、デスクトップ、RustDesk） | |
| `session.watched` | 接続 | 見られている人（オーナー／ADMIN／管理者が、その人の Web ターミナルの閲覧を開始したとき。data には `by` / `account` / `lan_host` が入ります） | |
| `mcp.session_opened` / `mcp.session_closed` | 接続 | エージェントのユーザーとトンネルのオーナー（data の `kind`：`ssh` または `browser`） | |
| `account.sign_in` | サインイン | アカウント本人 | |
| `account.sign_in_new_device` | サインイン | アカウント本人（過去 90 日間の成功したサインインで見たことのない国またはブラウザー） | |
| `account.sign_in_failed` | サインイン | アカウント本人 | ✓（任意のアカウント） |
| `key.expiring` | SSH 鍵 | 鍵の所有者（個人 SSH 鍵の期限が 7 日以内） | |
| `key.expired` | SSH 鍵 | 鍵の所有者（期限が切れた直後：gateway が拒否し、デバイスから削除されます） | |
| `user.created` | 管理 | — | ✓ |
| `webhook.test` | — | 「テスト送信」ボタン。購読はできません | |

`key.*` は、鍵ページにある**個人 SSH 鍵**（ノート PC が gateway 経由でデバイスに接続するときの鍵。管理者は `user_key_max_days` で有効期間を設けられます）についてのものです。
トンネル（デバイス）の鍵は意図的に期限切れにならないため、対応するイベントはありません。10 分ごとに確認します（`webhooks/keys.rs`）：期限まで 7 日以内なら `key.expiring` を、
期限が切れていれば `key.expired` を送ります（`days_left` は切り上げ。送るのは 48 時間以内に切れたものだけで、それより前に切れたものは後から送りません）。各鍵につき、段階ごと・期限日時ごとに 1 回だけ送ります
（`telepy_key_expiry_notice`）。更新して期限が変われば、数え直します。

状態イベント（offline / online / degraded / recovered）は、発生した瞬間には送られません。Webhook ごとに遅延（即時〜1 日、既定 1 分）があり、
その状態が遅延より長く続いて初めて送られます。online / recovered は、先に offline / degraded を送った場合にだけ送ります。追跡するのは、Webhook を作成した後の変化だけです。

### ページ内の通知・デスクトップ通知との関係

![画面内通知とデスクトップ通知の表示の決まり方](images/ja/notify-flow.png)

Web 上の通知（トースト）とデスクトップ通知には、それぞれ独自の設定があります（環境設定 → 通知。管理者はルールと通知 → 通知でサイト全体の既定を設定でき、
一部のイベントを強制して必ず表示させることもできます。各トンネルのメニューから、そのトンネルの状態または通知すべてをミュートすることもできます）。それらの設定が**決めるのはブラウザーに何を表示するかだけ**で、
Webhook には影響しません。Web 上でオフにしたりミュートしたりしたイベントでも、個人 Webhook が購読していれば送られます。逆に、Webhook が見るのは、自身のイベント一覧、トンネルの絞り込み、
（サイト全体の場合は）対象外設定だけです。

## 送信される内容

Webhook ごとに形式（既定は URL から判定）とメッセージの言語（English / 繁體中文 / 日本語。メッセージはそのままチャットルームに入るため、文面はバックエンドで組み立てます）を選びます。

| 形式 | URL による判定 | 内容 |
| --- | --- | --- |
| Telepy JSON | それ以外の URL | 下記の完全な JSON |
| Slack 互換 | `hooks.slack.com` | `{"text"}`。`& < >` をエスケープします（Mattermost、Rocket.Chat も受け付けます） |
| Discord | `discord.com/api/webhooks/…` | `{"content", "allowed_mentions": {"parse": []}}` |
| Google Chat | `chat.googleapis.com` | `{"text"}`。`<…>` 構文は無効化します |
| Microsoft Teams | `*.logic.azure.com`、`*.webhook.office.com`、`*.powerplatform.com` | Adaptive Card（Workflows の「Webhook 要求を受信したとき」） |
| Telegram | `api.telegram.org` | `{"text"}`。`chat_id` は URL に入れます（`…/sendMessage?chat_id=…`） |
| ntfy | `ntfy.sh`、`ntfy.*` | プレーンテキスト。`title` / `tags` / `priority` / `click` は URL パラメーターとして付きます |

名前やコマンドはユーザーが入力した文字なので、どの形式でも `@everyone` / `<!channel>` のようなメンションは無効化されます。

Telepy JSON：

```json
{
  "id": "msg_…",
  "event": "tunnel.ip_changed",
  "title": "New device IP address",
  "severity": "warning",
  "at": "2026-10-26T12:00:00Z",
  "text": "[Telepy] office-pi connected from a new IP address: 203.0.113.9 (was 198.51.100.1)",
  "server": "https://telepy.example.com",
  "url": "https://telepy.example.com/tunnels/logs?tunnel=4",
  "tunnel": { "id": 4, "name": "office-pi", "reverse_port": 1025 },
  "data": { "ip": "203.0.113.9", "previous_ip": "198.51.100.1" }
}
```

`tunnel` はトンネルに関するイベントにだけ含まれます。`data` はイベントごとに異なります（`by`、`command`、`reason` など。`webhooks/text.rs` で使われるフィールドを参照）。
リンクには `PUBLIC_URL` を使います（未設定なら `https://SERVER_DOMAIN`。どちらもなければリンクは付きません）。

## カスタムヘッダー

Webhook ごとに最大 10 個まで設定できます。たとえば自分のサービスの `Authorization` や、ntfy のアクセストークンなどです。名前は HTTP トークンで、重複は不可です。
Telepy 自身が設定するもの（`content-type`、`user-agent`、`webhook-*`、`x-telepy-event`、`host`、`content-length` など）は変更できません。
値は 1〜2048 文字の可視 ASCII 文字です（改行不可）。`SECRET_KEY` から導出した鍵で暗号化して保存され（AAD `telepy-webhook-headers:<id>`）、
API が返す相手は、その Webhook を管理できる人だけです。`PATCH` で `headers` を渡すとセット全体が置き換わり、渡さなければ変わりません。`SECRET_KEY` を変更すると読み出せなくなります。
送信は失敗して理由が表示され、編集画面では再入力を促されます（`headers_unreadable`）。

## 署名（Standard Webhooks）

すべてのリクエストに次が付きます。

- `webhook-id`：メッセージ ID。再試行しても変わりません（重複排除に使えます）
- `webhook-timestamp`：今回の送信の Unix 秒（古いものは拒否して再送攻撃を防ぎます）
- `webhook-signature`：`v1,` + base64(HMAC-SHA256(key, `{id}.{timestamp}.{body}`))。key ＝ シークレットの `whsec_` 以降を base64 デコードしたバイト列
- `x-telepy-event`：イベント名

シークレットは、カードのメニューの「署名シークレット」で表示・コピー・再生成できます。`SECRET_KEY` から導出した鍵で暗号化して保存され（AAD は Webhook の id に紐づきます）、`SECRET_KEY`
を変更すると読み出せなくなるため、新しいものに再生成してください。Standard Webhooks に対応したライブラリならどれでも検証できます。ダイアログに Node.js / Python のサンプルがあります。

## 送信、再試行、一時停止

- 失敗（接続エラー、タイムアウト、408、429、5xx）は、10 秒後と 1 分後に 1 回ずつ再試行します。それ以外の 4xx は再試行せず、3xx は追いかけません（最終的な URL を入力してください）。
- 1 つの Webhook につき 1 分あたり最大 30 件。超えた分はスキップされ、最初のスキップは `skipped` として記録されます。
- 連続 20 回失敗すると一時停止（`paused_reason = failing`）し、所有者に通知します（サイト全体の Webhook は全管理者へ。`WEBHOOK-PAUSED`）。再びオンにすると解除されます。
- Webhook ごとに最新 50 件の配信履歴を、本文（最大 16 KB）つきで 30 日間保存します。送信前にまず `sending` として記録し、送信後に結果を補います。
  再試行の待機中にバックエンドが再起動した場合は、起動時に失敗へ変更します（「Telepy restarted before this was delivered.」）。
- **再送**：配信履歴の失敗／スキップした項目（送達済みも展開すれば）に「再送」ボタンがあります。同じ `webhook-id` で、Webhook の現在の形式・言語・ヘッダーで組み立て直し、
  再試行はせず、連続失敗にも数えず、オフの Webhook でも送れ、新しい項目として記録されます（`redelivered_from`）。イベント自体は `event_json` に保存されています。テスト送信は再送できません。
- サイト全体の Webhook の追加／変更（モード変更を含む）／削除とシークレットの再生成は、`webhook` gateway イベントとして記録されます（管理セクションの監査ログ）。対象外にした／戻した操作は、
  そのトンネルの Logs（`webhook_optout`）に記録されます。

## アドレス検査（SSRF）

個人 Webhook の URL は誰でも入力でき、サーバーはその URL に接続します。そのため既定では公開アドレスだけを許可します。保存時にホスト名を解決し、いずれかのアドレスが
内部ネットワーク／ローカルホスト／リンクローカル（クラウドのメタデータ 169.254.169.254 を含む）／CGNAT／予約済みの範囲にある場合、またはそれらの IPv4 を包んだ IPv6（mapped、NAT64、6to4）である場合は、
拒否します（`private_target`）。送信時には、公開アドレスだけを返す DNS リゾルバー経由で接続し（DNS リバインディング対策）、IP リテラルは別途検査し、
リダイレクトは追わず、環境変数のプロキシも使いません。管理者が `notify_private_targets` をオンにしたときだけ許可されます。サイト全体の Webhook は常に許可されます。

## API

| | |
| --- | --- |
| `GET /api/webhooks` | 自分のもの、（管理者には）サイト全体の完全なデータ、`site_summary`（全員向け：サイト全体の Webhook の概要。`mode`、`my_optout`、自分が管理している対象トンネルの `managed` を含む）、2 つの範囲のイベントカタログ、`policy` |
| `POST /api/webhooks` | `{scope?, name?, url, format?, language?, events?, all_tunnels?, tunnel_ids?, delay?, enabled?, headers?, mode?}` → `{webhook, secret}`。`mode` ＝ `default` / `enforced`、サイト全体でのみ意味があります |
| `GET / PATCH / DELETE /api/webhooks/{id}` | 自分のもの（サイト全体は管理者）だけ。他人のものは常に 404 |
| `POST /api/webhooks/{id}/test` | `webhook.test` を送って結果を待ちます（再試行なし、連続失敗に数えません） |
| `GET /api/webhooks/{id}/deliveries` | 最新 50 件 |
| `POST /api/webhooks/{id}/deliveries/{delivery_id}/redeliver` | 1 件を再送します（409 `not_redeliverable`：テスト送信） |
| `GET / POST /api/webhooks/{id}/secret` | 署名シークレットの読み出し／再生成 |
| `PUT /api/webhooks/{id}/optout` | `{tunnel_ids}`：**自分の**対象外設定をまとめて置き換えます（自分が管理していて、このサイト全体の Webhook が対象としているトンネルのみ）。自分の概要を返します。強制モードは 400 `enforced`、個人 Webhook は 404 |
| `DELETE /api/webhooks/{id}/optout` | 自分の対象外設定を消します |

エラーは `{field: [message], code}` または `{error, code}` の形です。`code`：`private_target`、`invalid_url`、`unresolvable`、`no_events`、
`no_tunnels`、`limit`、`personal_disabled`、`admins_only`、`secret_unreadable`、`bad_header`、`not_redeliverable`、`enforced`、
`not_manager`（そのトンネルのオーナー／ADMIN ではない）、`not_covered`（この Webhook はそのトンネルを対象としていない）。管理者が受け取るサイト全体の Webhook には、さらに
`optouts [{tunnel_id, tunnel_name, by, at, active}]` が付きます。
管理者向けには、`GET /api/webhooks` が `site_tunnels`（サーバー上のすべてのトンネル。サイト全体の Webhook で選ぶためのもの）も返します。
