import type { NextConfig } from 'next';

const isDev = process.env.NODE_ENV !== 'production';

const config: NextConfig = {
  reactStrictMode: true,
  output: 'export',            // tells Next to export to /out
  images: { unoptimized: true },
  trailingSlash: true,
  async rewrites() {
    if (!isDev) return [];
    return [
      {
        source: '/api/:path*',
        destination: 'http://127.0.0.1:7071/api/:path*'
      }
    ];
  }
};

export default config;