/**
 * Image conversion — M13 batch 2, ported from pi
 * `coding-agent/src/utils/image-convert.ts`. Photon re-encodes through its
 * decoded pixel buffer, which both normalizes unsupported-but-decodable
 * formats (BMP) into PNG and bakes the EXIF orientation in.
 */

import { applyExifOrientation } from "./exif-orientation.js";
import { photonLoader } from "./photon.js";

/** Decode and re-encode as PNG; null when photon is unavailable or decoding fails. */
export async function convertImageBytesToPng(bytes: Uint8Array): Promise<Uint8Array | null> {
	const photon = await photonLoader.load();
	if (!photon) {
		return null;
	}

	try {
		const rawImage = photon.PhotonImage.new_from_byteslice(bytes);
		const image = applyExifOrientation(photon, rawImage, bytes);
		if (image !== rawImage) rawImage.free();
		try {
			return new Uint8Array(image.get_bytes());
		} finally {
			image.free();
		}
	} catch {
		// Conversion failed
		return null;
	}
}

/**
 * Convert base64 image data to PNG for terminal display.
 * Kitty graphics protocol requires PNG format (f=100). (Kept for the
 * deferred inline-display batch — design §14.6.)
 */
export async function convertToPng(
	base64Data: string,
	mimeType: string,
): Promise<{ data: string; mimeType: string } | null> {
	// Already PNG, no conversion needed
	if (mimeType === "image/png") {
		return { data: base64Data, mimeType };
	}

	const bytes = new Uint8Array(Buffer.from(base64Data, "base64"));
	const pngBytes = await convertImageBytesToPng(bytes);
	if (!pngBytes) {
		return null;
	}

	return {
		data: Buffer.from(pngBytes).toString("base64"),
		mimeType: "image/png",
	};
}
