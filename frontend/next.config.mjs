import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  async rewrites() {
    return [
      {
        source: '/preview/:path*',
        destination: 'http://localhost:8100/:path*',
      },
    ];
  },
};

export default nextConfig;
