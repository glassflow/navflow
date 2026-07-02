import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// dev: `npm run dev` proxies to a running navflowd; prod: `npm run build` emits ui/dist,
// which navflowd serves directly at /.
const NAVFLOWD = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: Object.fromEntries(
      ["/api", "/query", "/read", "/catalog", "/health", "/ingest", "/subscribe", "/unsubscribe"].map(
        (p) => [p, { target: NAVFLOWD, changeOrigin: true }],
      ),
    ),
  },
});
