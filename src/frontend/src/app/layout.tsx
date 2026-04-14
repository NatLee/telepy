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

const openHunInn = localFont({
  src: "../fonts/jf-openhuninn-2.1.ttf",
  variable: "--font-openhuninn",
  display: "block",
});

const protoNerd = localFont({
  src: "../fonts/0xProtoNerdFont-Regular.ttf",
  variable: "--font-0xproto",
  display: "block",
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
