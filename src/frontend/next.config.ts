import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== 'production';
const BACKEND_URL = process.env.NEXT_DEV_BACKEND_URL || 'http://localhost:8787';

const nextConfig: NextConfig = {
  output: 'standalone',

  // radix-ui 以「傘狀」barrel（`import { Dialog } from "radix-ui"`）被多個 UI primitive 匯入，
  // 但它不在 Next 內建的 optimizePackageImports 清單（lucide-react 已內建、無需再加）。加進來可確保
  // 每個 primitive 各自 code-split、縮短編譯時間。react-syntax-highlighter 不吃這個選項，已於
  // components/ui/CodeBlock.tsx 改用 PrismAsyncLight 處理。
  // radix-ui is imported as an umbrella barrel and isn't in Next's built-in list; add it so each
  // primitive is split individually.
  experimental: {
    optimizePackageImports: ['radix-ui'],
  },

  // Only proxy to backend in dev mode.
  // In production, Traefik handles routing of /api and /ws to the backend.
  ...(isDev && {
    async rewrites() {
      return [
        {
          source: '/api/:path*',
          destination: `${BACKEND_URL}/api/:path*`,
        },
        {
          source: '/ws/:path*',
          destination: `${BACKEND_URL}/ws/:path*`,
        },
        {
          source: '/tunnels/share/:path*',
          destination: `${BACKEND_URL}/tunnels/share/:path*`,
        },
        {
          source: '/tunnels/unshare/:path*',
          destination: `${BACKEND_URL}/tunnels/unshare/:path*`,
        },
        {
          source: '/tunnels/shared-users/:path*',
          destination: `${BACKEND_URL}/tunnels/shared-users/:path*`,
        },
        {
          source: '/tunnels/available-users/:path*',
          destination: `${BACKEND_URL}/tunnels/available-users/:path*`,
        },
        {
          source: '/tunnels/update-permission/:path*',
          destination: `${BACKEND_URL}/tunnels/update-permission/:path*`,
        },
        {
          source: '/tunnels/server/:path*',
          destination: `${BACKEND_URL}/tunnels/server/:path*`,
        },
      ];
    },
  }),
};

export default nextConfig;

