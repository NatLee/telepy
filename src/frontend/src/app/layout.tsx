/**
 * 根版面：字型、i18n / Auth / Toast Provider、全域 metadata。
 * Root layout: fonts, i18n / Auth / Toast providers, global metadata.
 *
 * i18n 初始語言在這裡(server)決定:cookie 的偏好優先,偏好是 auto 時看 Accept-Language。
 * 這讓 SSR 輸出與 client 首次 render 一致,切換頁面或重新整理都不會閃英文。
 * The initial locale is resolved server-side here (cookie preference first, Accept-Language
 * when the preference is "auto") so SSR matches hydration with no language flash.
 */
import type { Metadata } from "next";
import localFont from "next/font/local";
import { cookies, headers } from "next/headers";
import "./globals.css";
import { AuthProvider } from "@/lib/auth";
import { ToastProvider } from "@/components/ui/Toast";
import { I18nProvider, UserLanguageSync } from "@/lib/i18n";
import {
  LANGUAGE_COOKIE,
  isLanguagePreference,
  parseAcceptLanguage,
  type LanguagePreference,
  type Locale,
} from "@/lib/locale";

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

// metadata 維持英文:generateMetadata 若依 cookie 變動會讓每頁都變 dynamic,SEO 效益又低。
// Metadata stays English: localizing it would force dynamic rendering for little SEO gain.
export const metadata: Metadata = {
  title: "Telepy",
  description: "Telepy Reverse Proxy Dashboard",
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  const cookieStore = await cookies();
  const headerStore = await headers();
  const rawPreference = cookieStore.get(LANGUAGE_COOKIE)?.value;
  const preference: LanguagePreference = isLanguagePreference(rawPreference) ? rawPreference : "auto";
  const locale: Locale = preference === "auto"
    ? parseAcceptLanguage(headerStore.get("accept-language"))
    : preference;

  return (
    <html lang={locale}>
      <body className={`${openHunInn.variable} ${protoNerd.variable} font-sans antialiased`}>
        <I18nProvider initialPreference={preference} initialLocale={locale}>
          <ToastProvider>
            <AuthProvider>
              <UserLanguageSync />
              {children}
            </AuthProvider>
          </ToastProvider>
        </I18nProvider>
      </body>
    </html>
  );
}
