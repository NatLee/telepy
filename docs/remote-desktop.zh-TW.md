# 遠端桌面（在瀏覽器裡用 RDP / VNC / RustDesk）

<p align="center"><a href="./remote-desktop.md">English</a> | <b>繁體中文</b> | <a href="./remote-desktop.ja.md">日本語</a></p>

直接在瀏覽器裡看、操作一台電腦的桌面：Windows 走 RDP、任何 VNC 伺服器，或是 RustDesk。那台電腦可以是有 Telepy 通道的裝置，也可以是那台裝置區網裡的另一台電腦。

裝置上什麼都不用裝。連到桌面的那一段由裝置自己的 SSH 伺服器開，Telepy 再經通道一路送到你的瀏覽器。

可以從這幾個地方打開：

- 側欄的「遠端桌面」
- 通道選單，或通道列表上的「桌面」按鈕
- 「網路拓撲」頁裡某台電腦的面板

整個功能受「遠端桌面」這個功能權限管：管理員幫你關掉時，頁面會改成說明，API 則回 403 `feature_disabled`。

## 選哪一種連法

![兩種連線方式並排比較](images/zh-TW/desktop-ways.png)

有兩種連法，兩種都走通道：

- **RDP / VNC**：Telepy 的桌面引擎 guacd 跟桌面講 RDP 或 VNC，再把畫面變成一張張圖片送給瀏覽器。
- **RustDesk**：RustDesk 自己的引擎在你的瀏覽器分頁裡跑，影像在瀏覽器解碼，Telepy 只負責中繼。比較習慣 RustDesk app 的話，Telepy 也可以改成把埠轉發到你的電腦。

| | RDP / VNC | 經通道用 RustDesk |
|---|---|---|
| 目標上要跑 | RDP 或 VNC 伺服器 | 開了 IP 直接存取的 RustDesk |
| 畫面 | Telepy 轉成圖片 | 影片，在你的瀏覽器解碼 |
| 畫面動得快時 | 會卡（實測約每秒 5 幀） | 順（實測約每秒 28 幀） |
| 多螢幕 | VNC：一次看一個；RDP：只有一個螢幕 | 用 RustDesk 自己的螢幕切換 |
| 聲音 | 只有 RDP，而且要自己打開；VNC 沒有 | 有 |
| 檔案 | 檢視器裡沒有（請用終端機的檔案管理員） | 「檔案」面板，每個檔案最多 2 GB |
| 登入 | Windows 或 VNC 帳密，可以存起來 | RustDesk 密碼，可以存起來 |

簡單講：Windows 或一般的 VNC 伺服器，用 RDP / VNC；那台機器本來就裝了 RustDesk、又想要順暢的影像，就用 RustDesk。

頁首的「連線方式比較」按鈕會在 app 裡打開這張比較，也標出哪一段由誰加密、你現在用的是哪一種。協定欄位的提示和資訊對話框的頁尾也打得開它。

## 遠端電腦要準備什麼

