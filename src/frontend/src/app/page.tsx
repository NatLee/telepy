"use client";

/**
 * 根頁面：依認證狀態導向 tunnels 或 login。
 * Root page: redirect to tunnels or login based on auth state.
 */
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth";

export default function RootPage() {
  const router = useRouter();
  const { isAuthenticated, isLoading } = useAuth();

  useEffect(() => {
    if (!isLoading) {
      if (isAuthenticated) {
        router.replace("/tunnels");
      } else {
        router.replace("/login");
      }
    }
  }, [isAuthenticated, isLoading, router]);

  return (
    <div className="min-h-screen flex items-center justify-center bg-slate-900">
      <div className="w-10 h-10 border-4 border-slate-700 border-t-green-500 rounded-full animate-spin"></div>
    </div>
  );
}
