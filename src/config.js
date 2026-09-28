const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  port: 9100,
  host: '127.0.0.1',
  // Se preenchido, toda request precisa enviar o header "X-Print-Token" com este valor.
  token: '',
  // Origens permitidas no CORS. "*" libera tudo (útil em dev).
  allowedOrigins: ['*'],
  // Impressora padrão quando a request não informa "printer". Nome de um perfil abaixo ou fila do SO.
  defaultPrinter: '',
  // Perfis de impressora. A chave é o nome usado em "printer".
  //   type: "escpos" (bobina térmica: text vira ESC/POS)
  //         "raw"    (etiquetadora ZPL/PPLA: data sai cru)
  //         "system" (impressora comum via driver do SO)
  //   destino: "bluetooth" (MAC, macOS) | "device" (COM3 no Windows) | "host"+"port" (rede) | "queue" (fila do SO)
  //   escpos: "columns" (32 p/ 58mm, 48 p/ 80mm), "codepage" (cp1252|cp860|cp850|cp437), "feed", "cut"
  // Ex: "MTI-773": { "type": "escpos", "bluetooth": "AA:BB:CC:DD:EE:FF", "channel": 1, "columns": 32, "codepage": "cp1252", "feed": 4 }
  printers: {},
  // Deep link serviceprint://print/{id}: URL da sua API que devolve o job em JSON.
  // Use "{id}" como placeholder. Ex: "https://sua-api.com/prints/{id}"
  jobsUrl: '',
  // Se preenchido, enviado como "Authorization: Bearer <jobsToken>" ao buscar o job.
  jobsToken: '',
  // Abrir o serviço junto com o login do usuário (só no app instalado). Também pode ser alternado no menu do tray.
  startAtLogin: true,
};

function configPath() {
  return path.join(app.getPath('userData'), 'config.json');
}

function load() {
  const file = configPath();
  try {
    if (fs.existsSync(file)) {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...DEFAULTS, ...raw };
    }
  } catch (err) {
    console.error('[config] erro ao ler config.json, usando padrão:', err.message);
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(DEFAULTS, null, 2));
  return { ...DEFAULTS };
}

function save(cfg) {
  fs.writeFileSync(configPath(), JSON.stringify(cfg, null, 2));
}

module.exports = { load, save, configPath, DEFAULTS };
