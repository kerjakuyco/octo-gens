import process from "node:process";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

// Set by `tauri dev` when the app is served to a device on the network.
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],

  // Keep Rust compiler errors visible in the same terminal.
  clearScreen: false,
  server: {
    // Tauri loads this exact URL in development.
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host ? { protocol: "ws", host, port: 1421 } : undefined,
    watch: {
      ignored: ["**/src-tauri/**", "**/crates/**", "**/target/**"],
    },
  },
  build: {
    outDir: "dist",
    target: "es2022",
  },
  test: {
    include: ["src/**/*.test.{ts,tsx}"],
    environment: "node",
  },
});
