const { BrowserWindow } = require('electron');

/**
 * Lista impressoras instaladas no sistema operacional.
 * Impressoras Bluetooth pareadas no SO aparecem aqui normalmente.
 */
async function listPrinters() {
  const win = new BrowserWindow({ show: false });
  try {
    const printers = await win.webContents.getPrintersAsync();
    return printers.map((p) => ({
      name: p.name,
      displayName: p.displayName,
      description: p.description,
      status: p.status,
      isDefault: p.isDefault,
      options: p.options,
    }));
  } finally {
    win.destroy();
  }
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Monta o HTML a partir do payload da request.
 * Aceita "html" (usado como está) ou "text" (envolvido em <pre>).
 */
function buildHtml(job) {
  if (job.html) return job.html;
  const text = escapeHtml(job.text ?? '');
  return `<!doctype html><html><head><meta charset="utf-8">
<style>body{margin:0;padding:8px;font-family:monospace;font-size:12px}pre{white-space:pre-wrap;margin:0}</style>
</head><body><pre>${text}</pre></body></html>`;
}

/**
 * Imprime um job.
 * @param {object} job
 * @param {string} [job.printer]   nome da impressora (campo "name" de /printers)
 * @param {string} [job.html]      conteúdo HTML
 * @param {string} [job.text]      texto puro
 * @param {number} [job.copies]    cópias (padrão 1)
 * @param {boolean} [job.silent]   true = sem diálogo (padrão true)
 * @param {boolean} [job.color]    padrão false
 * @param {object|string} [job.pageSize]  ex: "A4" ou { width: 80000, height: 200000 } (micrômetros)
 * @param {object} [job.margins]   ex: { marginType: 'none' }
 * @param {boolean} [job.landscape]
 */
function print(job, defaultPrinter = '') {
  return new Promise((resolve, reject) => {
    const win = new BrowserWindow({
      show: false,
      webPreferences: { sandbox: true, contextIsolation: true },
    });

    const cleanup = () => {
      if (!win.isDestroyed()) win.destroy();
    };

    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('Timeout ao carregar conteúdo para impressão'));
    }, 30000);

    win.webContents.once('did-fail-load', (_e, code, desc) => {
      clearTimeout(timeout);
      cleanup();
      reject(new Error(`Falha ao carregar conteúdo (${code}): ${desc}`));
    });

    win.webContents.once('did-finish-load', () => {
      clearTimeout(timeout);
      const options = {
        silent: job.silent !== false,
        printBackground: true,
        color: job.color === true,
        copies: Number(job.copies) > 0 ? Number(job.copies) : 1,
        margins: job.margins || { marginType: 'none' },
        landscape: job.landscape === true,
      };
      const deviceName = job.printer || defaultPrinter;
      if (deviceName) options.deviceName = deviceName;
      if (job.pageSize) options.pageSize = job.pageSize;

      win.webContents.print(options, (success, failureReason) => {
        cleanup();
        if (success) resolve({ success: true, printer: deviceName || '(padrão do sistema)' });
        else reject(new Error(failureReason || 'Impressão falhou'));
      });
    });

    const html = buildHtml(job);
    win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  });
}

module.exports = { listPrinters, print };
