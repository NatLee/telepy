/**
 * 根版面：字型、i18n / Auth / Toast Provider、全域 metadata。
 * Root layout: fonts, i18n / Auth / Toast providers, global metadata.
 *
 * i18n 初始語言在 client 端解析(cookie → navigator.language),不在 server 讀 cookie:
 * 曾用 cookies()/headers() 做 SSR 語言,但那會讓**所有路由變 dynamic**,Link prefetch 失效、
 * 每次導覽都要等 server RSC 往返(頁面切換慢好幾秒)。現在路由保持 static;
 * <head> 的 inline script 會在第一次繪製前把 <html lang> 設對,I18nProvider 再以
 * useLayoutEffect 在 hydration 後、瀏覽器繪製前套用正確語言,登入後頁面都先顯示
 * auth spinner,實際上看不到語言閃爍。
 * Locale resolves client-side (cookie → navigator.language). Reading cookies() here made every
 * route dynamic (no full Link prefetch; slow navigations). Routes stay static; an inline script
 * sets <html lang> pre-paint and the provider applies the locale in a layout effect.
 */
import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/Toast";
import { I18nProvider, UserSettingsSync } from "@/lib/i18n";

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

export const metadata: Metadata = {
  title: "Telepy",
  description: "Telepy Reverse Proxy Dashboard",
};

// 繪製前先把 <html lang> 與主題 class 設好(語言:cookie → 瀏覽器語言;主題:localStorage →
// 系統偏好)。避免 dark 模式白屏閃爍與錯誤的 lang。必須是同步 inline script。
// Pre-paint bootstrap: set <html lang> (cookie → browser language) and the theme class
// (localStorage → system preference) before first paint. Must be a synchronous inline script.
const BOOTSTRAP_SCRIPT = `
(function () {
  try {
    var m = document.cookie.match(/(?:^|; )telepy\\.language=([^;]*)/);
    var pref = m ? m[1] : "auto";
    var lang = pref;
    if (pref === "auto" || ["en", "zh-TW", "ja"].indexOf(pref) < 0) {
      var nav = (navigator.languages && navigator.languages[0]) || navigator.language || "en";
      nav = nav.toLowerCase();
      lang = nav.indexOf("zh") === 0 ? "zh-TW" : nav.indexOf("ja") === 0 ? "ja" : "en";
    }
    document.documentElement.lang = lang;
    var theme = localStorage.getItem("telepy.theme") || "system";
    var dark = theme === "dark" || (theme !== "light" && window.matchMedia("(prefers-color-scheme: dark)").matches);
    document.documentElement.classList.toggle("dark", dark);
  } catch (e) { }
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: BOOTSTRAP_SCRIPT }} />
      </head>
      <body className={`${openHunInn.variable} ${protoNerd.variable} font-sans antialiased`}>
        <I18nProvider>
          <ToastProvider>
            <AuthProvider>
              <UserSettingsSync />
              {children}
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
