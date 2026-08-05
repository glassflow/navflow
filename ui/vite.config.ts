import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

// dev: `npm run dev` proxies to a running taresd; prod: `npm run build` emits ui/dist,
// which taresd serves directly at /.
const TARESD = "http://127.0.0.1:8787";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: Object.fromEntries(
      ["/api", "/query", "/read", "/catalog", "/health", "/ingest", "/subscribe", "/unsubscribe"].map(
        (p) => [p, { target: TARESD, changeOrigin: true }],
      ),
    ),
  },
});
