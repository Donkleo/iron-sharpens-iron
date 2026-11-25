import { defineConfig } from "vite";

// GitHub Pages serves the site at https://<owner>.github.io/iron-sharpens-iron/
export default defineConfig({
  base: process.env.BASE_PATH || "/iron-sharpens-iron/",
  test: {
    include: ["tests/**/*.test.js"],
  },
});
