import type { CoverLetterDraft } from "@jobber/shared";
import { asPdfFile, dropFileAt, findCoverLetterInput, setInputFile } from "./attach";
import { coverLetterFilename } from "./filename";
import {
	DRAFT_MESSAGE_TYPE,
	type DraftRequestMessage,
	type DraftResponseMessage,
} from "./messages";
import { letterPdf } from "./pdf";
import { type ScanResult, scanJobText } from "./scan";
import { getSettings, saveSettings } from "./settings";

// ---------------------------------------------------------------------------
// content.ts — the sidebar. Injected on toolbar click; lives inside a shadow
// root so the job site's CSS can't restyle it and ours can't leak out.
//
// Flow: Scan (or select text first) → Generate → edit the letter in place →
// Copy / Download PDF / Attach. All state is local to this closure; nothing
// about the page leaves the machine except the scanned text sent to YOUR api.
// ---------------------------------------------------------------------------

declare global {
	interface Window {
		/** Set on first injection; later injections just toggle the sidebar. */
		__jobberCoverLetterToggle?: () => void;
	}
}

if (window.__jobberCoverLetterToggle) {
	window.__jobberCoverLetterToggle();
} else {
	window.__jobberCoverLetterToggle = createSidebar();
}

function createSidebar(): () => void {
	// --- mutable state ------------------------------------------------------
	let scan: ScanResult | null = null;
	let draft: CoverLetterDraft | null = null;

	// --- shell: host element + shadow root ----------------------------------
	const host = document.createElement("div");
	host.id = "jobber-cover-letter-host";
	const shadow = host.attachShadow({ mode: "open" });
	document.documentElement.append(host);

	const style = document.createElement("style");
	style.textContent = CSS_TEXT;
	shadow.append(style);

	const root = document.createElement("div");
	root.className = "panel";
	shadow.append(root);

	root.innerHTML = `
		<header>
			<span class="title">Jobber — Cover letter</span>
			<button class="icon" data-el="close" title="Close">×</button>
		</header>

		<section class="settings">
			<label>API <input data-el="apiBase" type="text" spellcheck="false"></label>
			<label>Name <input data-el="name" type="text"></label>
		</section>

		<section class="actions">
			<button data-el="scan" class="secondary">1 · Scan page</button>
			<button data-el="generate" class="primary" disabled>2 · Generate</button>
		</section>
		<div class="hint" data-el="scanInfo">Tip: select the job description text first for the cleanest scan.</div>

		<textarea data-el="letter" placeholder="Your letter appears here — edit freely before using it." disabled></textarea>

		<section class="actions">
			<button data-el="copy" disabled>Copy</button>
			<button data-el="download" disabled>Download PDF</button>
			<button data-el="attach" disabled>Attach to page</button>
		</section>

		<div class="chip" data-el="chip" draggable="true" hidden>
			⠿ Drag me into the upload box
		</div>

		<div class="status" data-el="status"></div>
	`;

	const el = <T extends HTMLElement>(name: string): T => {
		const found = root.querySelector<T>(`[data-el="${name}"]`);
		if (!found) throw new Error(`sidebar element missing: ${name}`);
		return found;
	};

	const apiBaseInput = el<HTMLInputElement>("apiBase");
	const nameInput = el<HTMLInputElement>("name");
	const scanBtn = el<HTMLButtonElement>("scan");
	const generateBtn = el<HTMLButtonElement>("generate");
	const letterBox = el<HTMLTextAreaElement>("letter");
	const copyBtn = el<HTMLButtonElement>("copy");
	const downloadBtn = el<HTMLButtonElement>("download");
	const attachBtn = el<HTMLButtonElement>("attach");
	const chip = el<HTMLDivElement>("chip");
	const scanInfo = el<HTMLDivElement>("scanInfo");
	const statusBox = el<HTMLDivElement>("status");

	const setStatus = (text: string, kind: "info" | "ok" | "error" = "info") => {
		statusBox.textContent = text;
		statusBox.className = `status ${kind}`;
	};

	const letterReady = (ready: boolean) => {
		letterBox.disabled = !ready;
		copyBtn.disabled = !ready;
		downloadBtn.disabled = !ready;
		attachBtn.disabled = !ready;
		chip.hidden = !ready;
	};

	// --- settings (persisted to chrome.storage.sync) ------------------------
	void getSettings().then((s) => {
		apiBaseInput.value = s.apiBase;
		nameInput.value = s.candidateName;
	});
	const persistSettings = () => {
		void saveSettings({
			apiBase: apiBaseInput.value.trim(),
			candidateName: nameInput.value.trim(),
		});
	};
	apiBaseInput.addEventListener("change", persistSettings);
	nameInput.addEventListener("change", persistSettings);

	// --- scan ----------------------------------------------------------------
	scanBtn.addEventListener("click", () => {
		scan = scanJobText(document);
		if (scan.text.length < 80) {
			generateBtn.disabled = true;
			setStatus("Couldn't find enough text — select the description by hand and rescan.", "error");
			return;
		}
		const label = { selection: "your selection", container: "the description block", page: "the whole page" }[scan.source];
		scanInfo.textContent = `Scanned ${scan.text.length.toLocaleString()} characters from ${label}.`;
		generateBtn.disabled = false;
		setStatus("Ready to generate.");
	});

	// --- generate ------------------------------------------------------------
	generateBtn.addEventListener("click", () => {
		if (!scan) return;
		generateBtn.disabled = true;
		scanBtn.disabled = true;
		setStatus("Drafting… (the model call usually takes 5–20s)");

		const msg: DraftRequestMessage = {
			type: DRAFT_MESSAGE_TYPE,
			jobText: scan.text,
			pageUrl: location.href,
			pageTitle: document.title,
		};
		chrome.runtime.sendMessage(msg, (res: DraftResponseMessage | undefined) => {
			generateBtn.disabled = false;
			scanBtn.disabled = false;
			if (!res) {
				setStatus(chrome.runtime.lastError?.message ?? "No response from the extension worker.", "error");
				return;
			}
			if (!res.ok) {
				setStatus(res.message, "error");
				return;
			}
			draft = res.data.draft;
			letterBox.value = draft.letter;
			letterReady(true);
			const role = draft.roleTitle === "Unknown" ? "" : ` · ${draft.roleTitle}`;
			const co = draft.company === "Unknown" ? "" : ` @ ${draft.company}`;
			setStatus(`Draft ready${role}${co} (${res.data.model}). Edit it, then copy/download/attach.`, "ok");
		});
	});

	// --- use the letter ------------------------------------------------------
	const currentFilename = () =>
		coverLetterFilename(nameInput.value || "Candidate", draft?.company ?? "");
	const currentPdfFile = () =>
		asPdfFile(letterPdf(letterBox.value), currentFilename());

	copyBtn.addEventListener("click", () => {
		navigator.clipboard
			.writeText(letterBox.value)
			.then(() => setStatus("Copied to clipboard.", "ok"))
			.catch(() => {
				// Clipboard API can be blocked on some pages — fall back to the
				// ancient-but-universal path.
				letterBox.select();
				document.execCommand("copy");
				setStatus("Copied to clipboard (fallback).", "ok");
			});
	});

	downloadBtn.addEventListener("click", () => {
		const url = URL.createObjectURL(letterPdf(letterBox.value));
		const a = document.createElement("a");
		a.href = url;
		a.download = currentFilename();
		a.click();
		// Give the download a moment to start before revoking the blob URL.
		setTimeout(() => URL.revokeObjectURL(url), 10_000);
		setStatus(`Downloading ${currentFilename()}.`, "ok");
	});

	attachBtn.addEventListener("click", () => {
		const input = findCoverLetterInput(document);
		if (!input) {
			setStatus("No file input found on this page — try the drag chip on its upload box.", "error");
			return;
		}
		setInputFile(input, currentPdfFile());
		setStatus(`Attached ${currentFilename()} to the page's file input — verify it shows up before submitting.`, "ok");
	});

	// --- drag-to-dropzone ----------------------------------------------------
	// A JS-initiated drag can't carry a real File, so the trick is: track where
	// the user releases the chip, then synthesize a file-bearing drop there.
	let lastDrag = { x: 0, y: 0 };
	const trackDrag = (e: DragEvent) => {
		lastDrag = { x: e.clientX, y: e.clientY };
	};

	chip.addEventListener("dragstart", (e) => {
		e.dataTransfer?.setData("text/plain", currentFilename());
		document.addEventListener("dragover", trackDrag, true);
		setStatus("Drop the chip on the page's upload area…");
	});

	chip.addEventListener("dragend", () => {
		document.removeEventListener("dragover", trackDrag, true);
		const { x, y } = lastDrag;
		if (x === 0 && y === 0) {
			setStatus("Drag didn't land anywhere — try again.", "error");
			return;
		}
		// Ignore drops back onto the sidebar itself.
		if (shadow.elementFromPoint?.(x, y)) {
			setStatus("That landed on the sidebar — drop it on the page's upload box.", "error");
			return;
		}
		const target = dropFileAt(document, x, y, currentPdfFile());
		if (target) {
			setStatus(`Dropped ${currentFilename()} — check the page picked it up.`, "ok");
		} else {
			setStatus("Couldn't find a drop target there.", "error");
		}
	});

	// --- open/close ----------------------------------------------------------
	el<HTMLButtonElement>("close").addEventListener("click", () => {
		host.style.display = "none";
	});
	return () => {
		host.style.display = host.style.display === "none" ? "" : "none";
	};
}

