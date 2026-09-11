import type { NextConfig } from 'next';

const config: NextConfig = {
  output: 'standalone',
  turbopack: { root: process.cwd() },
  outputFileTracingRoot: process.cwd(),
  poweredByHeader: false,
  async rewrites() {
    const express = (process.env.EXPRESS_URL || 'http://127.0.0.1:4372').replace(/\/$/, '');
    return [{ source: '/join/:path*', destination: `${express}/join/:path*` }, { source: '/protocol/:path*', destination: `${express}/protocol/:path*` }, { source: '/.well-known/:path*', destination: `${express}/.well-known/:path*` }, { source: '/health', destination: `${express}/health` }, { source: '/style.css', destination: `${express}/style.css` }];
  },
  async headers() {
    return [{ source: '/:path*', headers: [
      { key: 'Referrer-Policy', value: 'no-referrer' },
      { key: 'X-Content-Type-Options', value: 'nosniff' },
      { key: 'X-Frame-Options', value: 'DENY' },
      { key: 'Content-Security-Policy', value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'; object-src 'none'; connect-src 'self'" },
      { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
    ] }];
  },
};
export default config;
