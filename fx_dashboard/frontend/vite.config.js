import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: {
    // Two apps: the pricer (index.html) and the NEER deep-dive (neer.html).
    // Without both listed, `vite build` silently drops the deep-dive from dist.
    rollupOptions: { input: { main: "index.html", neer: "neer.html" } },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": "http://127.0.0.1:8000",
      "/ws": { target: "ws://127.0.0.1:8000", ws: true },
    },
  },
});
