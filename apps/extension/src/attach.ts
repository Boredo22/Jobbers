// ---------------------------------------------------------------------------
// attach.ts — get the generated PDF into the page's own upload widget.
//
// Two mechanisms, because ATSes come in two shapes:
//
//   • A real <input type="file"> (often visually hidden behind a styled
//     button). JS may not open the OS file picker, but it MAY construct a
//     File and assign it to input.files via DataTransfer — the same object a
//     real drag produces. Dispatching input+change afterwards makes React/
//     Vue-style forms notice the "upload".
//
//   • A custom drag-and-drop zone (a div with a drop listener). For that, the
//     sidebar renders a draggable chip: the user drags it over the dropzone,
//     and on dragend we synthesize dragenter/dragover/drop events carrying
//     the File at the release point. The page's own handler takes it from
//     there, exactly as if the file came from the desktop.
// ---------------------------------------------------------------------------

/** Wrap the PDF blob as a named File, ready for either mechanism. */
export function asPdfFile(blob: Blob, filename: string): File {
	return new File([blob], filename, { type: "application/pdf" });
}

/**
 * Find the file input most likely to be the cover-letter one: prefer an input
 * whose label / surrounding text mentions "cover", otherwise the first file
 * input that accepts PDFs. Null when the page has no file inputs at all.
 */
export function findCoverLetterInput(doc: Document): HTMLInputElement | null {
	const inputs = Array.from(
		doc.querySelectorAll<HTMLInputElement>('input[type="file"]'),
	).filter((input) => {
		const accept = input.accept.toLowerCase();
		return accept === "" || accept.includes("pdf") || accept.includes("*");
	});

	let best: { input: HTMLInputElement; score: number } | null = null;
	for (const input of inputs) {
		let score = 0;
		// An explicit <label for=…> naming "cover" is the strongest signal.
		if (input.id) {
			const label = doc.querySelector(`label[for="${CSS.escape(input.id)}"]`);
			if (label?.textContent?.toLowerCase().includes("cover")) score = 10;
		}
		// Otherwise walk up a few ancestors looking for "cover" in nearby text
		// (closer = stronger).
		if (score === 0) {
			let el: HTMLElement | null = input.parentElement;
			for (let depth = 1; el && depth <= 4; depth++) {
				if (el.textContent?.toLowerCase().includes("cover")) {
					score = 8 - depth;
					break;
				}
				el = el.parentElement;
			}
		}
		if (!best || score > best.score) best = { input, score };
	}
	return best?.input ?? null;
}

/** Programmatically "upload" the file into a file input. */
export function setInputFile(input: HTMLInputElement, file: File): void {
	const dt = new DataTransfer();
	dt.items.add(file);
	input.files = dt.files;
	// Frameworks listen for these rather than polling .files.
	input.dispatchEvent(new Event("input", { bubbles: true }));
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

/**
 * Synthesize a file drop on whatever element sits at (x, y). Returns the
 * element it targeted, or null if the point hits nothing (e.g. off-page).
 */
export function dropFileAt(
	doc: Document,
	x: number,
	y: number,
	file: File,
): Element | null {
	const target = doc.elementFromPoint(x, y);
	if (!target) return null;

	const dt = new DataTransfer();
	dt.items.add(file);
	// The sequence a real OS drag produces; dropzone libraries typically hook
	// dragover (to show the highlight) and drop (to read .files).
	for (const type of ["dragenter", "dragover", "drop"] as const) {
		target.dispatchEvent(
			new DragEvent(type, {
				bubbles: true,
				cancelable: true,
				composed: true,
				clientX: x,
				clientY: y,
				dataTransfer: dt,
			}),
		);
	}
	return target;
}
