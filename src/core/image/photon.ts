/**
 * Photon (Rust/WASM) loader — M13 batch 2.
 *
 * pi's `utils/photon.ts` carries an fs-patch fallback ladder for Bun-compiled
 * binaries (the CJS entry does `fs.readFileSync(__dirname + "/photon_rs_bg.wasm")`
 * which bakes a build-machine path into the binary). imp ships as plain npm
 * ESM: the wasm sits in node_modules next to the module and loads cleanly, so
 * all that survives is the lazy load + null-on-failure contract that the
 * resize/convert layers already handle.
 */

type PhotonModule = typeof import("@silvia-odwyer/photon-node");
export type Photon = PhotonModule;
export type PhotonImageType = import("@silvia-odwyer/photon-node").PhotonImage;

let photonModule: Photon | null = null;
let loadFailed = false;
let loadPromise: Promise<Photon | null> | null = null;

/** Test seam (design §14.7): force the "photon unavailable" path. */
export const photonLoader: { load: () => Promise<Photon | null> } = {
	async load(): Promise<Photon | null> {
		if (photonModule !== null) return photonModule;
		if (loadFailed) return null;
		if (loadPromise === null) {
			loadPromise = (async () => {
				try {
					const mod = (await import("@silvia-odwyer/photon-node")) as unknown as {
						default?: Photon;
					} & Photon;
					// CJS interop: the api lives on `default` under plain Node ESM
					// and on the namespace under bundlers — accept either.
					const resolved = (mod.default ?? mod) as Photon;
					if (typeof resolved.PhotonImage?.new_from_byteslice !== "function") {
						throw new Error("photon-node has no PhotonImage");
					}
					photonModule = resolved;
					return resolved;
				} catch {
					loadFailed = true;
					return null;
				}
			})();
		}
		return loadPromise;
	},
};
