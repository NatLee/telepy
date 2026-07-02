/**
 * 根版面：字型、Auth 與 Toast Provider、全域 metadata。
 * Root layout: fonts, Auth and Toast providers, global metadata.
 */
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/Toast";

// WOFF2（由 TTF 轉出，約小 55%）+ display:swap：文字先以系統字型立即顯示、字型到位後再換，
// 消除舊版 display:block「字型下載完前整頁隱形」的首屏空白（CJK 字型 2.2MB，慢網路差數秒）。
// 終端機字型不受影響：xterm 初始化前本就自行 await document.fonts.load（見 useTerminalPage）。
// WOFF2 (~55% smaller than the TTFs) + display:swap: render text immediately with a system
// fallback and swap when ready, instead of block's invisible-text period on first load.
const openHunInn = localFont({
  src: "../fonts/jf-openhuninn-2.1.woff2",
  variable: "--font-openhuninn",
  display: "swap",
});

const protoNerd = localFont({
  src: "../fonts/0xProtoNerdFont-Regular.woff2",
  variable: "--font-0xproto",
  display: "swap",
});

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "Telepy",
  description: "Telepy Reverse Proxy Dashboard",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${openHunInn.variable} ${protoNerd.variable} ${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        <ToastProvider>
          <AuthProvider>
            {children}
          </AuthProvider>
        </ToastProvider>
      </body>
    </html>
  );
}
