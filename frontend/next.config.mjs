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
      // Proxy Laravel static assets (fonts, images, css, js) so they work same-origin
      { source: '/fonts/:path*', destination: 'http://localhost:8100/fonts/:path*' },
      { source: '/images/:path*', destination: 'http://localhost:8100/images/:path*' },
      { source: '/css/:path*', destination: 'http://localhost:8100/css/:path*' },
      { source: '/js/:path*', destination: 'http://localhost:8100/js/:path*' },
      { source: '/storage/:path*', destination: 'http://localhost:8100/storage/:path*' },
      { source: '/vendor/:path*', destination: 'http://localhost:8100/vendor/:path*' },
    ];
  },
};

export default nextConfig;
