import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  reactStrictMode: true,

  // 👇 This makes `next build` produce a static site (no SSR)
  // In production, there must be NO getServerSideProps / API routes.
  output: 'export',

  // If you use next/image
  images: { unoptimized: true },

  // Optional, keeps URLs consistent when exporting
  trailingSlash: true,

  // Keep the local proxy ONLY for dev; SWA will handle /api/* in prod
  async rewrites() {
    if (!isDev) return [];
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:7071/api/:path*', // local Functions
      },
    ];
  },
};

export default config;
