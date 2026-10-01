import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NEXT_PUBLIC_HOOSPEC_PAGES === 'true' ? 'export' : 'standalone',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  trailingSlash: process.env.NEXT_PUBLIC_HOOSPEC_PAGES === 'true',
  devIndicators: false,
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
