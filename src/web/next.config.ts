/** @type {import('next').NextConfig} */
const nextConfig = {
    reactStrictMode: true,
    async rewrites() {
        return [
            {
                source: "/api/:path*",
                destination: "http://127.0.0.1:7071/api/:path*", // use IPv4 to avoid ::1
            },
        ];
    },
};
module.exports = nextConfig;
