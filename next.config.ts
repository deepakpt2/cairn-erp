import type { NextConfig } from 'next';

const development = (process.env.CAIRN_ENV ?? 'development') === 'development';
const config: NextConfig = {
  // The box is 2 GB and the build's own type check OOMs it. Types are still gated:
  // `tsc --noEmit` runs as its own step in every stage, so nothing goes unchecked —
  // this only stops the webpack run spawning a second full check beside itself.
  typescript: { ignoreBuildErrors: true },
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
