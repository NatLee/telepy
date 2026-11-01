# 1 行のコマンドでデバイスを追加

<p align="center"><a href="./device-join.md">English</a> | <a href="./device-join.zh-TW.md">繁體中文</a> | <b>日本語</b></p>

Linux マシン、Mac、OpenWrt ルーターを Telepy に追加するのは、コマンド 1 行で済みます。デバイスに貼り付けて実行すると、小さなスクリプトがデバイスにあるものを調べ、鍵とリバーストンネルを用意してサービスとして登録します。完了と見なすのは、Telepy がそのトンネル経由で実際にログインできたときだけです。

デバイスは Telepy へ外向きに接続するだけなので、ルーターで何かを開ける必要はありません。コマンドは 1 回限りで 30 分後に失効し、あなた自身のアカウントにデバイスを追加することしかできません。

![リバーストンネルの理由：Telepy なし、デバイスが外へ接続、トンネル経由で入る](images/ja/setup-story.gif)

このページでは、実行のしかた、デバイスに残るものと削除方法を説明し、そのあと特殊なケースを扱います。OpenWrt と Dropbear、使える SSH クライアントがないデバイス、SSH ポートがふさがれたネットワーク、互換モードです。すでに失敗している場合は[うまくいかないとき](#8-うまくいかないとき)へどうぞ。

Windows はここでは扱いません。スクリプトが Windows では動かないため、「ステップごとに設定」を使ってください。

## 1. 実行する

### コマンドを用意する

1. 「トンネル → トンネルを作成」を開き、既定の「1 行のコマンド（Linux / macOS / OpenWrt）」のままにします。
2. デバイス名は省略できます。「このデバイス上の自分の SSH キー」で「自分のキーをインストール」を選ぶと、デバイスが接続した時点で Telepy があなたの個人鍵を入れるので、自分のコンピューターから ssh できます。
3. 「デバイスから Telepy への接続方法」を選びます。「自動」（既定で、おすすめ）、「SSH ポート」、「Web ポートのみ」のいずれかです。詳しくは [SSH ポートがふさがれたネットワーク](#5-ssh-ポートがふさがれたネットワーク)を参照してください。
4. 「コマンドを作成」を押します。

次に実行方法を選びます。

- **sudo あり（推奨）**：システムサービスとして登録し、ログアウトや再起動のあともトンネルを維持します。Telepy は sudo を実行したアカウントでログインします。
- **sudo なし**：ユーザーサービスとして登録します。ログアウトすると止まることがあります。sudo を使えないとき、または OpenWrt ルーターのようにすでに root のときに選びます。
- **シェルに貼り付け**：ふつうの方法です。
- **ダウンロードして検査してから実行**：貼り付けで文字が欠けやすいルーターやシリアルコンソール向けです。ファイルを先にダウンロードし、`sh -n` で構文を検査してから実行します。curl のないマシン向けに `wget` 版もあります。

実際のコマンドはページからコピーしてください。形はこうなります。

```sh
curl -fsSL '<telepy>/api/join/install.sh' | sudo sh -s -- --token tpj_… --auto
```

先に中身を読みたい場合は「スクリプトを見る」で確認できます。スクリプトの本文そのものを端末に貼り付けて実行する使い方は対象外です。

### まず `--check` で試す

`--check` は登録の直前まですべてを行い、トークンを使いません。見つかったシェル、HTTP ツール、SSH クライアント、サービス管理を報告し、このマシンの SSH サーバーとホスト鍵を厳密なハンドシェイクで検証し、Telepy のゲートウェイに届くか（そのビルドで SSH キープアライブが正常かどうかも）確認します。ファイルは書かず、登録もしません。

ページの「コマンドを消費せずに先にテスト」にあるのがこれです。

```sh
curl -fsSL '<telepy>/api/join/install.sh' -o /tmp/telepy-join.sh && sh /tmp/telepy-join.sh --check
```

### デバイスで起きること

スクリプトは 7 つのステップを進み、それぞれで何を見つけ、なぜそれを選んだかを表示します。

1. デバイスにあるものを調べます。シェル、HTTP ツール、SSH クライアント、SSH サーバー、サービス管理です。
2. このマシンの SSH ホスト鍵を読み、厳密なハンドシェイクで検証します。
3. Telepy のゲートウェイが応答するか確かめ、ホスト鍵を固定し、キープアライブをテストします。
4. トンネル鍵を作り、1 回限りのトークンでデバイスを登録します。
5. この SSH サーバーが鍵を読む場所に、Telepy のサービス鍵を追加します。追記のみで、1 回だけです。
6. トンネルをサービスとして登録し、起動します。
7. Telepy がトンネル経由でログインするのを待ちます。

ステップ 1〜3 はトークンを使う前なので、ここで問題が出ても何も失いません。

![デバイスで 1 行のコマンドを実行し、画面が各ステップを追う様子](images/ja/join-live.gif)

ページは進み具合を追いかけます。待機中、登録済み、トンネル接続済み、Telepy がログイン、の順です。Telepy 自身に見えるのは登録・トンネル・ログインだけで、それより前のことはデバイス上に表示されます。

最後にスクリプトは 5 つの状態を個別に報告します。files installed（ファイル配置済み）、starts at boot（起動時に開始）、process running（プロセス実行中）、tunnel connected（トンネル接続済み）、login verified（ログイン確認済み）です。Done と表示するのは、Telepy が実際にログインできたときだけです。

このログインを待つのは約 2 分です。待ち時間は時計ではなくループの回数（60 × 2 秒）で数えます。起動後に NTP で時刻が合った瞬間、時計が何年分もタイムスリップするルーターでも、いつまでも待ち続けたり、すぐに諦めたりしません。

### 何を調べるか

スクリプトは何も前提にしません。bash も GNU ツールも python も curl も、完全な OpenSSH も、あるとは考えません。代わりに次のものを調べます。

- **シェル**：BusyBox の ash、bash、dash、素の sh のどれか。スクリプト自体は POSIX sh だけで書かれている（BusyBox ash で検証済み）ので、これは報告するだけです。
- **HTTP ツール**：`curl`、なければ `wget`（`--post-data` に対応しているもの）、それもなければ `uclient-fetch`。
- **SSH クライアント**：本物の OpenSSH を最優先し、なければ [Telepy の内蔵クライアント](#1b-内蔵-ssh-クライアントtelepy-carrier-tunnel)、それもなければ Dropbear の dbclient を使います。`--client openssh|builtin|dbclient` で指定もできます。
- **SSH サーバー**：SSH ポートで誰が、どのアドレスで待ち受けていて、それが何なのか。
- **ホスト鍵**：見つかる候補をすべて集め、いま待ち受けているサーバーと 1 つずつ照合します。
- **鍵の置き場所**：その SSH サーバーが、そのアカウントのために実際に読むファイル。
- **サービス管理**：procd（OpenWrt の root）、systemd（システムまたは `--user`）、launchd、どれもなければバックグラウンドのループと `@reboot` の crontab。インストール後、サービスが動いていて自動起動も有効かをもう一度確かめます。
- **保存先**：鍵のディレクトリが tmpfs や ramfs 上にあると警告します。再起動で消える場所です（OpenWrt の `/tmp` など）。その場合は `--ssh-dir` を指定してください。
- **パッケージマネージャ**：opkg、apk、apt、dnf、yum、zypper、pacman、brew、pkg。「X がありません」を、そのマシンでそのままコピーできるコマンドで伝えるためだけに使います。スクリプト自身は何もインストールしません。

<details>
<summary>各項目の調べ方と、手っ取り早い方法をとらない理由</summary>

- **シェル**：`sh --help` の 1 行目に BusyBox とあれば ash、なければ bash、dash、sh のどれかです。スクリプトはシェルの種類で分岐しません。
- **HTTP ツール**：標準の OpenWrt には curl がなく、`wget` の実体は uclient-fetch です。`--header` がなく、ステータスコードが見えず、エラー時には本文も残りません。そのためデバイス向けのエンドポイントは `?soft=1` を受け付け（常に 200 を返し、本当のステータスは 1 行目の `STATUS=<コード>`）、登録は Content-Type を見ません。
- **SSH クライアント**：`ssh` と `dbclient` のそれぞれで `-V` を実行します。`OpenSSH_` なら OpenSSH、`Dropbear` なら dbclient です。`command -v ssh` が成功しても何の証明にもなりません。標準の dbclient は Telepy のゲートウェイと鍵交換を完了できないため（[OpenWrt と Dropbear](#4-openwrt-と-dropbear) を参照）、最後の選択肢です。
- **OpenSSH のオプション**：トンネルで使うオプションをすべて付けて、`ssh -G` で一度解析します。未知のオプションは、接続したあとではなくその場でエラーになります。
- **dbclient のオプション**：未知の `-o` を渡されても、dbclient は `Ignoring unknown configuration option` を 1 行出すだけで、そのまま実行して exit 0 になります（2022.82 で確認）。終了コードは当てにできません。そこで `dbclient -o help` に `ExitOnForwardFailure`（Dropbear 2016.73 以降）があること、`-h` に `-K` と `-R` があることを確認します。
- **鍵ツール**：OpenSSH は `ssh-keygen`、内蔵クライアントは `ssh-keygen` があればそれ、なければ `telepy-carrier keygen`（ed25519、OpenSSH 形式、パーミッション 0600、隣に `.pub`）、dbclient は `dropbearkey` です。
- **SSH サーバー**：`/proc/net/tcp` で、そのポートを誰がどのアドレスで待ち受けているかを見ます。バナーは `nc -w 3` で読み（`SSH-2.0-dropbear_2022.82`、`OpenSSH_9.6`）、nc がなければ `ssh -v` の `remote software version` の行を使います。LAN インターフェースだけに bind した Dropbear（`option Interface 'lan'`）は 127.0.0.1 では応答しないので、ホスト鍵の確認もトンネルの宛先 `-R 0:<アドレス>:<ポート>` も、その LAN アドレスを使います。
- **ホスト鍵**：鍵ファイルがあっても、いま待ち受けているサーバーの鍵とは限らないので、候補はすべて試します。候補は順に、root の `dropbearkey -y /etc/dropbear/*_host_key`、`/etc/ssh/ssh_host_*_key.pub`、`ssh-keyscan`（`-T` なし。ppoll の問題があるビルドでは `-T` を付けると鍵を 1 つも出力しません。[互換モード](#6-互換モード)を参照）、最後に OpenSSH が loopback 経由で `accept-new` により一度だけ覚える方法です。
- **ホスト鍵の試し方**：どの候補も、`StrictHostKeyChecking=yes` とその鍵だけを入れた known_hosts で一度ハンドシェイクし、`Permission denied` まで進んだものだけを採用します。
- **ホスト鍵（内蔵クライアント）**：`telepy-carrier tunnel --probe --host-key '<その鍵>'` で確認します。その鍵だけを信頼し、自分の鍵は送らない完全な鍵交換です。ssh-keyscan がなければ、同じプローブがまず loopback 経由で鍵を読み取ります。
- **どれも通らないとき**：メッセージは「応答はあるが鍵を読めない」のか「何も待ち受けていない」のかを区別して伝えます。openssh-server のインストールを勧めることはもうありません。
- **鍵の置き場所**：`~/.ssh` は推測にすぎません。OpenWrt + Dropbear + root は `/etc/dropbear/authorized_keys` を読みます（OpenWrt のパッチ）。`sshd -T` を読める OpenSSH では最初の `AuthorizedKeysFile` を使います（`%h` と `%u` を展開）。それ以外は `~/.ssh/authorized_keys` です。`--authorized-keys` で上書きできます。
- **サービス管理**：root で、`/sbin/procd` が動いていて、`/etc/rc.common` があれば procd です。インストール後の確認は、procd の `running` / `enabled`、`systemctl is-active` / `is-enabled`、`launchctl print`、そして `pgrep` と crontab の内容です。
- **保存先**：`--ssh-dir` があるファイルシステムを `/proc/mounts` で調べます。
- **パッケージマネージャ**：tailscale のインストールスクリプトと同じく、ディストリビューション名ではなく PATH 上にあるもので決めます。ヒントは `opkg install dropbear && /etc/init.d/dropbear start` や `apk add openssh-client openssh-keygen` のような形です。
- **タイムアウト**：`timeout` があればそれを使います。なければ（標準の OpenWrt、macOS）自前の watchdog を使い、コマンドをバックグラウンドで動かしてタイマーで kill します。watchdog 自身の出力は閉じておきます。そうしないと、外側の `$(...)` がいつまでもそれを待ってしまいます。

</details>

<details>
<summary>スクリプトの全オプション</summary>

| オプション | 内容 |
|---|---|
| `--token TOKEN` | Telepy が発行した追加用トークン。`--check` 以外では必須で、1 回限り |
| `--check` | 事前チェックのみ。トークンを使わない |
| `--user NAME` | Telepy がログインするアカウント。既定は sudo を実行したユーザー、なければ現在のユーザー |
| `--ssh-port PORT` | このマシンの SSH サーバーのポート。既定は自動検出、検出できなければ 22 |
| `--ssh-host ADDR` | SSH サーバーが待ち受けるアドレス。既定は自動検出 |
| `--authorized-keys PATH` | この SSH サーバーがそのアカウントの鍵を読むファイル。既定はサーバーに問い合わせて決める |
| `--client openssh\|builtin\|dbclient` | どの SSH クライアントでトンネルを張るか |
| `--service procd\|systemd\|launchd\|loop` | トンネルを動かし続ける方法。既定はマシンにあるもの |
| `--no-service` | `--service loop` と同じ |
| `--name NAME` | トンネル名。英字、数字、`.`、`_`、`-` が使える。既定は Telepy で付けた名前、なければホスト名 |
| `--auto` | まず SSH ポート、ふさがれていれば Web ポート |
| `--via-web` | Web ポートのみ（SSH を WebSocket に載せる） |
| `--carrier auto\|binary\|python` | Web ポート用のヘルパー。`auto`（既定）はビルド済みの `telepy-carrier`、なければ python3 |
| `--compat-no-server-alive` | 互換モードを強制する（SSH の ServerAlive の代わりに TCP キープアライブ） |
| `--no-compat` | 互換モードへ自動で切り替えない |
| `--ssh-dir DIR` | 鍵、known_hosts、インストール記録、アンインストールスクリプトの置き場所。既定は `~/.ssh` |

</details>

## 1b. 内蔵 SSH クライアント（`telepy-carrier tunnel`）

SSH サーバーはあっても、Telepy と組める SSH クライアントがないデバイスがあります。こうしたデバイスでは、以前は `opkg install openssh-client` が必要でした。

- 標準の OpenWrt には Dropbear の dbclient しかなく、Telepy のゲートウェイと鍵交換を完了できません（[理由](#dropbear-のクライアントと-telepy-のゲートウェイ)）。
- ServerAliveInterval を設定した途端にタイムアウトする ssh のビルドもあります（[互換モード](#6-互換モード)）。
- dbclient は OpenSSH 形式の鍵も読めません。

今はビルド済みの `telepy-carrier` が、リバーストンネルを自分で張れます。Web ポート経由で SSH を運ぶときに使う、あの小さなバイナリです。

- **使われる条件**：本物の OpenSSH クライアントがなく、Telepy にそのデバイスの CPU 向けの `telepy-carrier` があるときです。スクリプトが Telepy からダウンロードし、sha256 を検証します。`--client builtin` で明示的に指定することもできます。
- **対応プラットフォーム**：x86-64、aarch64、armv7、armv6 の Linux と macOS です。MIPS のルーター（GL-AR750S など）向けはなく、引き続き OpenSSH クライアントが必要です。

サービスが実行するコマンドは、たとえば次のようになります。

```sh
~/.ssh/telepy-<id>-ws.bin tunnel --identity ~/.ssh/telepy_tunnel_ed25519 --known-hosts ~/.ssh/telepy-<id>.known_hosts \
    --user telepy --server <SSH ホスト>:<ポート> [--ws wss://<ホスト>/ws/gateway/] --no-proxy --forward 0:127.0.0.1:22 --keepalive 30
```

すること：

- トンネル鍵でゲートウェイにログインします。鍵は OpenSSH 形式でパスフレーズなしである必要があり、デバイスに ssh-keygen がなければ `telepy-carrier keygen` が作ります。
- スクリプトが書き出したファイルで、ゲートウェイのホスト鍵を確認します。中身は Telepy が `GET /api/join/gateway` で申告した鍵です。鍵が違えば接続を拒否し（終了コード 3）、何も登録されません。
- `ssh -R 0:…` と同じく `tcpip-forward` 0 を要求します。Telepy は鍵からトンネルを特定し、番号を自分で割り当てます。Telepy が開く各接続は、このマシンの SSH サーバーにつながります（`--forward 0:<アドレス>:<ポート>`。Dropbear が LAN アドレスだけで待ち受けていればそのアドレス）。
- Telepy への経路は Web ポート用ヘルパーと同じです。SSH ポート、Web ポート（`--via-web`）、またはまず SSH ポートを試し、だめなら Web ポート（`--auto`）。インストール時に `HTTPS_PROXY` が設定されていれば、その HTTP CONNECT プロキシ経由で接続します。
- 通信が 30 秒なければ SSH キープアライブを送り、3 回続けて応答がなければ諦めます。タイマーは ssh のものではなく自前なので、[互換モード](#6-互換モード)の原因である ppoll の問題の影響を受けません。プローブは 1 回だけで、互換モードは一切不要です。
- 接続が切れると 0 以外で終了し、再起動はサービス管理（procd の `respawn`、systemd の `Restart=always`、launchd の `KeepAlive`、またはループ）に任せます。SIGTERM を受けるときれいに終了します。

しないこと：シェルなし、agent や X11 の転送なし、`~/.ssh/config` は読まず、forward は 1 本だけです。パスフレーズ付きの鍵は拒否します。

見分け方：

- デバイス上では `~/.ssh/telepy-<id>-ws.bin` で、ラッパーなしでサービスが直接実行します。
- インストール記録には `CLIENT=builtin (…)`、追加時に報告される情報には `client: builtin (…)` とあり、ページでは「内蔵クライアント」と表示されます。
- デバイスの調査、サービス名の変更、接続方法の切り替え、トンネルの削除のとき、Telepy はこのコマンドラインを `ssh -R` と同じように読み取ります。鍵は `--identity`、forward は `--forward`、サーバーは `--server`（別のサーバーのポートには一切触れません）、known_hosts は `--known-hosts` から読みます。

## 2. デバイスに残るもの

サービスとそのファイルには、ランダムなインストール ID（以下 `<id>`）で名前を付けます。ユーザー名、サーバー名、トンネル名は使いません。こうしておけば、あとで Telepy が何を片付ければよいか正確に分かります。

`~/.ssh`（または `--ssh-dir` で指定した場所）には次のものが置かれます。

- **トンネル鍵**：`telepy_tunnel_ed25519` とその `.pub`（OpenSSH と内蔵クライアント）、または `telepy_tunnel_dropbear` とその `.pub`（dbclient）。
- **`telepy-<id>.known_hosts`**：固定したゲートウェイのホスト鍵。dbclient はこの種のファイルを使えないので別のやり方になります。[dbclient がトンネルを張る場合](#dbclient-がトンネルを張る場合)を参照してください。
- **`telepy-<id>.install`**：インストール記録です。ID、トンネル、サーバー、インストールした人、実行アカウントとログインアカウント、シェル、クライアント、SSH サーバー、authorized_keys のパス、サービスの種類とファイル、キープアライブ、互換モード、作成したすべてのファイルが書かれています。トークンも秘密鍵も含みません。
- **`telepy-<id>-uninstall.sh`**：アンインストールスクリプト。
- **内蔵クライアントまたは Web ポート用ヘルパー**：`telepy-<id>-ws.bin`（python3 の場合は `telepy-<id>-ws.py`）。ヘルパーには小さなラッパー `telepy-<id>-ws.sh` も付きます。内蔵クライアントには不要です。

サービスはデバイスにあるものによって変わります。

- **procd**：`/etc/init.d/telepy-<id>`。終了するたびに 10 秒後に再起動し、決して諦めません（`respawn 3600 10 0`）。出力は `logread` に入り、`HOME` を設定し、実行アカウントが root でなければそのアカウントを指定します。
- **systemd**：`telepy-<id>.service`。システムのユニットで、sudo なしなら `--user` のユニットです。
- **launchd**：`com.telepy.tunnel.<id>`。sudo ありなら LaunchDaemon、なしなら LaunchAgent です。
- **どれもない場合**：`~/.ssh/telepy-<id>.sh` のループと、`@reboot` の crontab エントリです。

さらに、そのアカウントの authorized_keys に 1 行加わります。Telepy のサービス鍵で、追記は 1 回だけです。

## 3. 再実行と削除

### 再実行

- **同じ鍵なら同じトンネル**：Telepy はトンネル鍵でデバイスを識別するので、同じデバイスで新しいコマンドを実行すると、既存のトンネルをそのまま使います。Telepy の以前の命名（`telepy-tunnel-<n>`）で入っていたものは、ついでに片付けます。
- **テストログインに失敗したあと**：ページに出た原因を直し、新しいコマンドを作って同じデバイスで実行してください。同じトンネルにつながります。

### ダウンロードや応答が途中で失われたとき

- **ダウンロードの破損**：Telepy はスクリプトの末尾に `# telepy-sha256: <hex>` を付けます。ファイルから実行すると、スクリプトが自分で照合し、欠けがあればダウンロードが壊れていると伝えます。
- **1 行目から壊れている場合**：先頭の欠け（2 行目が `in this machine as a device…` になって届いたことがあります）、Windows の改行、BOM があると、スクリプトが何か言う前に sh が 1 行目で止まります。だから「ダウンロードして検査してから実行」は先に `sh -n` を実行します。`curl | sh` は自分自身を検査できないので、何も止められません。
- **登録の応答が失われた場合**：スクリプトが登録を 2 回送ることはありません。まず `GET /api/join/<token>/status` を確認し、すでに登録済みかそれより先まで進んでいれば、`GET /api/join/<token>/config` で同じ設定をもう一度取得します（同じチケット、同じトンネル）。そうでなければ、チケットはまだ待機中なので、同じコマンドをもう一度実行するよう伝えます。

`--check` はトークンを使わないので、何度でも試せます。

### 削除する

**デバイス側で**：アンインストールスクリプトを実行します。インストールの最後に正確な行が表示されます（`Uninstall: sh ~/.ssh/telepy-<id>-uninstall.sh`）。sudo でインストールした場合は sudo を付けてください。サービスと、インストール時に作ったファイルを止めて削除します。

トンネル鍵と、authorized_keys にある Telepy の行は意図的に残します。不要なら自分で削除してください。dbclient の場合は、インストール時に known_hosts に追加した行だけを削除し、ほかには触れません。

**Telepy 側で**：トンネルを削除します。デバイスがオンラインなら、「デバイスからトンネルサービスを削除」（既定でオン）がこのインストールを見つけて削除します。procd の init スクリプト（まず無効化してから停止・削除）、インストール記録、dbclient の known_hosts の行も含みます。デバイスの調査では、これらが `initd`、`record`、`known_hosts` として一覧に出ます。

## 4. OpenWrt と Dropbear

標準の OpenWrt はいちばん手ごわい相手で、このスクリプトの形もほとんどはここで決まりました。BusyBox の ash、curl なし、SSH のサーバーもクライアントも Dropbear、procd、再起動で消える `/tmp`。それぞれへの対処は次のとおりです。

- **curl がない**：OpenWrt の `wget` は uclient-fetch ですが、スクリプトはこれで動きます。「ダウンロードして検査してから実行」にも `wget` 版があります。
- **SSH クライアント**：標準の OpenWrt の `ssh` は、OpenSSH の名札を付けた Dropbear です。x86-64 と ARM のルーターでは内蔵クライアントがトンネルを張るので、追加パッケージは要りません。MIPS のルーターでは OpenSSH クライアント（`opkg install openssh-client openssh-keygen`）を入れれば、スクリプトがそれを使います。
- **SSH サーバー**：ホスト鍵は root で `dropbearkey -y` を使って読みます。Dropbear が LAN アドレスだけで待ち受けていれば、そのアドレスに接続します。
- **Telepy の鍵**：root の鍵は `/etc/dropbear/authorized_keys` にあり、サービス鍵もそこに追加します。
- **サービス**：procd の init スクリプト `/etc/init.d/telepy-<id>` で、終了するたびに 10 秒後に再起動します。ログは `logread` にあります。
- **保存先**：`--ssh-dir` が tmpfs 上にあると警告します。

### Dropbear のクライアントと Telepy のゲートウェイ

dbclient しかなく、内蔵クライアントもないルーター（実際には MIPS）では、今のところトンネルを張れません。Dropbear のクライアントはどれも、鍵交換のときに「推測」の最初のパケットを送ります。厳密な鍵交換（strict kex）が有効だと、Telepy のゲートウェイがこれを数え間違えて接続を切ってしまいます。

これはゲートウェイが使っている SSH ライブラリ、russh のバグです。約 20 行の修正を上流に [Eugeny/russh PR #805](https://github.com/Eugeny/russh/pull/805)（issue [#804](https://github.com/Eugeny/russh/issues/804)）として提出しています。

Telepy は修正版を自前で抱えず、上流のリリースを待ちます。Telepy が更新されれば、スクリプトを変えずに dbclient が使えるようになります。

それまでは、トークンを使う前のゲートウェイ確認でスクリプトがこれを検出し、`the gateway closed the connection during the key exchange` で止まって、Telepy を更新するか、OpenSSH クライアントを入れて `--client openssh` で再実行するよう案内します。OpenSSH クライアントのある OpenWrt ルーター（テストした GL.iNet の 2 台とも）は影響を受けません。

<details>
<summary>厳密な鍵交換のバグの詳細</summary>

OpenWrt 23.05 は Terrapin 対策（`kex-strict-c-v00@openssh.com`）を Dropbear 2022.82 にバックポートしました。Dropbear の鍵交換リストは `kexguess2@matt.ucc.asn.au` で始まり、常に `first_kex_packet_follows` の推測パケットを送ります。

russh 0.64.1 は外れた推測パケットを無視したあと、本物の `KEX_ECDH_INIT` をシーケンス番号 2 で受け取り、厳密な鍵交換の違反（`strict kex violated at sequence no. 2, message type: 30`）と判断して切断します。影響はすべての Dropbear クライアントに及び、新しい 2024.86 も推測し、厳密な鍵交換にも対応しています。OpenSSH クライアントは推測しないので、これまで表に出ませんでした。

RFC 4253 §7.1 は推測を認めており、OpenSSH サーバーはずっと Dropbear を受け入れてきました。修正は、推測パケットを無視したあとでシーケンス番号の検査を 1 つずらすものです。この修正を当てたゲートウェイで、Docker 上の標準 OpenWrt の dbclient 2022.82 を試し、接続、検証の順に成功しました。

</details>

### dbclient がトンネルを張る場合

次の点は、ゲートウェイが Dropbear のクライアントを受け入れるようになってから、または `--client dbclient` で強制したときに関係します。

- **バージョン**：dbclient には `ExitOnForwardFailure`（Dropbear 2016.73 以降）と、`-K` および `-R` オプションが必要です。
- **キープアライブ**：dbclient は自前の `-K 30` を使い、3 回応答がなければ切断します。ppoll の問題の影響は受けず、互換モードになることもありません。
- **独自の鍵形式**：dbclient 2022.82 は OpenSSH 形式の秘密鍵を読めない（`Exited: String too long`、実測）ため、2 つのクライアントの鍵ファイルは別々です。`dropbearconvert` があれば鍵を変換し、同じトンネルを使い続けます。なければ新しい鍵は Telepy から見て新しいデバイスになり、スクリプトがそう伝えます。標準の OpenWrt には `dropbearconvert` がありません。
- **known_hosts**：dbclient には `UserKnownHostsFile` も `HostKeyAlias` もないので、ゲートウェイのホスト鍵は実行アカウントの `~/.ssh/known_hosts` に `<gateway host> <type> <key>` の形で書き込みます。鍵の後ろにコメントは付けられません。dbclient は行の残りを鍵としてデコードするため、コメントがあると一致しなくなります（実測）。
- **その行だけ**：追加した行はインストール記録の `KNOWN_HOSTS_LINE=` に残り、アンインストールスクリプトもトンネルの削除も、その行だけを消します。
- **ホスト名の衝突**：dbclient はポートではなくホスト名だけで比較します。同じホスト名に同じ種類の別の鍵がすでにある場合、スクリプトは止まって説明します。
- **パスを固定**：サービスには `/usr/bin/dbclient` そのものを書きます。標準の OpenWrt では `ssh` は dropbear を指していますが、あとから `opkg install openssh-client` すると OpenSSH に置き換わります。サービスが `ssh` を呼んでいたら、dbclient 用の引数で OpenSSH を動かすことになります（`-K 30 -I 0` が別のオプションと解釈され、`0.0.0.30` に接続しようとします）。
- **Web ポート**：dbclient は同じヘルパーのラッパーを `-J` で経由します。

## 5. SSH ポートがふさがれたネットワーク

Web のポートしか外に出られないネットワークもあれば、Web の名前が Web の通信しか通さないプロキシの後ろにある場合もあります。そんなときは、トンネルを WebSocket に載せて Telepy の Web ポートを通せます。中の SSH 接続、鍵、ホスト鍵の検証は変わりません。

- **「自動」**（`--auto`、ページの既定）：まず SSH ポート、ふさがれていれば Web ポート。接続のたびに判断し直します。
- **「Web ポートのみ」**（`--via-web`）：常に Web ポートを使います。

どちらの場合も、デバイスには小さなヘルパーが必要です。

- **ビルド済みの `telepy-carrier`**：デバイスの CPU 向けのものを Telepy からダウンロードし、sha256 を検証します。内蔵クライアントを使う場合は、クライアント自身がヘルパーを兼ねます。
- **python3**：その CPU 向けのビルド済みヘルパーがない場合に使います。
- **どちらもない場合**：「自動」ならトンネルは SSH ポートだけを使い、スクリプトがその旨を伝えます。「Web ポートのみ」ではエラーになります。

ヘルパーを自分で選ぶには `--carrier auto|binary|python` を使います。

デバイスが外に出るのに HTTP プロキシが必要なら、コマンドを実行するときに `HTTPS_PROXY`（または `https_proxy`）を設定してください。サービスには自分の環境変数がないので、スクリプトがプロキシをサービスのコマンドに書き込みます。

これが必要かどうかは、登録前のゲートウェイ確認で分かります。テスト用のハンドシェイクが 2 回ともタイムアウトするか接続できなければ、ゲートウェイのポートへの外向き TCP がふさがれています。許可するか、`--auto` か `--via-web` を使ってください。Telepy 側で Web ポートがどう扱われるかは[デバイスの接続](device-connections.ja.md)で説明しています。

## 6. 互換モード

登録（トークンを消費します）の前に、スクリプトは公開の `GET /api/join/gateway` で Telepy からゲートウェイのアドレス、ポート、アカウント、ホスト鍵を受け取り、鍵を固定してから 2 回接続します。

1. `-o ServerAliveInterval=30 -o ServerAliveCountMax=3` を付けて。
2. 付けずに。

同じゲートウェイ、同じオプションで、違いは ServerAlive だけです。どちらも鍵は送らず（`PubkeyAuthentication=no`）、完全な鍵交換が `Permission denied` で終われば成功とみなします。ゲートウェイにはイベントが残りません。

| 1 回目 | 2 回目 | スクリプトの動き |
|---|---|---|
| ok | — | 通常どおり SSH キープアライブを使う（`keepalive=ssh`） |
| タイムアウト | ok | 互換モードに切り替える |
| タイムアウトまたは到達不能 | タイムアウトまたは到達不能 | 中止。ゲートウェイへの外向き TCP がふさがれている。`--auto` か `--via-web` を使う。互換モードは適用しない |
| ホスト鍵の不一致 | — | 中止。ゲートウェイのホスト鍵が Telepy の申告したものと違う |

2 行目は実在するバグ、OpenWrt #12574 です。一部のビルドでは fortify-headers の `ppoll` が 64 ビットの `time_t` を 32 ビットとして読むため、GL-AR750S のようなビッグエンディアンの ath79 ルーターでは 30 秒が 30 ナノ秒になります。まばたきする暇もなく、鍵交換どころではありません。タイムアウトを設定した瞬間に ssh がタイムアウトします。

互換モードは SSH キープアライブを無効にします（`ServerAliveInterval=0 -o TCPKeepAlive=yes`）。追加時の情報には `facts.compat = ["no_server_alive"]` と記録され、ページとトンネルのイベントにも表示されます（「互換モード：このデバイスでは SSH キープアライブが無効です」）。

- `--no-compat`：自動切り替えを禁止します。スクリプトは止まって説明します。
- `--compat-no-server-alive`：互換モードを強制します。

代償は次のとおりで、デバイス上に表示され、情報とインストール記録にも残ります。

- **SSH のハートビートがない**：切断に気づけるのは TCP キープアライブだけで、カーネルの既定値は 2 時間であることが多いです。
- **プロセスが動いていても安心できない**：procd も systemd も ssh が終了したときにしか再起動しないので、プロセスがあってもトンネルが使えるとは限りません。
- **回避策であって修正ではない**：下にあるパッケージのバグはそのままです。

dbclient（自前の `-K 30`）と内蔵クライアント（プローブ 1 回、自前のタイマー）は互換モードを必要としません。

## 7. 追加後に使える機能

小さな Dropbear / BusyBox デバイスでも、Telepy の機能のほとんどはそのまま使えます。

| 機能 | Dropbear / BusyBox デバイスでは |
|---|---|
| ターミナル | 使えます（PTY シェル、ash） |
| ファイルマネージャー / SFTP | sftp-server がない場合（OpenWrt では `opkg install openssh-sftp-server`）、ファイルマネージャーは exec に切り替えます。SFTP REST API には sftp が必要です |
| デバイスの鍵リスト（共有相手の鍵のインストール） | sftp サブシステムがなければ exec で書き込みます（`cat`、一時ファイル、`mv -f`）。OpenWrt + Dropbear の root は `/etc/dropbear/authorized_keys` に書き込み、追加スクリプトと同じファイルです |
| デバイス情報、LAN スキャン | スクリプトは POSIX / BusyBox 互換です。`ip` に `-o` がなければ `ifconfig` を使い、`getent` がなければ名前解決はしません |
| サービス名の変更、接続方法の切り替え | procd で使えます（`/etc/init.d/telepy-<id>`、ワンコマンド追加と同じ形）。調査と削除にも対応しています |
| リモートデスクトップ / ブラウザー | デバイスの sshd の direct-tcpip を通ります。Dropbear は既定で許可しています |
| Windows ネイティブ | ワンコマンド追加には対応していません。「ステップごとに設定」を使ってください |

Telepy が代わりに回避している Dropbear の制限がもう 1 つあります。9000 バイトを超える exec コマンドを受け付けないことです。

Telepy の調査・削除スクリプトは約 25 KB あるので、長いスクリプトは最大 6000 文字ずつに分けてデバイスの一時ファイルに書き込み（`umask 077`）、`sh` で実行してから削除します。短いスクリプトは従来どおり 1 回の `sh -c` です。exec での鍵リストの書き込みも同じように分割します。

以前は Dropbear がチャネルをそのまま閉じ、Telepy には `the script stopped early (exit None)` としか見えませんでした。

## 8. うまくいかないとき

スクリプトが止まるときは、次に何をすべきかをメッセージで伝えます。よくあるものを、スクリプトが表示するとおりに引用し、起きるタイミングごとにまとめました。

### トークンを使う前

まだ何も登録されていないので、原因を直して同じコマンドをもう一度実行してください。

- `cannot reach <Telepy のアドレス>`：デバイスから Telepy の Web アドレスに届きません。wget や uclient-fetch で https を使うには CA 証明書も必要です（このマシンで入れるべきパッケージがメッセージに出ます）。時計がずれていても TLS は失敗します。
- `no SSH server answers on <アドレス>:<ポート>`：そこでは何も待ち受けていません。SSH サーバーを起動するか（このマシン用のインストールコマンドがメッセージに出ます）、`--ssh-port` / `--ssh-host` で正しいサーバーを指定してください。Mac では「システム設定 > 一般 > 共有」で「リモートログイン」をオンにします。
- `the SSH server on … answers, but its host key could not be read`：root で実行するか、openssh-client を入れてください（ssh-keyscan のため）。root でない OpenWrt でよく起きます。
- `none of the host keys found … matched the server`：そのポートで別の SSH サーバーが待ち受けているかもしれません。`--ssh-port` / `--ssh-host` で正しいサーバーを指定してください。
- `no SSH client: no OpenSSH, no built-in client … and no dbclient`：OpenSSH クライアントを入れるか（入れ方はメッセージに出ます）、Telepy の管理者に `telepy-carrier` を用意してもらってください（`telepy-server fetch-carriers`）。
- `cannot connect to <ゲートウェイ>` または `cannot complete an SSH handshake with <ゲートウェイ>`：ゲートウェイのポートへの外向き TCP がふさがれています。許可するか、`--auto` / `--via-web` を使ってください（[SSH ポートがふさがれたネットワーク](#5-ssh-ポートがふさがれたネットワーク)）。
- `the gateway's host key does not match what Telepy announced`：ゲートウェイのアドレスで応答したのが、Telepy の説明したゲートウェイではないため、スクリプトは止まります。
- `the handshake times out as soon as ServerAliveInterval is set`：ppoll の問題があるビルドで `--no-compat` を付けて実行しました。外して再実行するか、`--compat-no-server-alive` を付けてください（[互換モード](#6-互換モード)）。
- `the gateway closed the connection during the key exchange`：Dropbear のクライアントとゲートウェイの相性が、今はまだ悪い状態です。OpenSSH クライアントを入れ、`--client openssh` で再実行してください（[Dropbear のクライアントと Telepy のゲートウェイ](#dropbear-のクライアントと-telepy-のゲートウェイ)）。
- `… has Windows line endings (CRLF)`、`… starts with a UTF-8 byte-order mark`、`… is damaged or incomplete (checksum mismatch)`：エディターで保存し直すのではなく、`curl -o` か `wget -O` でスクリプトをダウンロードし直してください。
- `<known_hosts ファイル> already has a different … key for <gateway host>`（dbclient のみ）：その行が古ければ削除するか、OpenSSH を入れて `--client openssh` で再実行してください。

### 登録時

- `This join command is invalid or has expired.` または `This join command was already used.`：コマンドは 1 回限りで、30 分で失効します。Telepy で新しく作成してください。
- `This machine is already managed by another Telepy account`：このマシンの SSH ホスト鍵は、別のアカウントのトンネルに固定されています。そのアカウントにデバイスを共有してもらってください。このマシンが複製したものなら、ホスト鍵を作り直して（`ssh-keygen -A`）もう一度試してください。
- `this machine is already your tunnel '<名前>'`：警告だけです。同じマシンへの 2 本のトンネルは動きますが、アカウントと鍵は別々に管理されます。たいていは、既存のトンネルにこのアカウントを追加するほうがすっきりします。

### 登録後

- `the tunnel did not come up within 120 seconds`：サービスは 10 秒ごとに再試行を続け、デバイスが接続すれば Telepy に表示されます。スクリプトが表示した `Logs:` の行（`logread -e telepy-<id>`、`journalctl -u telepy-<id> -f`、またはループのログファイルへの `tail -f`）でログを確認し、ゲートウェイのポートへの外向き TCP が許可されているか確かめてください。
- `login verified` が `NO: …`（ページでは、トンネルは接続したがテストログインに失敗）：表示された原因を直し、同じデバイスで新しいコマンドを実行してください。同じトンネルを使います。
- `the tunnel is up, but Telepy has not finished checking the login`：スクリプトが表示したリンクから、Telepy でそのデバイスを確認してください。
- `the tunnel stops when <ユーザー> logs out`：sudo なしで入れたユーザーサービスです。`sudo loginctl enable-linger <ユーザー>` を実行するか、sudo を付けて再実行してください。Mac で sudo なしの場合も、LaunchAgent はログイン中しか動きません。
- `started in the background, but it will NOT come back after a reboot`：サービス管理がなく、crontab にも失敗しました。再起動後に自分で起動し直すか、crontab を直してから再実行してください。
- `<ディレクトリ> is on tmpfs: everything written there is lost at reboot`：再起動後も残るディレクトリを `--ssh-dir` で指定してください。

## 9. 既知の制限

- **Windows**：Windows ネイティブ（PowerShell、タスクスケジューラ、ACL）は引き続き「ステップごとに設定」です。ワンコマンドのスクリプトは Windows では動きません。実装も検証もしていない機能を、対応しているとは言いません。
- **dbclient しかなく内蔵クライアントもないルーター（MIPS）**：russh の修正がリリースされるまで、ゲートウェイに接続できません（[詳細](#dropbear-のクライアントと-telepy-のゲートウェイ)）。スクリプトはトークンを使う前にそう伝えます。OpenSSH クライアントを入れれば解決します。
- **dbclient の known_hosts**：ホスト名だけで比較するため、1 つのホスト名に同じ種類の鍵を 2 つ持てません。`UserKnownHostsFile` も `HostKeyAlias` もありません。`dropbearconvert` がない場合（標準の OpenWrt にはありません）、クライアントを切り替えるときに鍵を変換できません。
- **互換モード**：回避策であって修正ではありません。SSH のハートビートが無効なので、切断の検知が遅れます。
- **root でない OpenWrt**：`/etc/dropbear/*_host_key` を読めず、`/etc/ssh/*.pub` も ssh-keyscan もなければ、ホスト鍵の取得元がありません。スクリプトは止まって説明します。
- **`/etc/rc.local`**：そこに手書きされたトンネルの行は、自動では名前変更も切り替えもされません。
- **Web ポート用ヘルパーがない場合**：ARM ルーター（aarch64、armv7、armv6）にはビルド済みの `telepy-carrier` があります。それ以外の CPU（MIPS）で python3 もないルーターにはヘルパーがないため、「自動に切り替え」は SSH ポートだけを使う新しいサービスを入れ、その旨を表示します（`no_carrier`）。
- **複数のアドレス**：スクリプトは SSH サーバーの bind アドレスをトンネルの宛先にします。loopback 以外の複数のアドレスに bind している場合は、最初のものを使います。

## 10. テストした環境

実プラットフォームでの結果です（2026-10-30 時点、内蔵クライアントは 2026-11-01）。

- **標準の OpenWrt 23.05.5**（x86-64、Docker 上）：追加パッケージなしで内蔵クライアントを使って追加・検証に成功し、OpenSSH クライアントを入れた状態でも試しました。コンテナを再起動すると、procd がトンネルを自動で復帰させました。
- **GL.iNet GL-AR750S**（OpenWrt 22.03.4、MIPS、OpenSSH クライアント、Dropbear サーバー）：`--check` が通り、ppoll の問題を実機で再現しました。互換モードで最後まで追加して検証に成功し、その後きれいにアンインストールできました。
- **GL.iNet GL-MT3000**（aarch64、OpenSSH クライアント、Dropbear 2024.86）：`--check` が通り、キープアライブは通常どおりでした。事前チェックのみで、追加はしていません。
- **Alpine 3.20**（ash、Dropbear サーバー、OpenSSH クライアント、procd なし）：バックグラウンドのループと crond の `@reboot` として追加し、検証に成功しました。アンインストールでプロセスと crontab の行が消えました。

さらに Telepy の自動テストでは、CI のたびに、サーバーが配信するスクリプトを本物の `/bin/sh` で本物のゲートウェイに対して実行しています。

<details>
<summary>テストの詳しい記録と Docker での手順</summary>

**自動テスト（CI のたび）**

- バックエンドのユニットテストで、情報の許可リスト、soft レスポンス、チェックサム、exec での書き込みコマンドを確認しています。
- API のテストで、soft レスポンス、`/api/join/gateway`、`/config` による復旧、フォームの content type、情報がチケット・イベント・デバイスのインストール情報に入ることを確認しています。
- スクリプトのテストでは、サーバーが返すスクリプト（チェックサム込み）を本物の `/bin/sh` で実行し、テスト用 lab の本物のゲートウェイと本物の HTTP リスナーに対して動かします。デバイスの sshd 役は lab のマシンです。
- このテストでは、壊れたファイルや CRLF、`--check` がトークンを使わずファイルも書かないこと、ポート違いのメッセージ、検証までの実際の追加、記録の内容、アンインストール後にトンネルが切れることを確認しています。macOS の `/bin/sh` と OpenSSH 10.3 ですべて通っています。

**標準の OpenWrt 23.05.5 rootfs**（x86-64 を OrbStack 上でエミュレート。ash、BusyBox 1.36、Dropbear 2022.82 のサーバーと dbclient、uclient-fetch、procd を `/sbin/init` として起動、`--privileged`）：

- `--check` が通りました。ホスト鍵は 2 つとも `dropbearkey -y` から取得し、厳密なハンドシェイクで検証済み。ゲートウェイの 2 つのホスト鍵も固定しました。
- 実際の追加は接続から検証まで成功しました（root、`/etc/dropbear/authorized_keys` 経由）。dbclient には修正を当てたゲートウェイを使っています。コンテナ再起動後、procd がトンネルを自動で復帰させました。
- サーバーを再起動すると、dbclient が `-K 30` によって約 1 分で切断を検知し、procd が 10 秒後に再接続しました。
- デバイスの鍵リストは exec の代替経路を通り（`installed`、`verified`）、パネルには `/etc/dropbear/authorized_keys` が表示されました。
- 調査で procd のサービス、プロセス、鍵、記録が見つかりました。アンインストール後は init.d と rc.d のエントリ、プロセスが消え、鍵は残り、ゲートウェイの forward は解放されました。

**同じ rootfs に `opkg install openssh-client openssh-keygen` を追加**（Dropbear サーバー、OpenSSH 9.8 クライアント、ssh-keyscan なし）：`--check` が通り、ホスト鍵は同じく `dropbearkey -y` から取得、キープアライブには OpenSSH の ServerAlive を使いました。

**内蔵クライアント（2026-11-01）**：`openssh-client` のない標準 rootfs（ssh・ssh-keygen・ssh-keyscan なし、dbclient のみ）で、`x86_64-unknown-linux-musl` 向けの `telepy-carrier` を `CARRIER_DIR` に置き、`/api/join/carrier/<target>` がそのまま配信する構成です。

- `--check` は内蔵クライアントを選びました。`dropbearkey -y` の ed25519 ホスト鍵を `tunnel --probe` で検証し、ゲートウェイのプローブは SSH ポートで成功、互換モードなしです。
- 実際の追加では `telepy-carrier keygen` で鍵を作り、procd サービス `telepy-<id>` が `telepy-<id>-ws.bin tunnel …` を実行して、接続から検証まで成功しました（RSS 約 7 MB）。コンテナ再起動後も procd が復帰させました。
- 「自動に切り替え」は、先に新しいほうをつないでから古いほうを外す形で、`--server` と `--ws` の両方を持つ新しいインストール ID のサービスに移りました。
- サービスとサービス鍵ごとトンネルを削除すると、`/etc/init.d` と `/root/.ssh` に Telepy のファイルは残らず、プロセスもありませんでした。

**Alpine 3.20**（ash、Dropbear 2024.85 サーバー、OpenSSH 9.7 クライアント、procd なし）：`--check` が通り、keyscan と dropbearkey の両方の取得元を検証しました。バックグラウンドのループと crond の `@reboot` として実際に追加して検証に成功し、アンインストールでプロセスと crontab の行が消えました。

**実機（2026-10-30、本番サーバーから `telepy exec` で実行、開発用サーバーは同じ LAN 内）**：

- **GL-AR750S**（OpenWrt 22.03.4、mips、BusyBox 1.35、OpenSSH 8.9p1 クライアント、Dropbear 2022.82 サーバー、curl）：
  - `--check` が通りました。`dropbearkey -y` 由来の 2 つのホスト鍵は正しく、`/etc/ssh/*.pub` の 2 つは「いま待ち受けているサーバーではない」と正しく判定されて無視されました。
  - ゲートウェイのプローブは ServerAlive ありでタイムアウトし、なしでは成功したため、スクリプトが自動で互換モードに切り替えました。
  - 実際の追加で procd サービス `telepy-caqgap9k` が入り、接続から検証まで成功しました（root、互換モード）。
  - アンインストール後は本番の `telepy-47xzwr2e` だけが残って動き続けました。開発用サーバーの forward は解放され、鍵と authorized_keys の行は設計どおり残りました（開発用の行は手で削除）。
  - Dropbear とネットワークの設定には一切触れていません。
- **GL-MT3000**（GL 21.02-SNAPSHOT、aarch64、BusyBox 1.33、OpenSSH 8.4p1、Dropbear 2024.86）：`--check` が通り、キープアライブは SSH のまま（ServerAlive のハンドシェイクは正常）、ホスト鍵は `dropbearkey -y` から取得（ecdsa を含む）。事前チェックのみです。
- 2 台とも BusyBox の `nc` に `-w` がなく（使い方を表示するだけ）、バナーは `ssh -v` から取りました。スクリプトは今では、`-w` が失敗すると watchdog の下で `nc` をもう一度実行します。

**Docker での手順**。ホストで Telepy サーバーを直接動かしている前提です（API は 18872、ゲートウェイは 24872、`SERVER_DOMAIN=host.docker.internal`）。

```sh
docker run -d --platform linux/amd64 --privileged --cgroupns=host --name telepy-wrt openwrt/rootfs:x86-64-23.05.5 /sbin/init
docker exec telepy-wrt sh -c 'wget -O /root/j.sh http://host.docker.internal:18872/api/join/install.sh && sh /root/j.sh --check'
docker exec telepy-wrt sh /root/j.sh --token tpj_…        # 標準：内蔵クライアント（CARRIER_DIR に telepy-carrier）+ procd
docker exec telepy-wrt sh -c 'opkg update && opkg install openssh-client openssh-keygen' && docker exec telepy-wrt sh /root/j.sh --check
```

</details>
