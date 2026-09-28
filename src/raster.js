/**
 * Rasteriza etiquetas HTML e gera bitmap ESC/POS (GS v 0).
 *
 * POR QUE EXISTE: impressora de cupom (MTI-773 etc.) não entende ZPL nem posicionamento
 * em mm. A aplicação já renderiza o layout do modelo em HTML com medidas em mm — o mesmo HTML
 * do "Preview exato" e da folha A4. Aqui esse HTML é desenhado pelo Chromium do Electron
 * no tamanho exato da etiqueta, na resolução da impressora, e vira imagem 1-bit.
 * O que o operador desenhou no editor é o que sai no papel.
 */
const { BrowserWindow } = require('electron');

const ESC = 0x1b;
const GS = 0x1d;
const MAX_ROWS_PER_CMD = 128; // bandas menores evitam estourar o buffer de impressoras baratas

function mmToDots(mm, dpi) {
  return Math.max(1, Math.round((Number(mm) / 25.4) * dpi));
}

/**
 * Renderiza um documento HTML numa janela oculta e devolve NativeImage com
 * exatamente widthDots × heightDots pixels.
 *
 * @param {number} dpi     resolução da impressora
 * @param {number} [escala] 1 = tamanho real; < 1 quando a etiqueta é mais larga que a
 *                          bobina e precisa encolher inteira (o zoom acompanha a janela,
 *                          senão só a janela encolhe e o layout sai cortado com barra de rolagem)
 */
async function renderHtml(html, widthDots, heightDots, dpi, escala = 1) {
  const zoom = (dpi / 96) * (Number(escala) > 0 ? Number(escala) : 1); // CSS "mm" é baseado em 96 dpi → 1mm vira dpi/25.4 pontos
  const win = new BrowserWindow({
    show: false,
    width: widthDots,
    height: heightDots,
    useContentSize: true,
    frame: false,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, zoomFactor: zoom, backgroundThrottling: false },
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout ao renderizar etiqueta')), 20000);
      win.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(t); reject(new Error(`Falha ao carregar HTML (${code}): ${desc}`)); });
      win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
      win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
    });
    win.webContents.setZoomFactor(zoom);
    // Nunca barra de rolagem na imagem: um arredondamento de 1 px já a faria aparecer.
    await win.webContents.insertCSS('html, body { overflow: hidden !important; } ::-webkit-scrollbar { display: none !important; }').catch(() => {});
    // fontes e SVGs prontos antes de capturar
    await win.webContents.executeJavaScript('document.fonts ? document.fonts.ready.then(() => true) : true').catch(() => {});
    await new Promise((r) => setTimeout(r, 120));
    let img = await win.webContents.capturePage({ x: 0, y: 0, width: widthDots, height: heightDots });
    const size = img.getSize();
    if (size.width !== widthDots || size.height !== heightDots) {
      img = img.resize({ width: widthDots, height: heightDots, quality: 'best' });
    }
    return img;
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

/**
 * NativeImage → bitmap 1-bit empacotado (1 = preto), linhas de ceil(w/8) bytes.
 * @param {number} threshold  0-255; abaixo disso o pixel é preto (padrão 160 favorece texto fino)
 */
function toMonochrome(img, threshold = 160) {
  const { width, height } = img.getSize();
  const bgra = img.toBitmap();
  const rowBytes = Math.ceil(width / 8);
  const out = Buffer.alloc(rowBytes * height, 0);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      const a = bgra[i + 3];
      // fundo transparente conta como branco
      const lum = a === 0 ? 255 : (bgra[i + 2] * 299 + bgra[i + 1] * 587 + bgra[i] * 114) / 1000;
      if (lum < threshold) out[y * rowBytes + (x >> 3)] |= 0x80 >> (x & 7);
    }
  }
  return { width, height, rowBytes, bits: out };
}

/** Bitmap 1-bit → comandos GS v 0 em bandas. */
function rasterCommands(mono) {
  const parts = [];
  const xL = mono.rowBytes & 0xff;
  const xH = (mono.rowBytes >> 8) & 0xff;
  for (let y = 0; y < mono.height; y += MAX_ROWS_PER_CMD) {
    const rows = Math.min(MAX_ROWS_PER_CMD, mono.height - y);
    parts.push(Buffer.from([GS, 0x76, 0x30, 0x00, xL, xH, rows & 0xff, (rows >> 8) & 0xff]));
    parts.push(mono.bits.subarray(y * mono.rowBytes, (y + rows) * mono.rowBytes));
  }
  return Buffer.concat(parts);
}

/** Avanço de papel em pontos (ESC J n, n ≤ 255, repetido se preciso). */
function feedDots(dots) {
  const parts = [];
  let rest = Math.max(0, Math.round(dots));
  while (rest > 0) { const n = Math.min(255, rest); parts.push(Buffer.from([ESC, 0x4a, n])); rest -= n; }
  return Buffer.concat(parts);
}

/**
 * Monta o job completo.
 * @param {object} job
 * @param {Array<{html:string, quantidade?:number}>} job.etiquetas
 * @param {number} job.largura_mm   largura do modelo
 * @param {number} job.altura_mm    altura do modelo
 * @param {number} [job.dpi]        203 (padrão) | 300
 * @param {number} [job.gap_mm]     espaço entre etiquetas no papel contínuo (padrão 3)
 * @param {number} [job.threshold]  limiar de preto
 * @param {object} opts
 * @param {number} opts.widthDots   largura máxima imprimível da impressora (MTI-773 = 384)
 * @param {number} [opts.feed]      linhas em branco no fim
 * @param {boolean} [opts.preview]  também devolve PNG da primeira etiqueta
 */
async function build(job, opts = {}) {
  const dpi = Number(job.dpi) || 203;
  const maxW = Number(opts.widthDots) || 384;
  let wDots = mmToDots(job.largura_mm, dpi);
  let hDots = mmToDots(job.altura_mm, dpi);
  let scaled = false;
  let escala = 1;
  if (wDots > maxW) { escala = maxW / wDots; hDots = Math.round(hDots * escala); wDots = maxW; scaled = true; }

  const etiquetas = Array.isArray(job.etiquetas) ? job.etiquetas : [];
  if (!etiquetas.length) throw new Error('Informe "etiquetas" com pelo menos um item { html, quantidade }');

  const parts = [Buffer.from([ESC, 0x40]), Buffer.from([ESC, 0x61, 0x01])]; // init + centralizado
  const gap = feedDots(mmToDots(job.gap_mm ?? 3, dpi));
  let total = 0;
  let previewPng;

  for (let i = 0; i < etiquetas.length; i++) {
    const et = etiquetas[i];
    if (!et || !et.html) continue;
    const img = await renderHtml(et.html, wDots, hDots, dpi, escala);
    if (i === 0 && opts.preview) previewPng = img.toPNG().toString('base64');
    const raster = rasterCommands(toMonochrome(img, job.threshold));
    const qtd = Math.max(1, Number(et.quantidade) || 1);
    for (let q = 0; q < qtd; q++) { parts.push(raster, gap); total++; }
  }
  parts.push(Buffer.from([ESC, 0x61, 0x00]));
  const feed = opts.feed === undefined ? 3 : Number(opts.feed);
  if (feed > 0) parts.push(Buffer.from([ESC, 0x64, Math.min(feed, 255)]));

  return { data: Buffer.concat(parts), total, widthDots: wDots, heightDots: hDots, dpi, scaled, previewPng };
}

module.exports = { build, renderHtml, toMonochrome, rasterCommands, mmToDots };
