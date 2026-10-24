import { PDFDocument } from 'pdf-lib';

// pdf.js (for previews) is loaded only when a PDF is chosen, to keep the first load small.
type PdfJs = typeof import('pdfjs-dist');
let pdfjsPromise: Promise<PdfJs> | null = null;
function loadPdfJs(): Promise<PdfJs> {
  if (!pdfjsPromise) {
    pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, worker]) => {
      lib.GlobalWorkerOptions.workerSrc = worker.default;
      return lib;
    });
  }
  return pdfjsPromise;
}

type Mode = 'cuts' | 'every' | 'range';

const MAX_PAGES = 500;
const THUMB_WIDTH = 160;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const els = {
  input: $<HTMLInputElement>('file-input'),
  dropzone: $<HTMLLabelElement>('dropzone'),
  info: $<HTMLParagraphElement>('file-info'),
  error: $<HTMLParagraphElement>('error'),
  workspace: $<HTMLDivElement>('workspace'),
  everyN: $<HTMLInputElement>('every-n'),
  range: $<HTMLInputElement>('range'),
  modeEvery: $<HTMLDivElement>('mode-every'),
  modeRange: $<HTMLDivElement>('mode-range'),
  preview: $<HTMLParagraphElement>('preview'),
  thumbs: $<HTMLDivElement>('thumbs'),
  splitBtn: $<HTMLButtonElement>('split-btn'),
  resetBtn: $<HTMLButtonElement>('reset-btn'),
  result: $<HTMLDivElement>('result'),
  resultText: $<HTMLParagraphElement>('result-text'),
  downloadAgain: $<HTMLButtonElement>('download-again'),
};

let file: File | null = null;
let bytes: Uint8Array | null = null;
let pageCount = 0;
let lastBlob: Blob | null = null;
let lastName = '';
const cuts = new Set<number>(); // a cut AFTER page n (1-based)

function showError(message: string) {
  els.error.textContent = message;
  els.error.classList.remove('hidden');
}

function clearError() {
  els.error.textContent = '';
  els.error.classList.add('hidden');
}

function currentMode(): Mode {
  const checked = document.querySelector<HTMLInputElement>('input[name="mode"]:checked');
  return (checked?.value as Mode) ?? 'cuts';
}

function isEncryptedError(err: unknown) {
  return /encrypt/i.test(String(err));
}

/** Parses "1-3, 4-7, 9" into groups of page numbers. Returns an error string when invalid. */
function parseRanges(text: string, n: number): number[][] | string {
  const parts = text.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return 'Enter at least one page range, for example 1-3, 4-7.';

  const groups: number[][] = [];
  for (const part of parts) {
    const m = part.match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!m) return `"${part}" is not valid. Use formats like 3 or 2-5.`;
    const start = Number(m[1]);
    const end = m[2] ? Number(m[2]) : start;
    if (start < 1 || end > n || start > end) {
      return `"${part}" is outside pages 1-${n}, or the numbers are reversed.`;
    }
    const group: number[] = [];
    for (let p = start; p <= end; p++) group.push(p);
    groups.push(group);
  }
  return groups;
}

/** Turns the chosen mode into groups of page numbers, one group per output file. */
function buildGroups(): number[][] | string {
  const n = pageCount;
  const mode = currentMode();

  if (mode === 'cuts') {
    const groups: number[][] = [];
    let current: number[] = [];
    for (let p = 1; p <= n; p++) {
      current.push(p);
      if (cuts.has(p) && p < n) {
        groups.push(current);
        current = [];
      }
    }
    if (current.length) groups.push(current);
    return groups;
  }

  if (mode === 'every') {
    const k = Math.floor(Number(els.everyN.value));
    if (!k || k < 1) return 'Pages per file must be a whole number, 1 or more.';
    const groups: number[][] = [];
    for (let s = 1; s <= n; s += k) {
      const group: number[] = [];
      for (let p = s; p < Math.min(s + k, n + 1); p++) group.push(p);
      groups.push(group);
    }
    return groups;
  }

  return parseRanges(els.range.value, n);
}

function updatePreview() {
  const groups = buildGroups();
  if (typeof groups === 'string') {
    els.preview.textContent = groups;
    els.preview.className = 'mt-4 text-sm text-red-600';
    els.splitBtn.disabled = true;
    return;
  }
  els.preview.className = 'mt-4 text-sm text-[#171717]';
  els.preview.textContent =
    groups.length === 1
      ? 'This will create 1 PDF with all pages.'
      : `This will create ${groups.length} files.`;
  els.splitBtn.disabled = false;
}

function syncModeUI() {
  const mode = currentMode();
  els.modeEvery.classList.toggle('hidden', mode !== 'every');
  els.modeRange.classList.toggle('hidden', mode !== 'range');
  els.thumbs.querySelectorAll<HTMLButtonElement>('.cut-btn').forEach((btn) => {
    btn.classList.toggle('hidden', mode !== 'cuts');
  });
  clearError();
  updatePreview();
}

function refreshCutButton(btn: HTMLButtonElement, page: number) {
  const active = cuts.has(page);
  btn.classList.toggle('active', active);
  btn.textContent = active ? 'Cut here ✓' : 'Cut after';
  btn.setAttribute('aria-pressed', String(active));
}