// Kept as a constant string (not a .css file) so the whole sidebar ships as
// one self-contained content script — no web_accessible_resources needed.
const CSS_TEXT = `
	:host { all: initial; }
	.panel {
		position: fixed; top: 0; right: 0; height: 100vh; width: 380px;
		z-index: 2147483647; box-sizing: border-box;
		display: flex; flex-direction: column; gap: 10px; padding: 12px;
		background: #ffffff; color: #111827;
		border-left: 1px solid #e5e7eb; box-shadow: -8px 0 24px rgba(0,0,0,.12);
		font: 13px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif;
	}
	.panel *, .panel *::before, .panel *::after { box-sizing: border-box; }
	header { display: flex; align-items: center; justify-content: space-between; }
	.title { font-weight: 700; font-size: 14px; }
	button {
		font: inherit; padding: 7px 10px; border-radius: 8px; cursor: pointer;
		border: 1px solid #d1d5db; background: #f9fafb; color: #111827;
	}
	button:hover:not(:disabled) { background: #f3f4f6; }
	button:disabled { opacity: .45; cursor: not-allowed; }
	button.primary { background: #111827; border-color: #111827; color: #fff; }
	button.primary:hover:not(:disabled) { background: #1f2937; }
	button.icon { border: none; background: none; font-size: 18px; padding: 2px 6px; }
	.settings { display: flex; flex-direction: column; gap: 6px; }
	.settings label { display: flex; align-items: center; gap: 8px; color: #6b7280; }
	.settings input {
		flex: 1; font: inherit; padding: 5px 8px; border: 1px solid #d1d5db;
		border-radius: 6px; color: #111827; background: #fff;
	}
	.actions { display: flex; gap: 8px; }
	.actions button { flex: 1; }
	.hint { color: #6b7280; font-size: 12px; }
	textarea {
		flex: 1; min-height: 240px; resize: none; font: 13px/1.5 Georgia, serif;
		padding: 10px; border: 1px solid #d1d5db; border-radius: 8px;
		color: #111827; background: #fff;
	}
	.chip {
		align-self: center; padding: 8px 14px; border-radius: 999px;
		border: 1px dashed #6b7280; background: #f9fafb; cursor: grab;
		user-select: none; font-weight: 600;
	}
	.chip:active { cursor: grabbing; }
	.status { min-height: 18px; font-size: 12px; color: #6b7280; }
	.status.ok { color: #047857; }
	.status.error { color: #b91c1c; }
`;
