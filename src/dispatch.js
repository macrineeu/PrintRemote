/**
 * Decide como um job vira impressão, a partir do perfil da impressora.
 *
 * cfg.printers = {
 *   "MTI-773": { "type": "escpos", "bluetooth": "AA:BB:CC:DD:EE:FF", "channel": 1, "columns": 32 },
 *   "Zebra":   { "type": "raw",    "host": "192.168.0.50", "port": 9100 },
 *   "HP":      { "type": "system", "queue": "HP_LaserJet" }
 * }
 *
 * type:
 *   escpos → job.text vira ESC/POS e sai cru (device | host | queue)
 *   raw    → job.data sai cru (device | host | queue); job.text também vira ESC/POS
 *   system → passa pelo driver gráfico do SO (html/text renderizados) — impressoras comuns
 */
const printer = require('./printer');
const raw = require('./raw');
const escpos = require('./escpos');
const raster = require('./raster');
const pdf = require('./pdf');
const fs = require('fs');

function resolveProfile(job, cfg) {
  const name = job.printer || cfg.defaultPrinter || '';
  const profile = (cfg.printers && cfg.printers[name]) || null;
  return { name, profile };
}

/** Destino cru a partir do job + perfil (job tem prioridade). */
function rawTarget(job, name, profile) {
  const t = {};
  if (job.host) (t.host = job.host), (t.port = job.port || 9100);
  else if (job.bluetooth) (t.bluetooth = job.bluetooth), (t.channel = job.channel || (profile && profile.channel) || 1);
  else if (job.device) t.device = job.device;
  else if (profile && profile.host) (t.host = profile.host), (t.port = profile.port || 9100);
  else if (profile && profile.bluetooth) (t.bluetooth = profile.bluetooth), (t.channel = profile.channel || 1);
  else if (profile && profile.device) t.device = profile.device;
  else t.printer = (profile && profile.queue) || name;
  return t;
}

async function print(job, cfg) {
  const { name, profile } = resolveProfile(job, cfg);
  const type = job.type || (profile && profile.type) || (job.data ? 'raw' : job.host || job.device ? 'escpos' : 'system');

  if (type === 'system') {
    if (!job.html && !job.text) throw new Error('Informe "html" ou "text"');
    const r = await printer.print({ ...job, printer: (profile && profile.queue) || name }, '');
    return { ...r, type, profile: profile ? name : undefined };
  }

  const target = rawTarget(job, name, profile);

  if (job.data) {
    const r = await raw.print({ ...job, ...target }, '');
    return { ...r, type: 'raw', profile: profile ? name : undefined };
  }

  if (job.text === undefined || job.text === null) {
    throw new Error(`Impressora "${name}" é ${type}: envie "text" (vira ESC/POS) ou "data" (comandos crus)`);
  }
  const opts = { ...(profile || {}), ...(job.escpos || {}) };
  const data = escpos.encode(job.text, opts);
  const r = await raw.print({ ...target, data, format: 'escpos', copies: job.copies }, '');
  return { ...r, type: 'escpos', profile: profile ? name : undefined, columns: opts.columns || escpos.DEFAULTS.columns };
}

/**
 * Etiquetas com layout (HTML em mm vindo da aplicação) em impressora ESC/POS: rasteriza e envia.
 * job: { printer?, largura_mm, altura_mm, dpi?, gap_mm?, etiquetas: [{ html, quantidade }], dryRun?, preview? }
 */
async function printLabels(job, cfg) {
  const { name, profile } = resolveProfile(job, cfg);
  const type = (profile && profile.type) || 'escpos';
  if (type === 'system') throw new Error(`"${name}" é impressora comum: use a impressão em folha (A4/PDF), POST /print`);
  if (type === 'raw' && !(profile && profile.rasterOk)) {
    throw new Error(`"${name}" é etiquetadora (ZPL/PPLA): envie comandos ZPL/PPLA em POST /print/raw em vez de HTML`);
  }
  const widthDots = escposWidthDots(profile);
  const built = await raster.build(job, { widthDots, feed: profile && profile.feed !== undefined ? profile.feed : 3, preview: !!(job.preview || job.dryRun) });
  const info = { type: 'escpos-raster', profile: profile ? name : undefined, labels: built.total, widthDots: built.widthDots, heightDots: built.heightDots, dpi: built.dpi, scaled: built.scaled, bytes: built.data.length, previewPng: built.previewPng };
  if (job.dryRun) return { success: true, dryRun: true, printer: name, ...info };
  const target = rawTarget(job, name, profile);
  const r = await raw.print({ ...target, data: built.data, format: 'escpos' }, '');
  return { ...r, ...info };
}

/** Largura imprimível em dots de um perfil ESC/POS (58 mm = 384, 80 mm = 576). */
function escposWidthDots(profile) {
  return (profile && profile.widthDots) || (profile && profile.columns === 48 ? 576 : 384);
}

/**
 * PDF pronto (ex.: DANFE NFC-e/NF-e) na impressora escolhida.
 * job: { pdf (base64), printer?, copies?, dpi?, threshold?, gap_mm?, dryRun?, preview? }
 *
 *   escpos → cada página vira bitmap na largura da bobina e sai em GS v 0
 *   system → macOS/Linux: o arquivo vai para a fila do CUPS, que converte o PDF;
 *            Windows: as páginas viram imagens e saem pelo driver no tamanho da página
 *   raw    → etiquetadora não imprime PDF
 */
