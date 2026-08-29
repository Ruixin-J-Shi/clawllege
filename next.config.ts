import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/WASM database drivers out of the server bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],
};

export default nextConfig;
