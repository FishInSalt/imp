import { defineConfig } from "vitest/config";

export default defineConfig({
	cacheDir: ".vitest-cache",
	test: {
		include: ["test/**/*.test.ts"],
		// Installs the same offline guard used by the fixture CLI's Node preload.
		setupFiles: ["test/helpers/settings-setup.ts"],
		testTimeout: 15_000,
	},
});
