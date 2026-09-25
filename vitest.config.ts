import { defineConfig } from "vitest/config";

export default defineConfig({
	cacheDir: ".vitest-cache",
	test: {
		include: ["test/**/*.test.ts"],
		setupFiles: ["test/helpers/settings-setup.ts"],
		testTimeout: 15_000,
	},
});
