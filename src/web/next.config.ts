import type { NextConfig } from "next";

// basePath is empty for local dev; the Pages workflow sets it to
// "/marvel-rivals-team-composer" so exported assets and the snapshot fetch
// resolve under the project path on github.io.
const config: NextConfig = {
  reactStrictMode: true,
  output: "export",
  images: { unoptimized: true },
  trailingSlash: true,
  basePath: process.env.NEXT_PUBLIC_BASE_PATH ?? "",
};

export default config;
