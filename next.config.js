/** @type {import('next').NextConfig} */
const nextConfig = {
  images: {
    domains: ['storage.googleapis.com'],
  },
  // Allow image uploads up to 10MB through the proxy API route
  experimental: {
    serverActions: {
      bodySizeLimit: '10mb',
    },
  },
};
module.exports = nextConfig;
