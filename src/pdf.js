/**
 * PDF → imagens das páginas, com pdf.js dentro de uma janela oculta do Electron.
 *
 * POR QUE EXISTE: a aplicação costuma gerar o documento (ex.: DANFE da NFC-e) como PDF pronto.
 * Não há HTML para o caminho normal do `/print`, e impressora de cupom não lê PDF.
 * Aqui o PDF vira bitmap por página; daí sai como ESC/POS (cupom) ou como imagem
 * numa página do tamanho certo (driver do SO no Windows). No macOS/Linux a fila do
 * CUPS aceita PDF direto e este módulo nem é usado — ver dispatch.printPdf.
 */
const { BrowserWindow, nativeImage } = require('electron');
const path = require('path');

const PT_PER_INCH = 72;
const UM_PER_INCH = 25400;

/**
 * @param {Buffer} pdf
 * @param {object} opts
 * @param {number} opts.widthPx   largura de cada página, em pixels (dots da impressora)
 * @param {number} [opts.maxPages]
 * @returns {Promise<{numPages:number, pages:Array<{image: Electron.NativeImage, width:number, height:number, widthUm:number, heightUm:number}>}>}
 */
async function renderPages(pdf, opts = {}) {
  const widthPx = Math.max(8, Math.round(Number(opts.widthPx) || 384));
  const win = new BrowserWindow({
    show: false,
    width: 200,
    height: 200,
    webPreferences: { offscreen: true, sandbox: true, contextIsolation: true, backgroundThrottling: false },
  });
  try {
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('Timeout ao carregar o renderizador de PDF')), 20000);
      win.webContents.once('did-fail-load', (_e, code, desc) => { clearTimeout(t); reject(new Error(`Falha ao carregar renderizador (${code}): ${desc}`)); });
      win.webContents.once('did-finish-load', () => { clearTimeout(t); resolve(); });
      win.loadFile(path.join(__dirname, 'pdf-render.html'));
    });
    // o <script type="module"> termina depois do did-finish-load
    for (let i = 0; i < 100; i++) {
      if (await win.webContents.executeJavaScript('window.__pdfReady === true').catch(() => false)) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    const result = await win.webContents.executeJavaScript(
      `window.renderPdf(${JSON.stringify(pdf.toString('base64'))}, ${widthPx}, ${Number(opts.maxPages) || 50})`,
      true,
    );
    return {
      numPages: result.numPages,
      pages: result.pages.map((p) => ({
        image: nativeImage.createFromDataURL(p.png),
        width: p.width,
        height: p.height,
        widthUm: Math.round((p.widthPt / PT_PER_INCH) * UM_PER_INCH),
        heightUm: Math.round((p.heightPt / PT_PER_INCH) * UM_PER_INCH),
      })),
    };
  } catch (err) {
    throw new Error(`Não foi possível ler o PDF: ${err.message}`);
  } finally {
    if (!win.isDestroyed()) win.destroy();
  }
}

module.exports = { renderPages };
