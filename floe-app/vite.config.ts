import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [
    react(),
    {
      name: "floe-health",
      configureServer(server) {
        server.middlewares.use("/health", (_req, res) => {
          res.setHeader("content-type", "application/json");
          res.end(JSON.stringify({
            ok: true,
            service: "floe-app",
            time: new Date().toISOString()
          }));
        });
      }
    }
  ],
  server: {
    host: "127.0.0.1",
    port: 5379,
    strictPort: true
  }
});
