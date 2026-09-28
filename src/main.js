const { app, BrowserWindow, Tray, Menu, ipcMain, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const config = require('./config');
const server = require('./server');
const dispatch = require('./dispatch');
const deeplink = require('./deeplink');

let mainWindow = null;
let tray = null;
let httpServer = null;
let cfg = null;
const logs = [];
let ready = false;
const pendingUrls = [];

// ---- Protocolo serviceprint:// ----
function registerProtocol() {
  let ok;
  if (process.platform !== 'darwin' && !app.isPackaged) {
    // Em dev no Windows/Linux é preciso apontar para o electron + caminho do projeto.
    ok = app.setAsDefaultProtocolClient(deeplink.SCHEME, process.execPath, [path.resolve(process.argv[1])]);
  } else {
    ok = app.setAsDefaultProtocolClient(deeplink.SCHEME);
  }
  log(`Protocolo ${deeplink.SCHEME}:// ${ok ? 'registrado' : 'NÃO registrado (no macOS só funciona empacotado)'}`, ok ? 'ok' : 'warn');
}

async function handleDeepLink(url, { rethrow = false } = {}) {
  if (!ready) {
    pendingUrls.push(url);
    return;
  }
  try {
    return await deeplink.handle(url, cfg, log);
  } catch (err) {
    log(`Deep link falhou: ${err.message}`, 'error');
    if (rethrow) throw err;
  }
}

// macOS entrega a URL por este evento (pode ocorrer antes do "ready").
app.on('open-url', (event, url) => {
  event.preventDefault();
  handleDeepLink(url);
});

function log(message, level = 'info', data) {
  const entry = { time: new Date().toISOString(), level, message };
  if (data !== undefined) entry.data = data;
  logs.push(entry);
  if (logs.length > 500) logs.shift();
  let line = `[${entry.time}] [${level}] ${message}`;
  if (data !== undefined) line += '\n' + JSON.stringify(data, null, 2);
  console.log(line);
  try {
    fs.appendFileSync(path.join(app.getPath('userData'), 'service-print.log'), line + '\n');
  } catch (_) {}
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('log', entry);
}

function startedHidden() {
  if (process.argv.includes('--hidden')) return true;
  try {
    return process.platform === 'darwin' && app.getLoginItemSettings().wasOpenedAsHidden;
  } catch (_) {
    return false;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 720,
    height: 560,
    show: !startedHidden(),
    title: 'Service Print',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  // Fechar a janela só esconde; o serviço continua rodando no tray.
  mainWindow.on('close', (e) => {
    if (!app.isQuitting) {
      e.preventDefault();
      mainWindow.hide();
    }
  });
}

// ---- Iniciar com o sistema ----
// Só faz sentido no app instalado: em `npm start` o item apontaria para o binário do electron dentro
// de node_modules. Windows: chave HKCU\...\Run (removida pelo desinstalador, ver build/installer.nsh).
// macOS: Login Item (Ajustes do Sistema > Geral > Itens de Início). Linux: o Electron não implementa.
function applyLoginItem() {
  if (!app.isPackaged || process.platform === 'linux') return;
  const want = cfg.startAtLogin !== false;
  try {
    const current = app.getLoginItemSettings().openAtLogin;
    if (current !== want) {
      app.setLoginItemSettings({ openAtLogin: want, openAsHidden: true, args: ['--hidden'] });
      log(`Iniciar com o sistema: ${want ? 'ativado' : 'desativado'}`);
    }
  } catch (err) {
    log(`Não foi possível ajustar "iniciar com o sistema": ${err.message}`, 'warn');
  }
}

function toggleLoginItem() {
  cfg.startAtLogin = !(cfg.startAtLogin !== false);
  try {
    config.save(cfg);
  } catch (err) {
    log(`Não foi possível salvar config.json: ${err.message}`, 'error');
  }
  applyLoginItem();
  buildTrayMenu();
}

function buildTrayMenu() {
  if (!tray) return;
  tray.setContextMenu(
    Menu.buildFromTemplate([
      { label: 'Abrir painel', click: () => mainWindow.show() },
      { label: 'Abrir config.json', click: () => shell.openPath(config.configPath()) },
      { label: 'Abrir log', click: () => shell.openPath(path.join(app.getPath('userData'), 'service-print.log')) },
      { type: 'separator' },
      {
        label: 'Iniciar com o sistema',
        type: 'checkbox',
        checked: cfg.startAtLogin !== false,
        enabled: app.isPackaged && process.platform !== 'linux',
        click: toggleLoginItem,
      },
      { type: 'separator' },
      {
        label: 'Sair',
        click: () => {
          app.isQuitting = true;
          app.quit();
        },
      },
    ])
  );
}

function createTray() {
  const icon = nativeImage.createFromPath(path.join(__dirname, '..', 'assets', 'trayTemplate.png'));
  tray = new Tray(icon.isEmpty() ? nativeImage.createEmpty() : icon);
  tray.setToolTip('Service Print');
  buildTrayMenu();
  tray.on('click', () => mainWindow.show());
}

ipcMain.handle('status:get', () => ({
  running: !!httpServer,
  url: `http://${cfg.host}:${cfg.port}`,
  tokenEnabled: !!cfg.token,
  defaultPrinter: cfg.defaultPrinter,
  configPath: config.configPath(),
  logs,
}));
ipcMain.handle('printers:list', () => dispatch.listPrinters(cfg));
ipcMain.handle('print:test', async (_e, printerName) => {
  const text = `[C][B]SERVICE PRINT\n[C]Teste de impressão\n[-]\nImpressora: ${printerName || cfg.defaultPrinter || '(padrão)'}\n${new Date().toLocaleString('pt-BR')}\nAcentos: ação coração ç ã é\n[-]\n[R]OK`;
  log(`Teste de impressão → ${printerName || cfg.defaultPrinter || '(padrão)'}`);
  return dispatch.print({ text, printer: printerName || undefined }, cfg);
});
ipcMain.handle('config:open', () => shell.openPath(config.configPath()));
ipcMain.handle('logs:clear', () => { logs.length = 0; });

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  // Windows/Linux: a URL chega como argumento da segunda instância.
  app.on('second-instance', (_e, argv) => {
    const url = deeplink.findUrlInArgv(argv);
    if (url) handleDeepLink(url);
    else if (mainWindow) mainWindow.show();
  });

  app.whenReady().then(async () => {
    cfg = config.load();
    createWindow();
    createTray();
    registerProtocol();
    applyLoginItem();
    try {
      httpServer = await server.start(cfg, log, { handleDeepLink });
    } catch (err) {
      log(`Não foi possível iniciar o servidor na porta ${cfg.port}: ${err.message}`, 'error');
    }

    // Windows/Linux: URL na primeira abertura vem no argv do próprio processo.
    const argvUrl = deeplink.findUrlInArgv(process.argv);
    if (argvUrl) pendingUrls.push(argvUrl);

    ready = true;
    for (const url of pendingUrls.splice(0)) handleDeepLink(url);
  });

  // Não encerrar quando todas as janelas fecham (serviço em background).
  app.on('window-all-closed', () => {});
  app.on('activate', () => mainWindow && mainWindow.show());
}
