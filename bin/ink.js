#!/usr/bin/env node
import("../dist/cli.js").catch((err) => {
	console.error("Ink failed to start:", err);
	process.exit(1);
});
