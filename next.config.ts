import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Keep native/WASM database drivers out of the server bundle.
  serverExternalPackages: ["@electric-sql/pglite", "pg"],

  // Build output directory, switchable per worker.
  //
  // Next takes ONE lock per project directory for `next build` and one for
  // `next dev`, keyed off this path — so with a shared `.next` any two of us
  // building or running a dev server at the same time collide ("Another next
  // build process is already running"). Setting NEXT_DIST_DIR gives each
  // session its own output tree and its own lock:
  //
  //   NEXT_DIST_DIR=.next-w1 npm run dev -- --port 3111
  //
  // Unset, it stays `.next`, so CI and anyone who does not care are unaffected.
  distDir: process.env.NEXT_DIST_DIR || ".next",
};

export default nextConfig;
