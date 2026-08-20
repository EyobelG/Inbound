import type { NextConfig } from "next";

const config: NextConfig = {
  // Pin the trace root: an unrelated lockfile higher up the home directory
  // otherwise wins root detection and drags in the wrong dependency graph.
  outputFileTracingRoot: __dirname,

  images: {
    remotePatterns: [
      { protocol: "https", hostname: "places.googleapis.com" },
      // The photo proxy redirects here, and next/image resolves the redirect
      // target against this allowlist rather than the original URL.
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "*.supabase.co" },
      // Wikimedia Commons serves every file and thumbnail from this one host.
      // Without it next/image refuses seeded Commons photos in production,
      // which is exactly where the cold-start imagery has to work.
      { protocol: "https", hostname: "upload.wikimedia.org" },
    ],
  },
};

export default config;
