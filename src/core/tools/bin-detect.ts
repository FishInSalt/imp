import { spawn } from "node:child_process";

const cache = new Map<string, Promise<boolean>>();

/**
 * Detect whether an external binary (rg, fd, ...) is on PATH by trying to
 * run `<name> --version`. Cached per process.
 */
export function detectBinary(name: string): Promise<boolean> {
	if (!cache.has(name)) {
		cache.set(
			name,
			new Promise((resolve) => {
				const child = spawn(name, ["--version"], { stdio: "ignore" });
				child.on("error", () => resolve(false)); // ENOENT
				child.on("close", (code) => resolve(code === 0));
			}),
		);
	}
	return cache.get(name)!;
}
