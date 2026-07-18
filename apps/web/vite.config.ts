import { fileURLToPath, URL } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// https://vite.dev/config/
export default defineConfig({
	plugins: [react(), tailwindcss()],
	resolve: {
		// "@/..." => "src/..." — the alias shadcn and our own code use.
		alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
	},
	server: {
		// Any request to /api/* is forwarded to the Fastify server.
		// In the browser it looks same-origin, so CORS never enters the picture.
		proxy: { "/api": "http://localhost:3001" },
	},
});
