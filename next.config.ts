import type { NextConfig } from "next";

const config: NextConfig = {
  // Pin the trace root: an unrelated lockfile higher up the home directory
  // otherwise wins root detection and drags in the wrong dependency graph.
  outputFileTracingRoot: __dirname,

  // The migration route reads the .sql files at runtime. Tracing only follows
  // imports, so non-code assets have to be declared or they are absent from the
  // serverless bundle and the route fails with ENOENT in production only.
  outputFileTracingIncludes: {
    "/api/admin/migrate": ["./firebase/schema/**/*.sql"],
  },
  images: {
    remotePatterns: [
      { protocol: "https", hostname: "places.googleapis.com" },
      // The photo proxy redirects here, and next/image resolves the redirect
      // target against this allowlist rather than the original URL.
      { protocol: "https", hostname: "lh3.googleusercontent.com" },
      { protocol: "https", hostname: "*.supabase.co" },
    ],
  },
};

export default config;
