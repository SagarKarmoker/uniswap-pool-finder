import { defineConfig } from "vite";

export default defineConfig({
  server: {
    host: "0.0.0.0",
    port: Number(process.env.PORT) || 5173,
    strictPort: true,
    allowedHosts: [process.env.RAILWAY_PUBLIC_DOMAIN].filter(Boolean),
    hmr: process.env.RAILWAY_PUBLIC_DOMAIN
      ? { protocol: "wss", host: process.env.RAILWAY_PUBLIC_DOMAIN, clientPort: 443 }
      : undefined,
    proxy: process.env.RAILWAY_PUBLIC_DOMAIN
      ? undefined
      : {
          "/api": {
            target: `http://127.0.0.1:${process.env.API_PORT || 3000}`,
            changeOrigin: true,
          },
        },
  },
});