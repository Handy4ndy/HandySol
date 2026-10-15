import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Relative base so the build works on GitHub Pages project sites (/<repo>/) or any static host.
// Override with VITE_BASE=/splitpay/ if an absolute base is preferred.
export default defineConfig({
  base: process.env.VITE_BASE ?? "./",
  plugins: [react()],
  define: { "process.env": {} },
});
