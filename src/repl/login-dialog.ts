/**
 * #login-dialog: the exclusive login dialog (pi's LoginDialogComponent,
 * scoped to imp's flows — see docs/login-dialog-design.md §2.1 and the
 * pi behavior parity table §2.1.1).
 *
 * A bordered dialog that owns focus and keys for a whole login flow
 * (api-key prompt / device-code + waiting). Esc or Ctrl+C cancels (the
 * dialog's own AbortController); Enter resolves the pending prompt.
 * State semantics follow pi exactly: ONLY deviceCode clears the content
 * area; waiting and prompt APPEND (the URL and user code stay visible
 * for the whole 15-minute poll — that is what the user is copying).
 */

import { dim } from "../format.js";
import { type Component, Container, type Focusable, Input, Spacer, Text, type TUI } from "../tui.js";

export interface DeviceCodeInfo {
	verificationUri: string;
	userCode: string;
}

/** The narrow view the command layer drives (design §2.3). */
export interface LoginDialogView {
	prompt(message: string, placeholder?: string): Promise<string>;
	deviceCode(info: DeviceCodeInfo): void;
	waiting(message: string): void;
	message(line: string): void;
	signal: AbortSignal;
}

export interface LoginDialogOptions {
	title: string;
	/** Drives the flow. Resolve = success; throw Error("Login cancelled")
	 *  = silent cancel; other throws surface via renderer.error. The
	 *  wrapper (TuiShell.openLoginDialog) owns teardown — run never does. */
	run: (dialog: LoginDialogView) => Promise<void>;
}

/** A full-width horizontal rule (pi's DynamicBorder, dim, no theme dep). */
class DialogBorder implements Component {
	invalidate(): void {}

	render(width: number): string[] {
		return [dim("─".repeat(Math.max(1, width)), true)];
	}
}

interface PendingPrompt {
	resolve: (value: string) => void;
	reject: (error: Error) => void;
}

export class LoginDialog extends Container implements Focusable, LoginDialogView {
	private readonly tui: TUI;
	private readonly input: Input;
	private readonly content: Container;
	private readonly abort = new AbortController();
	private pendingPrompt: PendingPrompt | null = null;
	// Focusable contract: TUI writes this; forwarding keeps IME cursor
	// positioning working (pi login-dialog.ts:20-27 does the same).
	private inputFocused = false;
	get focused(): boolean {
		return this.inputFocused;
	}
	set focused(value: boolean) {
		this.inputFocused = value;
		this.input.focused = value;
	}

	constructor(tui: TUI, title: string) {
		super();
		this.tui = tui;
		this.addChild(new DialogBorder());
		this.addChild(new Text(title, 1, 0));
		this.content = new Container();
		this.addChild(this.content);
		this.input = new Input();
		// Enter: resolve the pending prompt (pi null-checks inputResolver —
		// Enter with no pending prompt is a no-op, never a misfire).
		this.input.onSubmit = (value: string) => {
			const pending = this.pendingPrompt;
			if (pending === null) return;
			this.pendingPrompt = null;
			this.replaceInputWithSubmittedText(value);
			pending.resolve(value);
		};
		// Esc: reject the pending prompt AND cancel the whole flow (pi's
		// cancel() — abort + reject + onComplete(false)). The unified
		// channel: prompt() rejects with "Login cancelled" (design rev5 P3-D).
		this.input.onEscape = () => this.cancel("Login cancelled");
		this.input.focused = false;
		// pi parity (login-dialog.js:33-54): the input AND its cancel hint
		// are NOT added here — they join the tree only when a prompt opens
		// (inside content). Root-level copies rendered the input TWICE (the
		// "two > rows" dogfood report) and put the hint under states that have
		// nothing to submit (deviceCode/waiting).
		this.addChild(new DialogBorder());
	}

	get signal(): AbortSignal {
		return this.abort.signal;
	}

