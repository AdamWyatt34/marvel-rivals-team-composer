import type { NextConfig } from 'next';
const isDev = process.env.NODE_ENV !== 'production';

const base: NextConfig = {
    reactStrictMode: true,
    output: 'export',
    images: { unoptimized: true },
    trailingSlash: true
};

// Only add rewrites in dev; in prod SWA handles /api/* via staticwebapp.config.json
export default isDev
    ? {
        ...base,
        async rewrites() {
            return [
                { source: '/api/:path*', destination: 'http://127.0.0.1:7071/api/:path*' }
            ];
        }
    }
    : base;
