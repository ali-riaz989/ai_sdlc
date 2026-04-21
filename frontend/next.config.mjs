import { dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
const nextConfig = {
  outputFileTracingRoot: __dirname,
  async rewrites() {
    // Note: /preview/* is served by app/preview/[[...slug]]/route.js
    //  which proxies + rewrites absolute URLs in the response body and injects a URL beacon.
    // Static asset paths below are passive rewrites (faster) and target the default dev port.
    return [
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
