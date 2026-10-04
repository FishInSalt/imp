// Loaded both by Vitest setup and by Node's --require in CLI subprocesses.
// Never contact a nonlocal endpoint, even if application code catches errors.
const { syncBuiltinESMExports } = require("node:module");
const net = require("node:net");
const http = require("node:http");
const https = require("node:https");
const tls = require("node:tls");
const dgram = require("node:dgram");
const dns = require("node:dns");
const dnsPromises = require("node:dns/promises");
const { appendFileSync } = require("node:fs");

const key = Symbol.for("ink.test.network-blocker");
if (!globalThis[key]) {
	const attempts = [];
	globalThis[key] = { attempts };

	const local = (host) => {
		const name = String(host)
			.toLowerCase()
			.replace(/^\[|\]$/g, "");
		// Literal-only loopback policy: never invoke OS or caller-supplied
		// lookup for "localhost" (it can resolve to a nonlocal address).
		return (
			name === "::1" ||
			(net.isIP(name) === 4 && name.startsWith("127.")) ||
			(net.isIP(name) === 6 && /^::ffff:127\.\d+\.\d+\.\d+$/.test(name))
		);
	};

	const check = (host, transport) => {
		if (local(host)) return;
		const message = `Blocked nonlocal test network request (${transport}): ${String(host)}`;
		attempts.push(message);
		if (process.env.INK_TEST_NETWORK_LOG) {
			appendFileSync(process.env.INK_TEST_NETWORK_LOG, `${message}\n`);
		}
		throw new Error(message);
	};

	const checkUrl = (input, transport) => {
		const url = new URL(typeof input === "string" || input instanceof URL ? input : input.url);
		check(url.hostname, transport);
	};

	const originalFetch = globalThis.fetch;
	if (originalFetch) {
		globalThis.fetch = function (input, init) {
			checkUrl(input, "fetch");
			return originalFetch.call(this, input, init);
		};
	}

	const transports = /** @type {[typeof http | typeof https, string][]} */ ([
		[http, "http"],
		[https, "https"],
	]);
	for (const [module, transport] of transports) {
		const original = module.request;
		module.request = function (...args) {
			const first = args[0];
			const options = typeof first === "string" || first instanceof URL ? args[1] : first;
			if (typeof first === "string" || first instanceof URL) checkUrl(first, transport);
			if (options && typeof options === "object" && !options.socketPath) {
				check(options.hostname ?? options.host ?? "localhost", transport);
			}
			return original.apply(this, args);
		};
		module.get = (...args) => {
			const request = module.request.apply(module, args);
			request.end();
			return request;
		};
	}

	const checkConnect = (args, transport) => {
		// Socket.connect also accepts Node's internally normalized [options, callback].
		if (Array.isArray(args[0])) return checkConnect(args[0], transport);
		const first = args[0];
		if (first && typeof first === "object") {
			// Node selects a pipe only for a truthy path. null, "", false and
			// zero still reach the TCP branch and must pass the host check.
			if (first.path) return; // Unix-domain sockets / named pipes
			check(first.host ?? first.hostname ?? "localhost", transport);
		} else if (typeof first !== "string" || Number(first) >= 0) {
			check(typeof args[1] === "string" ? args[1] : "localhost", transport);
		}
	};

	const socketConnect = net.Socket.prototype.connect;
	net.Socket.prototype.connect = function (...args) {
		checkConnect(args, "tcp");
		return socketConnect.apply(this, args);
	};
	const tlsConnect = tls.connect;
	tls.connect = function (...args) {
		checkConnect(args, "tls");
		// TLS positional overloads can carry a host in a later options object.
		for (const arg of args) {
			if (arg && typeof arg === "object" && !Array.isArray(arg)) checkConnect([arg], "tls");
		}
		return tlsConnect.apply(this, args);
	};
	// UDP invokes a socket's custom lookup even for literal destinations.
	// Guard the callback before Node can pass its result to the native handle.
	// Bind wildcards are safe only when lookup leaves that exact literal alone;
	// send/connect already reject wildcard destinations above the lookup layer.
	const udpOptions = (options) => {
		if (typeof options === "string") options = { type: options };
		if (!options || typeof options !== "object") return options;
		const lookup = options.lookup;
		if (lookup !== undefined && typeof lookup !== "function") return options;
		return {
			...options,
			lookup(host, lookupOptions, callback) {
				const checked = (error, address, family) => {
					if (!error && !((host === "0.0.0.0" || host === "::") && address === host)) {
						try {
							check(address, "udp lookup");
						} catch (blocked) {
							return callback(blocked);
						}
					}
					return callback(error, address, family);
				};
				if (lookup) return lookup(host, lookupOptions, checked);
				// No DNS/OS lookup needed for the literal-only policy. Node supplies
				// numeric family options here for both udp4 and udp6.
				process.nextTick(checked, null, host, net.isIP(host));
			},
		};
	};
	// Node exports the constructor although @types/node exposes only the
	// factory signatures. Preserve its options/listener overloads and statics.
	const UdpSocket =
		/** @type {typeof dgram.Socket & (new (options: any, listener?: any) => import("node:dgram").Socket)} */ (
			dgram.Socket
		);
	const GuardedUdpSocket = class extends UdpSocket {
		constructor(options, listener) {
			super(udpOptions(options), listener);
		}
	};
	dgram.Socket = GuardedUdpSocket;
	dgram.createSocket = (options, listener) => new GuardedUdpSocket(options, listener);

	const udpConnect = UdpSocket.prototype.connect;
	UdpSocket.prototype.connect = function (port, address, ...rest) {
		check(typeof address === "string" ? address : "localhost", "udp");
		return udpConnect.call(this, port, address, ...rest);
	};
	const udpSend = UdpSocket.prototype.send;
	UdpSocket.prototype.send = function (...args) {
		// Both UDP send overloads put the destination immediately after the port.
		const portIndex =
			typeof args[1] === "number" && typeof args[2] === "number" && typeof args[3] === "number" ? 3 : 1;
		if (typeof args[portIndex] === "number") {
			check(typeof args[portIndex + 1] === "string" ? args[portIndex + 1] : "localhost", "udp");
		}
		return udpSend.apply(this, args);
	};

	for (const module of [dns, dnsPromises]) {
		const lookup = module.lookup;
		module.lookup = function (hostname, ...args) {
			check(hostname, "dns lookup");
			return lookup.call(this, hostname, ...args);
		};
		for (const name of Object.keys(module)) {
			if (!name.startsWith("resolve") && name !== "reverse" && name !== "lookupService") continue;
			if (typeof module[name] !== "function") continue;
			module[name] = () => {
				check("DNS queries are not allowed", "dns");
			};
		}
	}
	for (const Resolver of [dns.Resolver, dnsPromises.Resolver]) {
		for (const name of Object.getOwnPropertyNames(Resolver.prototype)) {
			if (!name.startsWith("resolve") && name !== "reverse") continue;
			Resolver.prototype[name] = () => {
				check("DNS queries are not allowed", "dns");
			};
		}
	}

	syncBuiltinESMExports();
	process.on("exit", () => {
		if (attempts.length === 0) return;
		process.stderr.write(`${attempts.join("\n")}\n`);
		process.exitCode = 1;
	});
	// Finalize AFTER all exit listeners, including ones registered later that
	// try to reset exitCode to zero. Keep the parent log as an additional check.
	const processEmit = process.emit;
	process.emit = function (event, ...args) {
		try {
			return processEmit.call(this, event, ...args);
		} finally {
			if (event === "exit" && attempts.length > 0) process.exitCode = 1;
		}
	};
	const processExit = process.exit;
	process.exit = (code) => processExit(attempts.length > 0 ? 1 : code);
}

exports.takeBlockedAttempts = () => globalThis[key].attempts.splice(0);
