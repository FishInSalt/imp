import { spawn } from "node:child_process";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const vitestEntry = path.join(repoRoot, "node_modules/vitest/vitest.mjs");

/** Run the installed Vitest directly: no npm/npx registry checks or installs. */
export function runLeaseProcess(testFile: string, marker: NodeJS.ProcessEnv): Promise<number> {
	return new Promise((resolve, reject) => {
		const child = spawn(process.execPath, [vitestEntry, "run", testFile, "--reporter=dot"], {
			cwd: repoRoot,
			env: { ...process.env, ...marker, NO_COLOR: "1" },
			stdio: ["ignore", "ignore", "pipe"],
		});
		let stderr = "";
		child.stderr.on("data", (chunk: Buffer) => {
			stderr += chunk.toString("utf8");
		});
		child.on("error", reject);
		child.on("close", (code, signal) => {
			if (code !== 0) {
				process.stderr.write(`Lease worker ${JSON.stringify(marker)} exited ${code ?? signal}:\n${stderr}`);
			}
			resolve(code ?? -1);
		});
	});
}
