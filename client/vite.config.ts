import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Real PWA install + update behaviour (resolves part of Technical_Debt_Plan.md TD-04):
    // installable app-shell with icons, a service worker that precaches the built assets, and
    // registerType:'prompt' so updates surface as an explicit "Update available" banner
    // (src/pwa.ts) instead of silently swapping content under a user's feet. API/socket traffic
    // is untouched — no runtimeCaching rule targets /api or /socket.io, so it always hits the
    // network live; only the static app shell (JS/CSS/HTML/icons) is precached for offline use.
    VitePWA({
      registerType: "prompt",
      injectRegister: null, // we call registerSW ourselves in src/pwa.ts for a custom update UI
      includeAssets: ["favicon.svg"],
      manifest: {
        name: "Borla",
        short_name: "Borla",
        description: "Waste pickup, matched nearby — a real-time matchmaker connecting households with nearby roaming waste collectors.",
        theme_color: "#0E6E4E",
        background_color: "#ECEBE3",
        display: "standalone",
        orientation: "portrait",
        start_url: "/",
        scope: "/",
        icons: [
          { src: "/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
          { src: "/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
          { src: "/icon-512-maskable.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
        ],
      },
      workbox: {
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
        navigateFallbackDenylist: [/^\/api\//, /^\/socket\.io\//],
      },
      devOptions: {
        enabled: false, // keep local `npm run dev` free of service-worker caching quirks
      },
    }),
  ],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:4000",
      "/socket.io": { target: "http://localhost:4000", ws: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
  },
  build: {
    outDir: "dist",
  },
});
