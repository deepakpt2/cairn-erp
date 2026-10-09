import type { NextConfig } from 'next';

const development = (process.env.CAIRN_ENV ?? 'development') === 'development';
const config: NextConfig = {
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
