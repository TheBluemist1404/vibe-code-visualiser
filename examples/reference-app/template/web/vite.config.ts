import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    // The Nest API (npm start in the repository root) listens on port 3000.
    proxy: { "/api": "http://localhost:3000" },
  },
  test: {
    environment: "jsdom",
  },
});
