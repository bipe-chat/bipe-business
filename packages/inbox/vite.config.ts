import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// The bridge serves the built app from the same origin as its API (INBOX_DIR). In dev, Vite proxies the API.
const bridge = process.env.BRIDGE_URL ?? "http://localhost:8080";

export default defineConfig({
  plugins: [react()],
  // The Matrix SDK chunk is large but loads only after sign-in.
  build: { target: "es2022", sourcemap: false, chunkSizeWarningLimit: 1000 },
  server: {
    proxy: {
      "/inbox": bridge,
      "/health": bridge,
    },
  },
});
