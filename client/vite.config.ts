import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // Real PWA install + update behaviour (resolves part of Technical_Debt_Plan.md TD-04):
    // installable app-shell with icons, a service worker that precaches the built assets, and
    // registerType:'prompt' so updates surface as an explicit "Update available" banner
    // (src/pwa/UpdatePrompt.tsx) instead of silently swapping content under a user's feet.
    // API/socket traffic is untouched — no route in src/sw.ts targets /api or /socket.io, so it
    // always hits the network live; only the static app shell (JS/CSS/HTML/icons) is precached.
    //
    // strategies: 'injectManifest' (was the default 'generateSW') — a real push notification
    // handler needs a `push`/`notificationclick` listener, which generateSW's auto-generated
    // worker has no room for. src/sw.ts is a real, hand-written service worker source now;
    // everything generateSW used to do automatically (precaching, the SPA navigation fallback,
    // the SKIP_WAITING message registerType:'prompt' depends on) is rebuilt there explicitly —
    // see that file's own comments for the line-by-line mapping.
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src",
      filename: "sw.ts",
      registerType: "prompt",
      injectRegister: null, // we call registerSW ourselves in src/pwa/UpdatePrompt.tsx for a custom update UI
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
      injectManifest: {
        // The injectManifest equivalent of the old workbox.globPatterns — what gets precached.
        globPatterns: ["**/*.{js,css,html,png,svg,ico}"],
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