	/** pi cancel() (login-dialog.ts:81-90): one channel for Esc, the
	 *  dialog's Ctrl+C mapping, and selector teardown (SIGINT/stdin-end/
	 *  close — design §2.2 "finish-as-cancel"; review P0: without this,
	 *  teardown-first leaves run() pending and dialogOpen wedged). */
	cancel(reason: string): void {
		this.abort.abort();
		const pending = this.pendingPrompt;
		this.pendingPrompt = null;
		if (pending !== null) pending.reject(new Error(reason));
	}

	/** The selector-teardown channel: cancel the flow, then the UI. */
	teardownNow(): void {
		this.cancel("Login cancelled");
	}

	prompt(message: string, placeholder?: string): Promise<string> {
		this.input.setValue("");
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(message, 1, 0));
		if (placeholder !== undefined) this.content.addChild(new Text(dim(`e.g., ${placeholder}`, true), 1, 0));
		// The cancel hint travels WITH the input (pi showApiKeyPrompt :112 —
		// a root-level static hint would sit above every state, even
		// deviceCode/waiting where there is nothing to submit).
		this.content.addChild(this.input);
		this.content.addChild(new Text(dim("(esc to cancel, enter to submit)", true), 1, 0));
		this.tui.requestRender();
		return new Promise<string>((resolve, reject) => {
			this.pendingPrompt = { resolve, reject };
		});
	}

	deviceCode(info: DeviceCodeInfo): void {
		// The ONLY clearing state (parity table: login-dialog.ts:118-120).
		this.content.clear();
		this.content.addChild(new Spacer(1));
		const linked = `\x1b]8;;${info.verificationUri}\x07${info.verificationUri}\x1b]8;;\x07`;
		this.content.addChild(new Text(linked, 1, 0));
		// The click hint is itself an OSC-8 hyperlink — clickability needs
		// a sequence under the cursor, not URL text (pi login-dialog.ts:126-127).
		const platformHint = process.platform === "darwin" ? "Cmd+click to open" : "Ctrl+click to open";
		const hint = `\x1b]8;;${info.verificationUri}\x07${platformHint}\x1b]8;;\x07`;
		this.content.addChild(new Text(dim(hint, true), 1, 0));
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(`Enter code: ${info.userCode}`, 1, 0));
		this.tui.requestRender();
	}

	waiting(message: string): void {
		// APPENDS, never replaces (parity table: the URL + user code stay
		// visible for the whole poll — pi login-dialog.ts:206-211).
		this.content.addChild(new Spacer(1));
		this.content.addChild(new Text(dim(message, true), 1, 0));
		this.tui.requestRender();
	}

	message(line: string): void {
		this.content.addChild(new Text(dim(line, true), 1, 0));
		this.tui.requestRender();
	}

	/** pi replaceInputWithSubmittedText: the submitted value stays visible
	 *  (unmasked — pi parity; the auth file is 0600) with a "> " prefix. */
	private replaceInputWithSubmittedText(value: string): void {
		const index = this.content.children.indexOf(this.input);
		if (index === -1) return;
		this.content.children[index] = new Text(`> ${value}`, 1, 0);
		// The trailing cancel hint rode with the input (prompt appends both);
		// once submitted there is nothing to cancel — pi's submitted view is
		// just the echoed value.
		const next = this.content.children[index + 1];
		if (next instanceof Text) this.content.children.splice(index + 1, 1);
	}

	/** Focusable: the TUI routes key data here while the dialog is focused.
	 *  pi's handleInput shape — cancel binding, everything else to Input. */
	handleInput(data: string): void {
		if (data === "\x03") {
			// Raw-mode Ctrl+C is data, not SIGINT (design §2.2). Explicit
			// duplicate of the keybinding path, idempotent via the flow's
			// settled guard upstream.
			this.cancel("Login cancelled");
			return;
		}
		this.input.handleInput(data);
	}
}
