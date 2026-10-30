# Telepy 文件

<p align="center"><a href="./README.md">English</a> | <b>繁體中文</b> | <a href="./README.ja.md">日本語</a></p>

想知道 Telepy 是什麼、怎麼安裝，請先看[專案 README](../README.zh-TW.md)。下面的文件會講得更深入；
每一份都有英文、繁體中文和日文版本。

## 先看圖

- **[圖解 Telepy](./visual-guide.zh-TW.md)** — 應用程式資訊按鈕背後的圖，加上幾段錄影：新增與移除裝置、終端機、檔案、
  遠端桌面與瀏覽器、分享、指令規則、金鑰與 SSH 設定、通知、CLI、API 與 MCP、登入，以及伺服器狀態。

## 使用 Telepy

| 文件 | 內容 |
| --- | --- |
| [一行指令加入裝置](./device-join.zh-TW.md) | 加入腳本做了什麼、支援哪些裝置（Linux、macOS、OpenWrt）、會留下什麼、怎麼診斷 |
| [遠端桌面](./remote-desktop.zh-TW.md) | 經由 guacd 的 RDP / VNC，以及瀏覽器中的 RustDesk：畫質、顯示、剪貼簿、聲音、螢幕、檔案、儲存的登入 |
| [遠端瀏覽器](./remote-browser.zh-TW.md) | KasmVNC 中的 Chromium，流量從裝置出去；工作階段、限制、疑難排解 |
| [`telepy` 命令列與 API token](./cli.zh-TW.md) | 安裝與登入、所有指令、token 與權限範圍、呼叫紀錄 |
| [MCP](./mcp.zh-TW.md) | 連接 MCP 用戶端、核准流程、工具、互動式 shell、瀏覽器、指令規則、稽核 |
| [Webhooks](./webhooks.zh-TW.md) | 個人與全站 webhook、事件、格式、簽章、重試、退出 |

## 內部運作

| 文件 | 內容 |
| --- | --- |
| [後端如何連到裝置](./device-connections.zh-TW.md) | 共用連線、連接埠、主機金鑰固定、機器身分、每條通道專屬的服務金鑰、TCP / WebSocket / PROXY protocol、安裝名稱 |
| [延遲數字從哪裡來](./latency-deep-dive.zh-TW.md) | 每一段的來回時間怎麼量、怎麼顯示 |
| [效能測試：Django 對 Rust](./benchmarks.zh-TW.md) | 後端改寫的實測數字 |
| [README 截圖是怎麼做的](./screenshots/README.zh-TW.md) | 這些文件裡每張圖背後的示範伺服器 |

## 工程筆記

以原本撰寫時的繁體中文保存：[Rust 後端遷移計畫](./rust-migration-plan.md)、
RustDesk 研究（[spike](./rustdesk-spike.md)、[ID / 中繼伺服器](./rustdesk-id-server.md)）、
[Dropbear 用的 russh strict-kex 修補](./russh-dropbear-strict-kex.patch)，以及[文章](./articles/)。

版本說明在 [GitHub Releases](https://github.com/NatLee/telepy/releases)。
