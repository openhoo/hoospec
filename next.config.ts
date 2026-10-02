import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: process.env.NEXT_PUBLIC_HOOSPEC_PAGES === 'true' ? 'export' : 'standalone',
  basePath: process.env.NEXT_PUBLIC_BASE_PATH || '',
  trailingSlash: process.env.NEXT_PUBLIC_HOOSPEC_PAGES === 'true',
  devIndicators: false,
  serverExternalPackages: ['@github/copilot-sdk'],
  outputFileTracingIncludes: { '/api/copilot': ['./node_modules/@github/copilot-sdk*/**/*', './node_modules/koffi/**/*'] },
  outputFileTracingRoot: process.cwd(),
};

export default nextConfig;
