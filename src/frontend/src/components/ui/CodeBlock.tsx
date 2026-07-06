"use client";

import React, { useState } from "react";
// PrismAsyncLight：Prism 核心（refractor）改為「執行時動態載入」，且只註冊實際用到的語法。
// 舊寫法 `import { Prism } from "react-syntax-highlighter"` 會 `import refractor/all`（297 種語言），
// 靜態打包進 /tunnels、/tunnels/keys、/tunnels/create 的首屏 JS——約 226KB gzip（佔該路由首屏 JS 的 ~74%），
// 但 CodeBlock 只在 Modal 開啟時才渲染，載入時完全用不到。改用 async-light 後這塊 chunk 只在真的顯示
// 程式碼區塊時才下載，首屏 bundle 大幅縮小。ssh / txt 非 Prism 語言，會自動退回純文字（與先前行為一致）。
// PrismAsyncLight loads the Prism core at runtime and registers only the grammars we use, instead of
// bundling all 297 languages into the first-load JS of routes that merely *might* open a modal.
import { PrismAsyncLight as SyntaxHighlighter } from "react-syntax-highlighter";
import bash from "react-syntax-highlighter/dist/esm/languages/prism/bash";
import powershell from "react-syntax-highlighter/dist/esm/languages/prism/powershell";
import yaml from "react-syntax-highlighter/dist/esm/languages/prism/yaml";
import vscDarkPlus from "react-syntax-highlighter/dist/esm/styles/prism/vsc-dark-plus";
import { Copy, Check } from "lucide-react";
import { useI18n } from "@/lib/i18n";

// 只註冊會用到的語法：bash（ssh/autossh/docker-run/curl 腳本）、powershell、yaml（docker-compose）。
// Register only the grammars actually passed to CodeBlock; "ssh"/"txt" fall back to plaintext.
SyntaxHighlighter.registerLanguage("bash", bash);
SyntaxHighlighter.registerLanguage("powershell", powershell);
SyntaxHighlighter.registerLanguage("yaml", yaml);

interface CodeBlockProps {
    language: string;
    value: string;
}

export function CodeBlock({ language, value }: CodeBlockProps) {
    const { t } = useI18n();
    const [copied, setCopied] = useState(false);

    const copyToClipboard = () => {
        navigator.clipboard.writeText(value).then(() => {
            setCopied(true);
            setTimeout(() => setCopied(false), 2000);
        });
    };

    return (
        <div className="relative group rounded-md overflow-hidden bg-[#1e1e1e]">
            <div className="flex items-center justify-between px-4 py-2 bg-[#2d2d2d] text-gray-200 text-xs">
                <span className="uppercase">{language}</span>
                <button
                    onClick={copyToClipboard}
                    className="flex items-center gap-1 hover:text-white transition-colors focus:outline-none"
                    title={t("ui.copyToClipboard")}
                >
                    {copied ? <Check size={14} className="text-green-400" /> : <Copy size={14} />}
                    {copied ? t("common.copied") : t("common.copy")}
                </button>
            </div>
            <div className="text-sm overflow-x-auto">
                <SyntaxHighlighter
                    language={language}
                    style={vscDarkPlus}
                    customStyle={{ margin: 0, padding: "1rem", background: "transparent" }}
                >
                    {value}
                </SyntaxHighlighter>
            </div>
        </div>
    );
}
