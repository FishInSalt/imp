// examples/extensions/task-timer.mjs — live per-run timer in the TUI footer.
//
// Install: copy into <project>/.imp/extensions/ (or ~/.imp/extensions/) and
// restart imp. While a run is in flight the footer shows "running M:SS",
// ticking once a second; when the run settles the line becomes "done in M:SS"
// and stays until the next run starts. Footer display only; nothing is
// written to session files, and print mode / the legacy shell are unaffected
// (setStatus is a safe no-op there).
//
// Timing model: run_start (a top-level run begins) to run_end (it settles).
// Steering and queued follow-up messages extend the SAME run — the timer
// keeps ticking across them, matching pi's "round" semantics.
//
// Known limitations (task-timer design §3.3/§4.5):
//   - A crashed run (provider throw) never emits run_end: the "running …"
//     line stays on screen until the next run starts and resets it.
//   - After /new, /resume, /tree, or /fork, a stale "done in …" persists
//     until the next run (imp has no session-lifecycle events yet).
//   - The tick interval is unref'd: on the crash path nothing clears it, and
//     a ref'd handle would block process exit. ANY timer an extension
//     creates should be unref'd for the same reason.

function formatDuration(ms) {
	const totalSeconds = Math.floor(ms / 1000);
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	const pad = (n) => String(n).padStart(2, "0");
	if (hours > 0) return `${hours}:${pad(minutes)}:${pad(seconds)}`;
	return `${minutes}:${pad(seconds)}`;
}

const STATUS_KEY = "task-timer";

/** @param {import("../../src/extensions/types.js").ExtensionApi} api */
export default function (api) {
	let roundStart = null; // Date.now() of the in-flight run's start
	let tick = null; // the 1 Hz painter (unref'd — see the header)

	const stopTick = () => {
		if (tick !== null) {
			clearInterval(tick);
			tick = null;
		}
	};

	api.on("run_start", () => {
		// An already-open round means the previous run crashed without a
		// run_end (provider throw, by design) — discard it and start fresh.
		stopTick();
		roundStart = Date.now();
		const paint = () => {
			if (roundStart === null) return;
			api.setStatus(STATUS_KEY, `running ${formatDuration(Date.now() - roundStart)}`);
		};
		paint();
		tick = setInterval(paint, 1000);
		tick.unref?.(); // never let a leaked tick hold the event loop open
	});

	api.on("run_end", () => {
		stopTick();
		if (roundStart === null) return;
		api.setStatus(STATUS_KEY, `done in ${formatDuration(Date.now() - roundStart)}`);
		roundStart = null;
	});
}