async function renderThumbs(data: Uint8Array) {
  els.thumbs.innerHTML = '';
  const pdfjsLib = await loadPdfJs();
  const pdf = await pdfjsLib.getDocument({ data: data.slice() }).promise;

  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: THUMB_WIDTH / base.width });

    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    canvas.className = 'w-full rounded border border-[#eaeaea] bg-white';
    canvas.setAttribute('aria-label', `Preview of page ${i}`);
    await page.render({
      canvas,
      canvasContext: canvas.getContext('2d')!,
      viewport,
    }).promise;

    const card = document.createElement('div');
    card.className = 'flex flex-col';

    const label = document.createElement('span');
    label.className = 'mt-2 text-xs text-[#666]';
    label.textContent = `Page ${i}`;

    card.append(canvas, label);

    if (i < pdf.numPages) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'cut-btn';
      btn.dataset.page = String(i);
      refreshCutButton(btn, i);
      btn.addEventListener('click', () => {
        if (cuts.has(i)) cuts.delete(i);
        else cuts.add(i);
        refreshCutButton(btn, i);
        updatePreview();
      });
      card.append(btn);
    }

    els.thumbs.append(card);
  }
  syncModeUI();
}

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10000);
}

async function loadFile(f: File) {
  clearError();
  els.result.classList.add('hidden');

  if (!(f.type === 'application/pdf' || /\.pdf$/i.test(f.name))) {
    showError('Please choose a PDF file.');
    return;
  }

  try {
    const buf = new Uint8Array(await f.arrayBuffer());
    const doc = await PDFDocument.load(buf);
    const count = doc.getPageCount();

    if (count > MAX_PAGES) {
      showError(`This PDF has ${count} pages. The limit is ${MAX_PAGES} pages.`);
      return;
    }

    file = f;
    bytes = buf;
    pageCount = count;
    cuts.clear();

    els.info.textContent = `${f.name} · ${count} page${count === 1 ? '' : 's'} · ${(f.size / 1048576).toFixed(2)} MB`;
    els.range.placeholder = `1-${Math.min(3, count)}, ${Math.min(4, count)}-${count}`;
    els.workspace.classList.remove('hidden');

    await renderThumbs(buf);
    updatePreview();
  } catch (err) {
    showError(
      isEncryptedError(err)
        ? 'This PDF is password-protected. Unlock it first, then try again.'
        : 'This file could not be read as a PDF.',
    );
  }
}

async function splitNow() {
  if (!bytes || !file) return;
  const groups = buildGroups();
  if (typeof groups === 'string') {
    showError(groups);
    return;
  }

  const originalLabel = els.splitBtn.textContent;
  els.splitBtn.disabled = true;
  els.splitBtn.textContent = 'Splitting…';
  clearError();

  try {
    const src = await PDFDocument.load(bytes);
    const base = file.name.replace(/\.pdf$/i, '');
    const outputs: { name: string; data: Uint8Array }[] = [];

    for (let i = 0; i < groups.length; i++) {
      const group = groups[i];
      const out = await PDFDocument.create();
      const copied = await out.copyPages(src, group.map((p) => p - 1));
      copied.forEach((page) => out.addPage(page));

      const first = group[0];
      const last = group[group.length - 1];
      const range = first === last ? `p${first}` : `p${first}-${last}`;
      outputs.push({
        name: `${base}-${String(i + 1).padStart(2, '0')}-${range}.pdf`,
        data: await out.save(),
      });
    }

    if (outputs.length === 1) {
      lastBlob = new Blob([outputs[0].data as BlobPart], { type: 'application/pdf' });
      lastName = outputs[0].name;
    } else {
      const { default: JSZip } = await import('jszip');
      const zip = new JSZip();
      outputs.forEach((o) => zip.file(o.name, o.data));
      lastBlob = await zip.generateAsync({ type: 'blob' });
      lastName = `${base}-split.zip`;
    }

    download(lastBlob, lastName);
    els.resultText.textContent =
      outputs.length === 1
        ? 'Done. Your PDF is downloading.'
        : `Done. ${outputs.length} files were packed into a ZIP and downloaded.`;
    els.result.classList.remove('hidden');
  } catch (err) {
    showError(
      isEncryptedError(err)
        ? 'This PDF is password-protected. Unlock it first, then try again.'
        : 'Could not split this file. Try another PDF.',
    );
  } finally {
    els.splitBtn.textContent = originalLabel;
    els.splitBtn.disabled = false;
  }
}

function startOver() {
  file = null;
  bytes = null;
  pageCount = 0;
  lastBlob = null;
  cuts.clear();
  els.thumbs.innerHTML = '';
  els.workspace.classList.add('hidden');
  els.result.classList.add('hidden');
  els.info.textContent = '';
  els.range.value = '';
  els.everyN.value = '2';
  els.input.value = '';
  clearError();
}

// ---- wiring ----

els.input.addEventListener('change', () => {
  const f = els.input.files?.[0];
  if (f) loadFile(f);
  els.input.value = '';
});

['dragenter', 'dragover'].forEach((type) =>
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.add('border-[#171717]');
  }),
);

['dragleave', 'drop'].forEach((type) =>
  els.dropzone.addEventListener(type, (e) => {
    e.preventDefault();
    els.dropzone.classList.remove('border-[#171717]');
  }),
);

els.dropzone.addEventListener('drop', (e) => {
  const f = e.dataTransfer?.files?.[0];
  if (f) loadFile(f);
});

document.querySelectorAll<HTMLInputElement>('input[name="mode"]').forEach((radio) =>
  radio.addEventListener('change', syncModeUI),
);

els.everyN.addEventListener('input', updatePreview);
els.range.addEventListener('input', updatePreview);
els.splitBtn.addEventListener('click', splitNow);
els.resetBtn.addEventListener('click', startOver);
els.downloadAgain.addEventListener('click', () => {
  if (lastBlob) download(lastBlob, lastName);
});
