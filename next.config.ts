import type { NextConfig } from 'next';

const development = (process.env.CAIRN_ENV ?? 'development') === 'development';
const config: NextConfig = {
  // A build must never write into the dev server's `.next` (the app container runs `next dev` on it).
  // `npm run build:check` sets NEXT_DIST_DIR=.next-build; production images keep the default.
  distDir: process.env.NEXT_DIST_DIR || '.next',
  eslint: { ignoreDuringBuilds: true },
  output: 'standalone',
  outputFileTracingRoot: process.cwd(),
  allowedDevOrigins: development ? ['localhost', '127.0.0.1', '*.e2b.app'] : [],
  experimental: {
    cpus: 1,
    webpackMemoryOptimizations: true,
    serverActions: {
      // Extra origins are development-only; production accepts the configured host.
      allowedOrigins: development ? ['cairn.deepakpt.com', '*.e2b.app'] : ['cairn.deepakpt.com'],
    },
  },
};
export default config;