- **裝置要允許轉發**：它的 sshd 要允許 TCP 轉發（`AllowTcpForwarding`）。OpenSSH 和 Win32-OpenSSH 預設都是開的。
- **一個桌面伺服器**，在裝置本身或它區網裡的電腦上：
  - Windows 遠端桌面：埠 3389
  - Linux 的 xrdp：3389
  - macOS 螢幕共享：5900（要在「VNC 檢視器可以使用密碼控制螢幕」設好密碼）
  - TigerVNC / x11vnc：5900 加上 display 編號（`:1` = 5901）
  - RustDesk：IP 直接存取，埠 21118（見 [RustDesk](#rustdesk)）
- **一個你能用的裝置帳號**：它只用在 SSH 進裝置的那一跳，不是桌面的登入。你在那台裝置上一個都沒有的話，請通道的擁有者幫你開一個。

RDP 連線時用 `security=any` 和 `ignore-cert=true`。如果那台 Windows 要求網路層級驗證（NLA），帳密就得完全正確，網域也要對。

## 連到 RDP 或 VNC

1. 打開「遠端桌面」，選好裝置。表單最上面是一張路徑圖，跟終端機頁的一樣：你的瀏覽器 → Telepy → 裝置 → 桌面。
2. 在路徑圖裡選「桌面在」（裝置本身，或它區網裡的電腦）、裝置帳號、「協定」和「埠」。
3. 填登入資料：「桌面使用者」、「密碼」，Windows 再加「網域」。也可以直接挑一組「已存的登入」。
4. 確認下面的「畫質」、「剪貼簿」、「聲音」和「顯示」。它們一開始就是你存過的偏好。
5. 按「連線」。

登入桌面這件事是 Telepy 在伺服器那端做的。你的密碼只為了這次連線送出，連線期間放在記憶體裡，不會存起來，除非你勾了「幫這個桌面存下這組登入」。

如果這條通道設定成開連線前要再確認一次（step-up），Telepy 會先請你用第二道驗證確認。

連上之後，頁面會捲到讓畫面剛好在頁首下方。點一下畫面就能打字。

## 畫面

### 畫質

| 預設 | RDP | VNC |
|---|---|---|
| **自動**（預設） | 平滑字型，其他交給 guacd 判斷 | 不加額外設定 |
| **流暢優先** | 16 位元色彩，不平滑字型 | 16 位元色彩，壓縮多一點 |
| **清晰優先** | 24 位元色彩，只用無損壓縮 | 24 位元色彩，最高品質，只用無損壓縮 |

通道慢的時候用「流暢優先」；「清晰優先」比較吃頻寬。想在 HiDPI 螢幕上看到更銳利的字，那是「顯示」裡另一個開關。選擇存在你的帳號上，偏好設定 → 遠端桌面看到的是同一個設定。

### 縮放

顯示設定有三個入口，改的是同一份：偏好設定 → 遠端桌面 → 顯示、連線表單的「顯示」欄，以及工具列的「顯示」選單。設定存在帳號上，所以你在哪個瀏覽器登入都一樣。

- **符合視窗**（預設）：整個畫面塞滿框框，遠端螢幕比較小也會放大。
- **只縮小不放大**：大螢幕縮小到放得下，小的維持 1:1。
- **實際大小（1:1）**：遠端一個像素對你螢幕一個像素（開 HiDPI 時對一個裝置像素）。滑鼠移到畫面邊緣，或用兩指拖曳，就能看到其他部分。
- **自訂 %**：25 到 400 % 之間都行。

模式會一直跟著：視窗變大變小時，「符合視窗」會重新塞滿，1:1 就維持 1:1。用工具列的 − / % / + 或兩指縮放，會切成固定的百分比。

### 解析度與 HiDPI

- **RDP 解析度**：「跟著視窗」（預設）讓遠端桌面就是畫面框的大小。調整視窗、佔滿視窗或全螢幕時都會跟著變；Telepy 會等框停住 400 ms 才去要新的大小。「固定大小」（1280×720、1600×900、1920×1080、2560×1440 或自訂）就維持那個大小，由瀏覽器縮放，從下一次連線開始生效。
- **HiDPI（裝置像素）**：在 Retina / HiDPI 螢幕上，要螢幕真正的像素數（最多 2 倍），字會更銳利。預設關：Windows 會跟著把介面放大，但 xrdp 和多數 VNC 伺服器不會，字就變得很小。連線中切換的話，跟著視窗的連線會馬上換大小。
- **VNC 也跟著視窗改大小**（預設關）：請 VNC 伺服器改成視窗的大小。只有虛擬桌面（TigerVNC Xvnc、KasmVNC）會照做，實體螢幕（x11vnc、macOS 螢幕共享、多數 Windows 伺服器）維持原本的解析度。預設關掉，是因為偷偷改掉別人實體螢幕的解析度，通常不會被當成驚喜。
- **RustDesk**：解析度由遠端決定，Telepy 只在瀏覽器裡縮放。
- **網站的上限**：管理員可以設最大解析度（長邊，預設 2560）。要求的大小超過時會等比縮小，連線當下和每次視窗變動都一樣。

### 佔滿視窗

「顯示」選單裡的「佔滿瀏覽器視窗」會蓋掉側欄和頁首，讓畫面大一點。它不是全螢幕：按 Esc 照樣是送給遠端桌面。工具列的「回到頁面」可以退出。全螢幕另外有自己的按鈕。

### 觸控螢幕與手機

- 兩指捏合縮放，兩指拖曳移動。
- 單指還是遠端的滑鼠：點一下 = 左鍵，長按 = 右鍵。
- 右上角有個小小的 − / % / + 膠囊，點百分比就回到符合視窗。最多至少能放大到 4 倍。
- 在手機上，被縮小的畫面（VNC，或固定解析度的 RustDesk）會從左上角以 1.5 倍打開，字才看得清楚。RDP 不會放大，因為它的解析度本來就跟著框。換新連線、換螢幕或區域、解析度變了，都會回到這個起始倍率。
- 只用滑鼠的話，什麼都不會變。

## 多螢幕只看其中一個（VNC）

VNC 伺服器會把所有螢幕拼成一張大畫面送過來（macOS 螢幕共享、x11vnc、TightVNC 都是這樣）。三個螢幕的話，就是一張超寬、字超小的桌面。guacd 又沒辦法挑螢幕，所以 Telepy 改在瀏覽器裡裁切，滑鼠點下去的位置一樣準。

工具列的「螢幕」選單有：

- 「整個桌面」
- 偵測到的每個螢幕，附名稱、大小，也標出哪個是主螢幕
- 「等分切法」：左半邊 / 右半邊、三等分、上半 / 下半，隨時都有
- 「自訂區域」：選「框選區域…」，再拖出想看的範圍（至少 64 px）。Esc 或「取消」就放棄；框選時鍵盤和滑鼠都不會送到遠端。
- 「重新偵測螢幕」

連上時，Telepy 會問裝置一次它的螢幕在哪。這只對裝置本身有用，區網裡的電腦問不到。裝置答不出有用的資訊時，Telepy 會從畫面形狀推測（螢幕的長寬比就那幾種），這些選項會標上「依畫面形狀推測」。你的選擇會按裝置或電腦記在這個瀏覽器裡。

RDP 用不到這些：RDP 連線的大小是 Telepy 決定的，永遠只有一個螢幕。

## 剪貼簿

在連線表單的「剪貼簿」欄或偏好設定 → 遠端桌面選方向，設定存在帳號上。

- **雙向**：你送出的文字會過去，遠端桌面上複製的文字也會回到你的剪貼簿。
- **只能貼進去**：文字只會送到遠端桌面，在那邊複製的東西留在那邊。
- **關閉**：兩個方向都不通。

RDP / VNC 用「貼上」按鈕送文字。RustDesk 則是分頁在前景時，你在自己電腦上複製的文字會自動送過去，遠端複製的文字顯示在工具列下方。

管理員可以設上限（「桌面剪貼簿上限」），實際用的是你的選擇和上限中比較窄的那個，超過上限的選項會變灰。RDP / VNC 由伺服器上的 guacd 把關；RustDesk 的資料流伺服器看不到裡面，所以由你分頁裡的 RustDesk 引擎套用：關閉時請那台 RustDesk 停用剪貼簿，只能貼進去時就不理遠端送回來的內容。

## 聲音

RDP 和 RustDesk 有聲音。VNC 永遠沒有：這個協定只認得畫面和輸入，天生就是一部默片。macOS 的螢幕共享就是 VNC，所以想聽 Mac 的聲音請用 RustDesk。

在連線表單打開「聲音」。預設是關的，因為聲音多吃頻寬，選擇也存在帳號上。

- **RDP**：連線時就決定。關著的話 guacd 連聲音通道都不會載入；連線中工具列只能靜音。
- **RustDesk**：連線中也能從工具列開關。關掉時是請裝置乾脆不要送聲音。
- 你的麥克風不會反過來傳過去。

### 聲音按鈕

| 狀態 | 意思 |
|---|---|
| **播放中** | 聲音有送到，正在播。 |
| **安靜** | 聲音通道開著，但遠端現在沒在放東西。 |
| **等待聲音** | 剛連上，等遠端打開聲音通道。 |
| **聲音被擋住** | 聲音有送到，但瀏覽器要等你點一下頁面才肯播。按「點一下啟用聲音」。 |
| **沒有聲音** | 連上 10 秒了，遠端還是沒打開聲音通道。 |
| **已靜音** | 你在這個分頁按了靜音。聲音照樣送來、直接丟掉，所以取消靜音時不會一口氣湧出來。 |

按鈕的提示，以及資訊對話框裡「聲音」那一條，都會說明原因。

### 開了聲音卻聽不到？

瀏覽器只讓被點過的網頁出聲。這條規矩擋掉了自動播放的廣告，偶爾也會順便擋到你。Telepy 會在你按「連線」的那一下就把聲音解鎖，所以通常直接就會響。如果還是被擋（Safari 最嚴格），按鈕會顯示「聲音被擋住」，旁邊多一顆「點一下啟用聲音」。

按鈕顯示「沒有聲音」，代表遠端根本沒送。通道的日誌也看得出來：那次連線的結束紀錄會寫 `no sound channel from the RDP server`。請檢查遠端電腦：

- **Windows（RDP）**：預設會轉送聲音，除非原則關掉了「允許音訊及視訊播放重新導向」。
- **Linux（xrdp）**：要裝 `pulseaudio-module-xrdp`（Debian / Ubuntu 沒有打包，要照它的說明從原始碼編）或 `pipewire-module-xrdp`。
- **Linux 上的 RustDesk**：錄的是已登入桌面工作階段的音效伺服器（PulseAudio / PipeWire）。沒人登入桌面，就沒有聲音。
- **Windows 上的 RustDesk**：錄預設輸出裝置正在播的聲音。
- **Apple 晶片 Mac 上的 RustDesk**：透過它本來就需要的「螢幕錄製」權限錄系統聲音。
- **Intel Mac 上的 RustDesk**：只錄「音訊輸入裝置」，預設就是麥克風，所以你聽到的會是那間辦公室的冷氣聲，不是 Mac 正在放的音樂。請裝 BlackHole 這類回送（loopback）裝置，再到 RustDesk 的設定 → 一般 → 音訊輸入裝置選它。

RustDesk 的聲音還需要瀏覽器能用 WebCodecs 解碼音訊。不支援的話，聲音按鈕會停用並說明原因。

## 鍵盤與輸入法

- **輸入法直接能用**：中文、日文這類要選字的輸入，跨系統也打得進去，例如從 Windows 的瀏覽器打進 Mac 的螢幕共享。選好的字會以 Unicode 字元送出，RDP 和常見的 VNC 伺服器（macOS 螢幕共享、x11vnc、TigerVNC、TightVNC）都收。
- **鍵盤 → 送出文字…**：遠端還是不理選好的字時，在這個對話框用你自己的輸入法打。每個字元都會當成一次按鍵送出，換行就是 Enter。內容不會存起來。
- **貼上**：最後的手段，把文字送到遠端的剪貼簿。
- **Ctrl 當作 ⌘ Command**（RDP / VNC）：連 macOS 桌面時，Ctrl+C 到那邊會變成 ⌘C。裝置是 Mac、你的瀏覽器不是 Mac 時預設打開，選擇會記在這個瀏覽器。按著鍵的時候切換，也不會讓修飾鍵卡住。
- **Ctrl+Alt+Del**：RDP 和 RustDesk 的「鍵盤」選單裡都有。

## RustDesk

RustDesk 講自己的協定，guacd 聽不懂。Telepy 用兩種方式連它，兩種都走通道：在瀏覽器裡連（協定選「RustDesk」時的預設），或用 RustDesk app 經轉發的埠連。

不管哪一種，都不需要 RustDesk 的 ID 伺服器或中繼伺服器：Telepy 經由裝置，直接連到那台機器上的 RustDesk。

### 讓那台電腦的 RustDesk 準備好

選 RustDesk 時，頁面會先從裝置檢查 RustDesk 有沒有回應，再列出一份清單。每一步都有一張 RustDesk 畫面的小示意圖，用 RustDesk 自己的字樣標出要點哪裡（「看要點哪裡」）。只有現在該看的那一步會展開；在這裡成功連過一次後，清單就收成一行。

1. **RustDesk 開著，而且接受直接連線**：在 RustDesk 的設定 → 安全 → 「解鎖安全設定」，再勾選「啟用 IP 直接存取」（埠 21118）。RustDesk 要一直開著。
2. **RustDesk 接受的固定密碼**：同一頁的「密碼」選「同時使用兩種密碼」（不要選「使用一次性密碼」），再按「設定固定密碼」。一次性密碼非常好用，前提是你只打算連一次。
3. **顯示與操作畫面的權限**（Mac）：系統設定 → 隱私權與安全性，在「螢幕錄製」和「輔助使用」打開 RustDesk。沒開的話畫面會是黑的，或滑鼠沒反應。
4. **關掉或重開機後也連得到**（建議）：在 RustDesk 提示的地方安裝它的系統服務。沒裝的話，app 一關它就停，重開機後也不會自己回來。

聲音開著、而且上一次連的是 Mac 時，還會多出一步「Mac 的聲音」（見[聲音](#聲音)）。

### 在瀏覽器裡連線

輸入「RustDesk 密碼」，按「在瀏覽器裡連線」。密碼只留在你的瀏覽器：RustDesk 的驗證挑戰由分頁裡的 RustDesk 引擎自己回答，Telepy 只負責轉送。

能用的有：畫面、滑鼠和鍵盤、剪貼簿文字、切換螢幕、畫質、聲音和檔案。沒有終端機、遠端列印和麥克風，這些請用 RustDesk app。

- **「螢幕」選單**：遠端自己的各個螢幕（由 RustDesk 原生切換），還有畫質。流暢優先 / 自動 / 清晰優先對應 RustDesk 自己的 low / balanced / best。
- **「鍵盤」選單**：送出文字…和 Ctrl+Alt+Del。
- 延遲按鈕顯示 RustDesk 引擎自己量到的數字（延遲、每秒幀數、目標位元率），再加上通道的延遲。
- RustDesk 會要求確認「未加密的直接連線」。Telepy 會自動幫你確認，因為整條路本來就在 TLS 和 SSH 通道裡。
- 一個頁面只能開一個 RustDesk 畫面。
- RustDesk 連線不會因為閒置被斷；網站的閒置逾時只管 RDP / VNC。

需要支援 WebCodecs 的瀏覽器：新版的 Chrome、Edge 或 Safari。

### 檔案

在瀏覽器裡的 RustDesk 連線，工具列上會有「檔案」按鈕。寬螢幕時面板在畫面右邊，手機上在下面。它用的是 RustDesk 自己的檔案傳輸，走另一條連線，由 Telepy 經通道中繼，每個檔案最多 2 GB。

- **瀏覽**：麵包屑路徑（Windows 的最上層是各個磁碟機）、「上一層」、「家目錄」、「顯示隱藏檔」。
- **上傳**：上傳檔案，或「上傳資料夾」（直接拖資料夾進來也行，而且會保留空資料夾）。會先建好資料夾，已經存在也沒關係。
- **下載**：下載單一檔案，或用「下載成 .zip」把整個資料夾打包。Telepy 會先數裡面有什麼，超過 500 個檔案或 2 GB 時先問你。空檔案和空資料夾也會一起打包。
- **重新命名**：輸入新名字，或是像 `../archive/name` 這樣的路徑，就能在同一顆硬碟裡搬移。對話框會即時顯示搬到哪裡，按鈕也會變成「搬移」。
- **新資料夾**與**刪除**（可以多選）。刪資料夾前會先告訴你裡面有幾個檔案、總共多大，隱藏檔也算進去。RustDesk 沒有資源回收筒，刪了就是刪了。
- **傳輸清單**：顯示進度和速度，可以取消；遇到同名檔案會問你要「略過」還是「取代」。

瀏覽器的差別：Chrome 和 Edge 會直接寫進你選的檔案，再大的 zip 都行。Firefox 和 Safari 沒有存檔對話框，所以下載會先收在記憶體裡，資料夾的 zip 不能超過 2 GB。裝置回報錯誤時，會原封不動的顯示它的訊息。

面板的資訊按鈕（「檔案怎麼走」）會畫出整條路：你的瀏覽器 ─ Telepy ─ 通道 ─ 裝置上的 RustDesk ─ 硬碟。

只有開這個畫面的人能打開它的檔案面板，畫面結束時檔案連線也一起結束。管理員可以在整個網站關掉「RustDesk 檔案傳輸」：面板會消失，中繼也會拒絕檔案傳輸的登入，所以不只是把按鈕藏起來而已。刪除和重新命名都會寫進通道的日誌（只有路徑和數量，不含內容）。

### 改用 RustDesk app

展開「想用 RustDesk app？」，Telepy 會把 RustDesk 的 IP 直接存取埠轉發到你的電腦，app 連 `127.0.0.1` 就好。這樣 RustDesk 自己的功能（檔案傳輸、聲音、它的工具列）都照常能用。

1. 按「從裝置檢查」，確認裝置連得到 RustDesk。
2. 在你的電腦上執行畫面上的指令，並讓它保持開著：

   ```
   ssh -L 21118:<host>:21118 <alias>
   ```

3. 在 RustDesk app 的 ID 欄輸入 `127.0.0.1`（本機埠不是 21118 的話就輸入 `127.0.0.1:<port>`），用固定密碼登入。

轉發埠需要你在那台裝置上有裝置帳號。「指令速查」的「用 RustDesk」情境有完整選項（RustDesk 所在主機、RustDesk 埠、本機埠）。區網掃描也會找 21118 埠，「網路拓撲」頁的「指令」分頁會列出 RustDesk 機器的 `-L` 指令。

## 已存的登入

連線時勾「幫這個桌面存下這組登入」，下次在「已存的登入」選它就好。偏好設定 → 已存的登入可以查看和刪除。

- **只屬於你**：別人看不到也用不到，管理員也一樣。
- **一筆對一個桌面**：每筆都綁定它的通道和協定，有設定的話還有區網裡的那台電腦和埠。Telepy 不會拿去別的地方用，所以一組 Windows 密碼不會跑去登入另一台機器。
- **在伺服器上加密**：金鑰由伺服器的 `SECRET_KEY` 衍生。密碼存了就不會再顯示，只有在你連線時才解開。管理員換了 `SECRET_KEY` 的話，舊的登入就解不開了，重新存一次即可。
- **RustDesk 是唯一的例外**：RustDesk 的密碼要由瀏覽器裡的引擎去驗證，所以那一次連線時，Telepy 會把它解開，經 TLS 交給引擎。不會寫進紀錄，也不會留在頁面裡。
- 刪掉通道或區網裡的那台電腦，綁在上面的登入也會一起刪。日誌裡那次連線的紀錄會寫出用了哪一筆（只有名稱）。

同一個保管庫也存區網電腦的 SSH 登入，那是終端機的事，這裡不談。

## 看看現在發生什麼事

![遠端桌面連線的即時路徑與上面跑的資料流](images/zh-TW/desktop-flow.png)

頁面的資訊按鈕（「怎麼運作」）會畫出即時的路徑：你的瀏覽器 ─ Telepy ─ 裝置 ─ 桌面。每一點都標著等待中、進行中、正常或失敗，出問題時一眼就知道卡在哪一段。連線中，每一段線上都標著往返時間，最慢的那段變黃色。在瀏覽器裡連 RustDesk 和用 app 的路線，圖也會跟著換。

下面的「這條連線上走什麼」畫了五條線（畫面、鍵盤與滑鼠、剪貼簿、聲音、檔案），每條都有狀態和一句原因：

- **開**，或**單向**（剪貼簿設成只能貼進去）
- **關**：你自己關的，或在這個分頁靜音了
- **被網站上限擋下**：管理員設的上限
- **這種連法沒有**：VNC 沒有聲音、RDP / VNC 不能傳檔、瀏覽器不支援 WebCodecs 音訊
- 聲音還有**等待中**和**沒有到**；RustDesk 的檔案則列出下載、上傳、重新命名、刪除各自的狀態

### 延遲與串流狀況

工具列的延遲按鈕顯示訊號格、畫面往返時間和一個詞：「串流中」、「延遲中」、「沒有資料」或「靜止」。點開會看到數字：

- **畫面往返**：一幀畫面從 Telepy 送出，到你的瀏覽器畫完並回覆為止。這就是你感覺到的「卡」。桌面靜止時是空的。
- **網路往返**：你的瀏覽器 ↔ Telepy，不含繪製。
- **Telepy ↔ 裝置**：通道本身，每 15 秒量一次。
- 每秒幀數、畫面資料、你的輸入、聲音資料、「待畫的幀」（送出了但還沒畫），以及 guacd 因為瀏覽器跟不上而合併了幾幀。
- 遠端畫面的大小和縮放比例，再加一句話告訴你延遲主要在哪：網路、通道，還是你的瀏覽器畫得太慢（把視窗縮小、改用「流暢優先」或關掉其他分頁會有幫助）。

RustDesk 的影像在瀏覽器裡解碼，所以沒有畫面往返和待畫的幀；網路往返是 RustDesk 自己量的瀏覽器 ↔ 裝置數字。

## 疑難排解

### 一按連線就失敗

Telepy 會在畫面出來之前先把通往桌面的路打通，所以大部分問題在你按下「連線」的那一刻就會出現：

| 頁面上寫 | 怎麼辦 |
|---|---|
| 裝置離線 | 它到 Telepy 的通道沒連上，先讓裝置回來。 |
| 裝置不接受 Telepy 用某帳號登入的金鑰 | 把 Telepy 的服務金鑰加到那個帳號的 `authorized_keys`。 |
| 裝置的 SSH 伺服器不允許轉發 | 在它的 `sshd_config` 設 `AllowTcpForwarding yes`，再重新啟動 sshd。 |
| 裝置出示了不同的 SSH 主機金鑰 | 先到通道的詳細資訊核對，確認後再信任。 |
| 裝置連不到某個位址 | 確認 RDP / VNC 伺服器有在執行，而且在那個埠上等待連線。 |
| 遠端桌面的名額都在使用中 | 網站的上限滿了，稍等一下再試。 |
| 這台伺服器關閉了遠端桌面 | 管理員把它關了。 |
| Telepy 的桌面引擎（guacd）沒有在執行 | 請管理員把它啟動。 |
| 桌面拒絕了登入 | 確認使用者、密碼和網域。 |

### 畫面或字太小

- 用「符合視窗」，不要用「只縮小不放大」。
- 開了「HiDPI」而遠端是 xrdp 或 VNC 的話，把它關掉：這些伺服器不會把介面放大。
- 固定大小的 RDP 會被縮進框裡，改成「跟著視窗」。

### 中文或日文打不進去

試試「鍵盤 → 送出文字…」。如果是 Linux 上的 RustDesk，確認 RustDesk 執行時有設定語系（`LANG`）：在 C 語系下它會拒收多位元組文字，日誌裡會出現 `Invalid multi-byte sequence encountered`。這是裝置那邊的環境問題，Telepy 這頭修不了。

### RustDesk 連不上

- **21118 埠沒有回應**：RustDesk 沒開，或「啟用 IP 直接存取」沒打開。
- **密碼被拒絕**：用固定密碼，並確認密碼設定不是「使用一次性密碼」。
- **沒有畫面可以顯示，或畫面全黑**：沒有人登入桌面工作階段，或（Mac 上）沒給「螢幕錄製」/「輔助使用」權限。
- **引擎起不來**：瀏覽器需要 WebCodecs（新版的 Chrome、Edge 或 Safari）。

聲音的問題請看[開了聲音卻聽不到？](#開了聲音卻聽不到)。

### 連線為什麼斷了？

連線結束時，頁面會告訴你原因。下面是背後的代碼：

| 代碼 | RDP / VNC | RustDesk |
|---|---|---|
| 4404 | 連線或它的票證無效或過期 | 票證無效或過期 |
| 4403 | 你已經沒有權限（通道或裝置帳號） | 被權限或登入守門擋下 |
| 4011 | 連不上 guacd，或握手失敗 | — |
| 4013 | guacd 斷線，或送來壞掉的資料 | 裝置關掉了連線 |
| 4014 | 伺服器結束：閒置或被停止 | 被伺服器停止；檔案連線另外會因為畫面結束、檔案傳輸被關、或被新的一條取代而結束 |
| 4400 | 瀏覽器送了看不懂的東西 | 協定錯誤 |
| 4009 | 從「即時連線」被結束（原因會寫是誰），或失去權限（`Telepy (access changed)`） | 同左 |
| 4010 | 開它的那個瀏覽器登入被登出（原因：user / admin / logout / reuse / disabled） | 同左 |

guacd 自己的錯誤，例如 0x0203 / 0x0301（RDP 登入被拒），頁面會翻譯出來，並標出卡在哪一段。

## 誰看得到、什麼時候會被結束

- **日誌**：每次連線都會在通道的日誌寫一筆開始、一筆結束：用了多久、為什麼結束、送了多少到瀏覽器（例如「12.3 MB to the browser, 2,340 frames, frame latency avg 48 ms (max 210 ms)」）、聲音有多少，以及 guacd 最後的錯誤。RustDesk 的紀錄有兩個方向的流量，RustDesk 的刪檔和重新命名也各有紀錄。
- **「N 人使用中」**：擁有者和有 Admin 權限的分享對象，在通道列表上看得到誰開著桌面，以及用的是哪個裝置帳號。
- **「即時連線」**：列出這些連線，也能把某一條結束掉，對方會看到是誰結束的。管理員另有「全站即時連線」。
- **失去權限就結束**：取消分享、分享到期、權限降低、帳號允許清單變小、裝置帳號改名或刪除、功能被關、帳號被停用，Telepy 都會馬上檢查，之後每 10 秒再檢查一次。連線會以 `Telepy (access changed)` 關閉，日誌寫明原因，本人也會收到通知。
- **登出也會結束**：開這個桌面的瀏覽器登入被登出時（從「你的裝置」登出、被管理員登出、或帳號被停用），桌面會立刻關掉。
- 連線也可能被伺服器停止；RDP / VNC 另外會在網站的閒置逾時到了時斷線。

## 給管理員

### 網站設定

網站設定 → 遠端桌面：

| 設定 | 預設 | 作用 |
|---|---|---|
| 允許遠端桌面（`desktop_enabled`） | 開 | 關掉就不能開新的連線，已開著的不受影響。 |
| 同時桌面數上限（`desktop_max_sessions`） | 4 | 整個網站合計，RDP / VNC 和 RustDesk 一起算，正在開的也算。0 = 不限。 |
| 桌面閒置逾時（`desktop_session_idle_timeout`） | 900 秒 | 多久沒有鍵盤、滑鼠或剪貼簿輸入就斷線。0 = 不斷。只管 RDP / VNC。 |
| 桌面剪貼簿上限（`desktop_clipboard`） | both | 最多能開到哪個方向：`both` / `to_remote` / `off`。每個人在這個範圍內自己選。 |
| 解析度上限（`desktop_max_resolution`） | 2560 | 長邊的像素數（640–16384）。超過就等比縮小，連線時和連線中都一樣。 |
| RustDesk 檔案傳輸（`desktop_file_transfer`） | 開 | 關掉會隱藏「檔案」面板、讓中繼拒絕檔案傳輸的登入，並關掉開著的檔案連線。 |

### 執行 guacd

`docker-compose.yml` 用 `guacamole/guacd:1.6.0` 跑 `guacd` 服務，它只在一個內部網路（`telepy-desktop-${PROJECT_NAME}`）上，而那個網路只有 backend 跟它共用。相關的環境變數有兩個：

- `GUACD_ADDR`：backend 去哪裡找 guacd（預設 `guacd:4822`）。
- `DESKTOP_CALLBACK_HOST`：guacd 連回 backend 時用的名字（compose 裡是 `backend`；沒設就用容器的 `HOSTNAME`）。

## 底下怎麼運作

用白話講，一次 RDP / VNC 連線是這樣走的：

1. 瀏覽器請 Telepy 開始。Telepy 檢查你的權限，然後馬上經由裝置把通往桌面的路打通，所以「裝置離線」或「那個埠沒人回應」會立刻出現。瀏覽器拿到一張一次性的票證，60 秒內有效。
2. 瀏覽器拿票證開 WebSocket。Telepy 再檢查一次，在伺服器上透過 guacd 登入桌面（密碼不會再傳回瀏覽器），再把 guacd 接到第 1 步打通的那條路。
3. 畫面往瀏覽器流，鍵盤、滑鼠和剪貼簿往回流。瀏覽器只能送輸入，不能自己對 guacd 下其他指令。

guacd 在一個只有 backend 進得去的內部網路上，它也從來不直接連裝置。每次連線，guacd 會連回 backend 上一個只用一次的埠，backend 再把它接進裝置現有 SSH 連線上的一條通道。到了裝置那邊，sshd 會連 `127.0.0.1:<port>`（裝置自己的桌面），或區網電腦的位址，跟 `ssh -J` 和區網掃描用的是同一套機制。

在瀏覽器裡連 RustDesk 則不太一樣。RustDesk 的引擎（社群把 RustDesk 網頁版用 TypeScript 移植過來的版本，AGPL-3.0，隨 Telepy 一起提供）以為自己在跟 ID 伺服器和中繼伺服器說話，其實兩條都接到 Telepy 上的同一個 WebSocket，Telepy 再把中繼那一半交給裝置的 IP 直接存取埠。Telepy 自己不跑任何 RustDesk 伺服器。

這一節接下來是給 API 使用者和貢獻者的參考資料。

<details>
<summary>架構圖（RDP / VNC）</summary>

```
瀏覽器（guacamole-common-js）
  │ wss /ws/desktop/<session>/?ticket=…&width=&height=&dpi=   子協定 guacamole；票證 60 秒、只能用一次
  ▼
backend（桌面 WebSocket）
  │  瀏覽器 → guacd：只放行 key / mouse / touch / size / sync / nop / disconnect / clipboard / blob / end / ack
  │  guacd → 瀏覽器：直接轉送（長度依兩端重新編碼：guacd 數碼點，瀏覽器數 UTF-16 單位）
  │  TCP guacd:4822：Guacamole 握手在 backend 做完，帳密不會回到瀏覽器
  ▼
guacd 容器（內部網路，只跟 backend 共用）
  │  連回 backend 上這次連線專屬的 rendezvous 埠（只收 guacd 的位址、收到一條就關）
  ▼
backend 橋接
  │  雙向複製 ⇄ 裝置共用 SSH 連線上的一條 direct-tcpip 通道（不占 session 名額）
  ▼
裝置 sshd ──► 127.0.0.1:<port>（裝置自己的桌面）或 <區網位址>:<port>（區網裡的電腦）
```

握手完成後，backend 會先送 `0.,<uuid>;`（guacamole-common-js 收到這個才會把 tunnel 標成開啟），再把握手期間已經讀進來的指令送出去（guacd 常把 `ready` 和第一批畫面塞在同一個封包）。

</details>

<details>
<summary>API 參考</summary>

**RDP / VNC**

- `POST /api/reverse/server/{id}/desktop/start`，內容 `{protocol, username?, port?, lan_host_id?, login?, password?, domain?, credential_id?, quality?, clipboard?, audio?, resize?}`。
  - 檢查：遠端桌面有開、你對這條通道有 VIEW、敏感通道的 step-up、`username` 在你能用的裝置帳號裡（沒帶就用預設的）、區網主機屬於這條通道，以及網站上限。
  - 錯誤：502 `device_offline` / `device_auth` / `host_key_changed` / `forwarding_disabled` / `target_unreachable` / `device_unreachable`；503 `desktop_disabled` / `desktop_busy`；已存的登入屬於別的目標時，`credential_id` 欄位錯誤；`audio` 不是布林值時也是欄位錯誤。
  - 回傳 `{session_id, ws_path, ticket, expires_in, protocol, clipboard, clipboard_limit, quality, audio, resize, max_resolution, target, username}`。`clipboard` 和 `audio` 是實際生效的值（VNC 的 `audio` 一律是 `false`）。
  - 沒帶 `clipboard` 就用你的個人設定，再套上網站的上限。`credential_id` 會取代 `login` / `password` / `domain`。
  - `quality`：`auto` / `speed` / `sharp`。`resize: false` = 固定大小；VNC 帶 `resize: true` 則是請伺服器跟著視窗改大小。
- `/ws/desktop/<session>/?ticket=…&width=&height=&dpi=`：WebSocket，子協定 `guacamole`。關閉代碼也會放進關閉原因，因為 guacamole-common-js 只讀原因。
- `POST /api/reverse/server/desktop/{sid}/stop`：結束連線（4014）。
- `GET /api/reverse/server/{id}/desktop/screens?username=`：裝置的螢幕，關卡跟 start 一樣。回傳 `{os, source, screens: [{name, x, y, width, height, primary}], username}`；查不到不算錯誤（`screens: []`）。
- `GET /api/reverse/server/{id}/desktop/probe?port=&username=&lan_host_id=`：從裝置檢查某個埠有沒有回應。關卡和路徑都跟 start 一樣，連上就馬上關；不看 `desktop_enabled`。

**RustDesk**

- `POST /api/reverse/server/{id}/rustdesk/start`，內容 `{username?, port?, lan_host_id?, credential_id?, clipboard?}`。關卡跟桌面的 start 一樣；網站上限把 RDP / VNC 和 RustDesk 合起來算。回傳 `{session_id, ws_path: "/ws/rustdesk/{sid}/", ticket, expires_in, target, username, clipboard, clipboard_limit, file_transfer}`，帶了 `credential_id` 時另外有 `password`。
- `/ws/rustdesk/{sid}/?ticket=`：引擎連進來的 WebSocket（會連兩次）。
- `POST /api/reverse/server/rustdesk/{sid}/stop`：結束連線（4014）。
- `POST /api/reverse/server/rustdesk/{sid}/files`：在已連上的畫面連線底下開一條檔案連線。409 `not_connected`、503 `file_transfer_disabled` / `desktop_disabled`、502 同 start。

**已存的登入**

- `GET /api/credentials`（可用 `tunnel_id` / `lan_host_id` / `protocol` 篩選）、`POST`、`PATCH /api/credentials/{id}`、`DELETE`。只有本人能用。
- 欄位：`protocol`（`rdp` / `vnc` / `rustdesk`；`ssh` 那種屬於終端機）、`tunnel_id`、選填的 `lan_host_id` / `port`、`label`、`login`（RustDesk 留空）、`domain`，以及密碼。回應只有 `has_password`（`ssh` 那種另有 `has_key`），永遠不回傳密碼。

**你的偏好**（`/api/user/settings`）

- `desktop_clipboard`：`both` / `to_remote` / `off`；回應裡另有唯讀的 `desktop_clipboard_limit`（網站的上限）。
- `desktop_display`：一個 JSON 物件 `{scale, percent, resolution, width, height, hidpi, vnc_resize, quality, audio}`。`scale` 是 `fit` / `shrink` / `actual` / `custom`。不認得的欄位或超出範圍的值是欄位錯誤，`percent` 會夾在 25–400，空的代表還沒選過。登入時以帳號上的值為準；帳號還沒有的話，就拿這個瀏覽器之前的選擇上傳。

</details>

<details>
<summary>實際向 guacd 要了什麼</summary>

| 選擇 | 送給 guacd 的 |
|---|---|
| 畫質「自動」 | RDP 照舊（平滑字型）；VNC 不加參數 |
| 畫質「流暢優先」 | RDP `color-depth 16`、不平滑字型；VNC `color-depth 16`、`compress-level 6`、`quality-level 5` |
| 畫質「清晰優先」 | RDP `color-depth 24`、`force-lossless`；VNC `color-depth 24`、`quality-level 9`、`force-lossless` |
| 跟著視窗（RDP） | `resize-method display-update`；框停住 400 ms 後才送瀏覽器的 `size` |
| 固定大小（RDP） | 不帶 resize method；中繼丟掉瀏覽器的 `size` |
| HiDPI | devicePixelRatio（≤ 2）倍的像素，再加上 `dpi` |
| VNC 不跟著改大小 | `disable-display-resize`（否則 guacd 1.6 連線時就會送 SetDesktopSize） |
| 剪貼簿 | `disable-copy` / `disable-paste` |
| 聲音開（RDP） | 握手的 `audio` 指令列出 `audio/L8` 和 `audio/L16` |
| 聲音關（RDP） | `disable-audio=true`，rdpsnd 根本不會載入 |

每個要求的大小，連線時和連線中都一樣，會等比縮到長邊不超過網站上限。guacd 的音訊串流（`audio` / `blob` / `end`）原樣轉送，瀏覽器可以回 `ack`；瀏覽器送來的 `audio`（麥克風）會被丟掉。

</details>

<details>
<summary>串流統計怎麼傳</summary>

中繼每秒會給瀏覽器兩個自家的指令。guacamole-common-js 會忽略不認得的 opcode，頁面也會在交給 Guacamole client 之前先攔下來。

| 指令 | 內容 |
|---|---|
| `telepy-ping <n>` | 瀏覽器立刻回 `telepy-pong <n>`；中繼算出網路往返，絕不轉給 guacd。 |
| `telepy-stats <json>` | `{ms, frame_ms, net_ms, tunnel_ms, frames, merged, down, up, behind, audio}` |

- `frame_ms`：guacd 每一幀結尾送 `sync <ts>`，瀏覽器畫完那一幀才回同一個 `sync`。3 秒沒有新樣本就是 null。
- `net_ms`：ping / pong，不含繪製。
- `tunnel_ms`：monitor 每 15 秒量一次的裝置 sshd 往返。
- `frames` 是每秒幀數；`merged` = 一次 `sync` 併了幾幀（guacd 1.6 的第二個參數；大於 1 = 瀏覽器跟不上）；`behind` = 送出但還沒回音的幀；`down` / `up` = 這一秒的位元組數。
- `audio`：guacd 聲音串流上的位元組數；從沒開過聲音串流就是 null。

</details>

<details>
<summary>螢幕怎麼偵測、怎麼猜</summary>

透過裝置的 SSH 連線問它：

- 先跑 `uname -s`；Darwin 跑 `system_profiler SPDisplaysDataType -json`（只有大小，沒有位置）；
- 其他 POSIX 系統跑 `xrandr --listmonitors`（依序試 `$DISPLAY`、`:0`、`:1`）；
- 沒有 `uname`：跑 PowerShell `[System.Windows.Forms.Screen]::AllScreens`。

擺位置：有位置的螢幕先平移到 (0,0)；如果總和跟畫面形狀相同但大小不同（Windows 的顯示縮放），就等比縮放。只有大小沒有位置的（macOS）從整張畫面推：寬度加起來等於畫面寬就是左右並排，高度加起來等於畫面高就是上下疊，比較矮的螢幕靠上還是靠下，看畫面的黑色區域決定。

猜測用在裝置答不出有用資訊的時候（區網裡的電腦、偵測失敗、Xvfb 只回報一個涵蓋全部的螢幕）。螢幕的長寬比就那幾種（16:9、16:10、MacBook ≈ 1.545、3:2、4:3、5:4、21:9），所以：

- Telepy 把寬度切成 2–4 個等高、常見比例的螢幕（上下疊的就切高度），誤差不超過 0.5 %。先挑最貼合的，再挑比例相同的，再挑螢幕少的，每種排列順序都試。
- 比畫面矮的螢幕，用黑色帶子量出高度。這條帶子要在 9 個取樣欄位上都一致，量出來還要是常見比例才算數，所以黑色桌布騙不了它。
- 找不到等高的切法時（MacBook 1728×1117 旁邊接一台 2560×1440），就試「一個等高加一個比較矮」。
- 整張畫面本身就是一種常見比例的話（21:9 也算），就當成一個螢幕；3840×1080 算兩個 16:9。

選擇記在這個瀏覽器的 localStorage：`telepy.desktopScreen.<tunnel>.<lanHost|device>`，自訂區域在 `telepy.desktopArea.<…>`。

</details>

<details>
<summary>RustDesk 的中繼與登入守門</summary>

引擎會連 `/ws/rustdesk/{sid}/` 兩次，因為它的 ID 伺服器和中繼伺服器都設成這個網址。第一個二進位訊息決定角色：

- `punch_hole_request` = ID 伺服器的角色。backend 回一個 `relay_response`，裡面的中繼網址還是同一個，然後就等著，之後再有 punch 也照樣回。
- `request_relay` = 中繼的角色。它接手 start 時打通的那條通道，之後每個 WebSocket 訊息都在 RustDesk 的 TCP 分幀（1–4 位元組的長度前綴）之間來回轉換，每幀最多 16 MiB。

**登入守門**是中繼唯一會解析的東西，而且只看瀏覽器送給裝置的訊息最外層：

- `login_request` 在畫面連線上只能是遠端控制，在檔案連線上只能是檔案傳輸。其他的（埠轉發、相機、終端機、或種類不對）一律以 4403 關閉，日誌的結束紀錄會寫 `refused: …`。
- 帶內容的 `public_key`（也就是要求加密）會被拒絕。Telepy 代打的 ID 伺服器從不交出裝置的金鑰，所以只有被改過的 client 才會提出這種要求；而一旦加密，中繼就看不到它登入成什麼。反正整條路本來就在 TLS 和 SSH 裡。
- 畫面連線上的 `file_action` / `file_response` 會被拒絕（引擎只在檔案傳輸的連線上用它們）。
- 登入前送超過 32 個訊息會被拒絕。

所以關掉檔案傳輸是伺服器在把關，不只是少一顆按鈕。

其他細節：RustDesk 的密碼由引擎回答，不經過 backend；唯一例外是已存的密碼，只在那一次 start 的回應裡送出（走 TLS、不寫紀錄）。聲音關 = 登入前送出 RustDesk 的 `disable-audio` 選項，裝置根本不會啟動音訊服務；工具列的開關透過引擎的選項切換。剪貼簿關 = 那台的 `disable-clipboard`；只能貼進去 = 丟掉遠端送來的剪貼簿事件。日誌的紀錄是 `rustdesk_open` / `rustdesk_close`。

當初選這個設計時的實測（1280×800、畫面動很多）：經中繼的引擎跑 28 fps / 約 645 KB/s，guacd 的 VNC 是 4–5 fps / 0.5–1.3 MB/s。筆記在 [`rustdesk-spike.md`](engineering/rustdesk-spike.md)。

</details>

<details>
<summary>RustDesk 檔案面板怎麼做的</summary>

- RustDesk 用另一條登入時就說明要傳檔的連線來搬檔案。面板會在畫面連線底下要一條子連線：同一個目標和帳號，有自己的票證和 SSH 通道。它不算進網站上限，不會出現在「即時連線」，也不發 webhook。一個畫面最多兩條，再開一條就關掉最舊的（重新整理時會短暫重疊），畫面結束它就跟著結束。
- 同一個 RustDesk 引擎裡只有最上層的連線收得到影像，所以在那裡開檔案連線會讓畫面凍住。面板因此在同一個頁面的隱藏 iframe 裡另外載入一份引擎，操作它的檔案 API（`read_remote_dir`、`send_files`、`select_files` + `send_local_files`、`confirm_override_file`、`cancel_job`）。
- 選檔對話框要在你的點擊裡打開：存檔對話框在頁面上開，再把拿到的 handle 交給 iframe；上傳則用頁面自己的檔案輸入框或拖放。
- 資料夾打包成 .zip（在分頁裡用 client-zip 產生，MIT 授權，串流 + ZIP64）：面板先遞迴列出資料夾，再用 `ReadEmptyDirs` 問有哪些空資料夾。這個訊息的回覆引擎看得懂，卻送不出去，所以由面板自己編好、送到引擎的 WebSocket 上（舊版 RustDesk 不會回，4 秒後就當作沒有）。引擎的資料夾下載會寫進一個代替用的資料夾 handle，每個檔案邊寫邊串進 zip。引擎不會為 0 位元組的檔案打開 handle，所以空檔案和空資料夾是事後依清單補進去的。
- 刪資料夾：先遞迴列出（含隱藏檔），一個個刪檔案，最後刪掉清空的資料夾（RustDesk 只刪空的樹）。
- 重新命名：裝置會把新名字接在原本的上層資料夾後面，所以 `../` 或絕對路徑就等於搬移。
- 每個動作都會等裝置對自己那個工作的完成或錯誤回覆。
- 稽核：檔案連線沒有加密（守門確保了這一點），所以中繼讀得到瀏覽器的要求和裝置的回覆，會寫 `rustdesk_file_delete` / `rustdesk_file_rename` 紀錄。刪一個資料夾合成一筆（「deleted folder /x (12 files)」，失敗時附上數量和第一個錯誤）；單一檔案和重新命名在裝置回覆後各寫一筆；連線結束時還沒回覆的也會寫出來。

</details>

<details>
<summary>給貢獻者的筆記</summary>

- **顯示為什麼是現在這樣**：用真的 guacd 1.6 配 xrdp、x11vnc、Xvnc 實測過。改版之前：
  - 畫面框是 `100dvh − 15rem`，而且不會捲進視野（現在是 `100dvh − 8.5rem`）；
  - 「符合視窗」上限是 1:1，小的 VNC 畫面永遠不會放大；
  - 「清晰優先」會順便要 HiDPI，結果在 Retina 上 x11vnc 1024×768 的畫面只畫成 512×384，xrdp 的字也只剩一半大；
  - 解析度上限是寬高分開夾（3080×1916 → 2560×1916，比例走樣），連線中的 `size` 還直接繞過上限；
  - 縮放按鈕只有觸控裝置才有。
- **聲音的自動播放**：guacamole-common-js 和 RustDesk 引擎都是在 WebSocket 訊息裡建立 AudioContext，沒有使用者手勢，所以瀏覽器會讓它停在 suspended（Safari 一律如此）。按「連線」的那一下（在第一個 await 之前）會建立並 resume 一個共用的 context；guacd 的播放器把它當成自己的 AudioContext 來源，RustDesk 引擎在檢視器掛著的期間也拿到同一個。用真的聲音驗證過（440 Hz 經 xrdp + pulseaudio-module-xrdp，以及 Linux 版 RustDesk 1.5），Chromium 和 WebKit 都試了。
- **RustDesk 的確認陷阱**：引擎同步觸發「不安全連線」的訊息框，之後才記下誰在等答案，所以在事件處理裡同步回答會被吃掉：連線卡住、裝置 30 秒後關掉，統計顯示「0 B to the device」。檢視器改成在下一個 tick 回答。
- **RustDesk 解析度，之後也許可以做**：網頁引擎的 `change_resolution` 沒有實作（`setByName change_resolution not implemented (phase 2)`）。自己編一個 `Misc.change_resolution`、像 `ReadEmptyDirs` 那樣送出去，RustDesk 就能跟著視窗（它的 Windows / Linux X11 端支援改解析度）。
- **「連線方式比較」對話框**的事實表放在前端，這裡的事實變了要記得一起改。
- **沒走的那條路**：曾經做過讓 Telepy 自己當 RustDesk 的 ID / 中繼伺服器的模式（裝置不需要通道），#201–#208 做好，#212 又拿掉，只留下其他功能都在走的通道路線。研究筆記：[`rustdesk-id-server.md`](engineering/rustdesk-id-server.md)。資料遷移 `2026-10-26-drop-rustdesk-server-devices` 刪掉了那個模式存的登入和兩張資料表。
- **測試**：`tests/desktop_api.rs`（假 guacd：握手、聲音、剪貼簿、解析度、失去權限）、`tests/rustdesk_api.rs`（假 RustDesk 裝置、登入守門、檔案和它的稽核），以及 `tests/credentials_api.rs`。對真 RustDesk / guacd 的瀏覽器端到端測試是手動跑的，沒有放進 repo。

</details>
