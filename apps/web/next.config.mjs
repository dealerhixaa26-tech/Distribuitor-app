/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  poweredByHeader: false,

  // The web container ships only what it needs; the full monorepo node_modules
  // would be an order of magnitude larger.
  output: 'standalone',

  // The shared contracts package is TypeScript source in the workspace.
  transpilePackages: ['@hixaa/contracts'],

  experimental: {
    optimizePackageImports: ['lucide-react', 'recharts'],
  },

  // Defence in depth: Nginx sets these too, but a misconfigured proxy must not
  // silently drop them. See docs/06-security.md §6.
  async headers() {
    return [
      {
        source: '/:path*',
        headers: [
          { key: 'X-Content-Type-Options', value: 'nosniff' },
          { key: 'X-Frame-Options', value: 'DENY' },
          { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
          {
            key: 'Permissions-Policy',
            value: 'geolocation=(), camera=(), microphone=(), payment=()',
          },
        ],
      },
    ];
  },
};

export default nextConfig;
