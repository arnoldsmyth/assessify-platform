import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@assessify/adapters',
    '@assessify/domain',
    '@assessify/services',
    '@assessify/ui',
  ],
};

export default nextConfig;
