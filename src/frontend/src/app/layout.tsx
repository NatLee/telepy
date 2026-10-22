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
import "./huninn.css";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/Toast";
import { I18nProvider, UserSettingsSync } from "@/lib/i18n";

// 粉圓(jf-openhuninn)不走 next/font:整顆 2.2MB,會讓每頁都等它下載完才從系統字換過來。改由
// scripts/subset-huninn.py 切成 unicode-range 子集(huninn.css),瀏覽器只抓頁面上出現的字所在的區塊,
// 介面文字全在約 230KB 的 "ui" 區塊裡,所以第一次開站也幾乎立刻是粉圓。
// jf-openhuninn skips next/font: the whole 2.2MB file delayed the swap away from the system font on
// every first visit. scripts/subset-huninn.py splits it into unicode-range subsets (huninn.css); the
// browser fetches only the slices a page needs, and all UI text sits in the ~230KB "ui" slice.
//
// 等寬字型:WOFF2 + display:swap + preload:false。next/font 預設會在每個路由用高優先權 preload 字型,
// 跟決定可互動時間的 JS 搶頻寬;swap 已經先用系統字顯示文字,preload 對首屏毫無幫助。終端機在初始化前
// 會自行 await document.fonts.load(見 useTerminalPage)。
// Monospace font: WOFF2 + display:swap + preload:false — next/font would otherwise preload it at high
// priority on every route, competing with the JS that gates interactivity. xterm awaits
// document.fonts.load itself before initialising (see useTerminalPage).
const protoNerd = localFont({
  src: "../fonts/0xProtoNerdFont-Regular.woff2",
  variable: "--font-0xproto",
  display: "swap",
  preload: false,
});

export const metadata: Metadata = {
  title: "Telepy",
  description: "Telepy Reverse Proxy Dashboard",
};

// 繪製前先把 <html lang>、主題 class 與顯示大小設好(語言:cookie → 瀏覽器語言;主題:localStorage →
// 系統偏好;顯示大小:localStorage → <html> font-size)。避免 dark 模式白屏閃爍、錯誤的 lang 與版面跳動。
// 必須是同步 inline script。
// Pre-paint bootstrap: set <html lang> (cookie → browser language), the theme class (localStorage →
// system preference) and the display scale (localStorage → root font-size) before first paint, so
// there is no flash of the wrong theme, language or size. Must be a synchronous inline script.
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
    // 顯示大小(lib/userPrefs.ts 的 UI_SCALE_*):85–130%,100 = 預設不設。/ Display scale, 85–130%.
    var scale = parseInt(localStorage.getItem("telepy.uiScale") || "", 10);
    if (scale >= 85 && scale <= 130 && scale !== 100) document.documentElement.style.fontSize = scale + "%";
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
      <body className={`${protoNerd.variable} font-sans antialiased`}>
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
