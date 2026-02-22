import type { NextConfig } from "next";

const isDev = process.env.NODE_ENV !== 'production';
const BACKEND_URL = process.env.NEXT_DEV_BACKEND_URL || 'http://localhost:8787';

const nextConfig: NextConfig = {
  output: 'standalone',

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