async function printPdf(job, cfg) {
  const { name, profile } = resolveProfile(job, cfg);
  const type = (profile && profile.type) || 'system';
  if (type === 'raw' && !(profile && profile.rasterOk)) {
    throw new Error(`"${name}" é etiquetadora (ZPL/PPLA): não imprime PDF. Escolha a impressora de cupom ou uma impressora comum`);
  }
  const buf = Buffer.isBuffer(job.pdf) ? job.pdf : Buffer.from(String(job.pdf || ''), 'base64');
  if (buf.length < 5 || buf.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error('"pdf" não é um PDF válido (envie o arquivo em base64)');
  const copies = Math.max(1, Number(job.copies) || 1);

  if (type === 'system') {
    const queue = (profile && profile.queue) || name;
    if (process.platform !== 'win32') {
      if (job.dryRun) return { success: true, dryRun: true, printer: queue, type: 'pdf-cups', bytes: buf.length };
      const file = raw.tmpFile('pdf');
      fs.writeFileSync(file, buf);
      try {
        const r = await raw.sendFileToQueueUnix(queue, file, { copies });
        return { success: true, printer: queue, type: 'pdf-cups', bytes: buf.length, ...r };
      } finally {
        fs.unlink(file, () => {});
      }
    }
    // Windows: sem CUPS. Página → imagem em ~300 dpi → HTML → driver, no tamanho exato da página.
    const rendered = await pdf.renderPages(buf, { widthPx: 1200 });
    const first = rendered.pages[0];
    const html = `<!doctype html><html><head><meta charset="utf-8"><style>
      @page { margin: 0; } html, body { margin: 0; padding: 0; background: #fff; }
      img { display: block; width: 100%; height: auto; page-break-after: always; break-after: page; }
      img:last-child { page-break-after: auto; break-after: auto; }
    </style></head><body>${rendered.pages.map((p) => `<img src="${p.image.toDataURL()}">`).join('')}</body></html>`;
    if (job.dryRun) return { success: true, dryRun: true, printer: queue, type: 'pdf-image', pages: rendered.numPages, pageUm: { width: first.widthUm, height: first.heightUm } };
    const r = await printer.print({ html, printer: queue, copies, silent: true, margins: { marginType: 'none' }, pageSize: { width: first.widthUm, height: first.heightUm } }, '');
    return { ...r, type: 'pdf-image', pages: rendered.numPages };
  }

  // ESC/POS: bitmap por página na largura da bobina
  const widthDots = escposWidthDots(profile);
  const dpi = Number(job.dpi) || 203;
  const rendered = await pdf.renderPages(buf, { widthPx: widthDots });
  const parts = [Buffer.from([0x1b, 0x40]), Buffer.from([0x1b, 0x61, 0x01])]; // init + centralizado
  let previewPng;
  let rows = 0;
  const gap = raster.mmToDots(job.gap_mm ?? 4, dpi);
  for (let c = 0; c < copies; c++) {
    rendered.pages.forEach((p, i) => {
      const mono = raster.toMonochrome(p.image, job.threshold);
      if (c === 0 && i === 0 && (job.preview || job.dryRun)) previewPng = p.image.toPNG().toString('base64');
      parts.push(raster.rasterCommands(mono));
      rows += mono.height;
      if (i < rendered.pages.length - 1 || c < copies - 1) parts.push(Buffer.from([0x1b, 0x4a, Math.min(255, gap)]));
    });
  }
  parts.push(Buffer.from([0x1b, 0x61, 0x00]));
  const feed = profile && profile.feed !== undefined ? Number(profile.feed) : 4;
  if (feed > 0) parts.push(Buffer.from([0x1b, 0x64, Math.min(feed, 255)]));
  if (profile && profile.cut) parts.push(Buffer.from([0x1d, 0x56, 0x42, 0x00]));
  const data = Buffer.concat(parts);
  const info = { type: 'escpos-pdf', profile: profile ? name : undefined, pages: rendered.numPages, copies, widthDots, heightDots: rows, dpi, bytes: data.length, previewPng };
  if (job.dryRun) return { success: true, dryRun: true, printer: name, ...info };
  const target = rawTarget(job, name, profile);
  const r = await raw.print({ ...target, data, format: 'escpos' }, '');
  return { ...r, ...info };
}

/** Lista impressoras: perfis configurados + filas do SO. */
async function listPrinters(cfg) {
  const system = await printer.listPrinters().catch(() => []);
  const profiles = Object.entries(cfg.printers || {}).map(([name, p]) => ({
    name,
    displayName: p.displayName || name,
    description: p.bluetooth ? `BT ${p.bluetooth}` : p.device || (p.host ? `${p.host}:${p.port || 9100}` : p.queue) || '',
    type: p.type || 'raw',
    isDefault: cfg.defaultPrinter === name,
    source: 'profile',
    ...p,
  }));
  const seen = new Set(profiles.map((p) => p.name));
  return [...profiles, ...system.filter((p) => !seen.has(p.name)).map((p) => ({ ...p, type: 'system', source: 'system' }))];
}

module.exports = { print, printLabels, printPdf, listPrinters, resolveProfile };
