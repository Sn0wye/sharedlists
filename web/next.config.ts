import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Fully static: `next build` emits plain HTML/JS/CSS into `out/`, servable from any CDN.
  output: "export",
  trailingSlash: true,
  images: { unoptimized: true },
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
