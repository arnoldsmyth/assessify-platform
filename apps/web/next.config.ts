import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: [
    '@assessify/adapters',
    '@assessify/db',
    '@assessify/domain',
    '@assessify/questionnaire-schema',
    '@assessify/repositories',
    '@assessify/services',
    '@assessify/ui',
  ],
  // pg is CJS with optional native bindings — keep it external to the bundle.
  serverExternalPackages: ['pg'],
};

export default nextConfig;
