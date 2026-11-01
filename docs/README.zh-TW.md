# Telepy 文件

<p align="center"><a href="./README.md">English</a> | <b>繁體中文</b> | <a href="./README.ja.md">日本語</a></p>

第一次來？Telepy 是什麼、怎麼安裝，請先看[專案 README](../README.zh-TW.md)。下面的文件講得更深入，每一份都有英文、繁體中文和日文版。

## 先看圖

[**圖解 Telepy**](./visual-guide.zh-TW.md) 收集了介面裡資訊按鈕背後的說明圖，加上幾段錄影。內容包括新增裝置、終端機、檔案、遠端桌面、分享、指令規則、金鑰、通知、CLI 與伺服器狀態。

## 使用 Telepy

| 文件 | 內容 |
| --- | --- |
| [一行指令加入裝置](./device-join.zh-TW.md) | 腳本做了什麼、支援哪些裝置、會留下什麼、失敗時怎麼辦 |
| [遠端桌面](./remote-desktop.zh-TW.md) | 瀏覽器裡的 RDP、VNC 與 RustDesk：畫質、剪貼簿、聲音、螢幕與檔案 |
| [遠端瀏覽器](./remote-browser.zh-TW.md) | 從裝置那頭上網的 Chromium、它的限制與疑難排解 |
| [命令列與 API token](./cli.zh-TW.md) | 安裝、登入、所有指令，以及 token 能做什麼 |
| [MCP](./mcp.zh-TW.md) | 連接 MCP 用戶端、核准流程，以及 agent 能做與不能做的事 |
| [Webhook](./webhooks.zh-TW.md) | 個人與全站 webhook：事件、格式、簽章與重試 |

## 內部運作

| 文件 | 內容 |
| --- | --- |
| [後端怎麼連到裝置](./device-connections.zh-TW.md) | 共用連線、主機金鑰檢查、機器身分，以及兩種連入方式（SSH 與 WebSocket） |
| [延遲數字從哪裡來](./latency-deep-dive.zh-TW.md) | 每一段怎麼量、怎麼顯示 |
| [效能測試：Django 對 Rust](./benchmarks.zh-TW.md) | 後端改寫的實測數字 |
| [README 截圖是怎麼做的](./screenshots/README.zh-TW.md) | 每張圖背後的示範伺服器 |

## 工程筆記

有些筆記維持當初寫下的樣子，只有繁體中文，連當時想錯的地方也原封不動：

- [Rust 後端遷移計畫](./engineering/rust-migration-plan.md)
- RustDesk 研究：[第一次試做](./engineering/rustdesk-spike.md)，以及[讓 Telepy 當 ID／中繼伺服器](./engineering/rustdesk-id-server.md)
- [文章](./engineering/articles/)

有一個修正還在等上游：讓 Dropbear 客戶端通過 russh 的嚴格金鑰交換（[issue #804](https://github.com/Eugeny/russh/issues/804)、[PR #805](https://github.com/Eugeny/russh/pull/805)）。

版本說明在 [GitHub Releases](https://github.com/NatLee/telepy/releases)。
