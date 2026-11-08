import type { NextConfig } from 'next';

const noFraming = [
  { key: 'Content-Security-Policy', value: "frame-ancestors 'none'" },
  { key: 'X-Frame-Options', value: 'DENY' },
];

const config: NextConfig = {
  // agentRules: off, so `next dev` does not write an AGENTS.md into the example.
  agentRules: false,
  async headers() {
    return [
      // No page of this site may be framed. Above all /device: approving there grants a computer
      // access to the account (clickjacking target); its decision is a Server Action (POST +
      // Origin check). Published pages under /asset-files set their own sandbox CSP instead
      // (frameable by this site only). One rule, so no header is sent twice.
      { source: '/((?!asset-files/).*)', headers: noFraming },
    ];
  },
};

export default config;
