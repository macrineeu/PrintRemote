#!/usr/bin/env node
/*
 * Gera o instalador. Uso:
 *   node scripts/build.js --mac        (ou npm run build:mac)
 *   node scripts/build.js --win
 *   node scripts/build.js --linux
 *   node scripts/build.js --mac --dir  (só a pasta .app, sem dmg/pkg, para testar rápido)
 *   node scripts/build.js --mac --unsigned  (ignora signing.env)
 *
 * Carrega build/signing.env (se existir) em process.env — sem sobrescrever o que já veio do
 * ambiente/CI — imprime um resumo do que vai ser assinado e chama o electron-builder.
 */
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const envFile = path.join(root, 'build', 'signing.env');
const args = process.argv.slice(2);
const unsigned = args.includes('--unsigned');
const builderArgs = args.filter((a) => a !== '--unsigned');

// ---- 1. signing.env -> process.env
function loadEnvFile(file) {
  if (!fs.existsSync(file)) return { loaded: false, keys: [] };
  const keys = [];
  for (const rawLine of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!value) continue; // vazio no arquivo = não configurado
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value;
      keys.push(key);
    }
  }
  return { loaded: true, keys };
}

const has = (k) => !!process.env[k];
const extra = [];

if (unsigned) {
  process.env.CSC_IDENTITY_AUTO_DISCOVERY = 'false';
  for (const k of ['CSC_NAME', 'CSC_LINK', 'WIN_CSC_LINK', 'WIN_CERT_SUBJECT_NAME', 'WIN_CERT_SHA1',
    'APPLE_ID', 'APPLE_API_KEY', 'AZURE_SIGN_ENDPOINT']) delete process.env[k];
  extra.push('-c.mac.notarize=false');
} else {
  const { loaded, keys } = loadEnvFile(envFile);
  console.log(loaded
    ? `[build] build/signing.env carregado (${keys.length} variáveis: ${keys.join(', ') || 'nenhuma'})`
    : '[build] build/signing.env não existe — build sem assinatura. Veja build/signing.env.example');
}

// ---- 2. Traduz variáveis "amigáveis" do signing.env em opções do electron-builder
if (!unsigned) {
  if (has('WIN_CERT_SUBJECT_NAME')) extra.push(`-c.win.signtoolOptions.certificateSubjectName=${process.env.WIN_CERT_SUBJECT_NAME}`);
  if (has('WIN_CERT_SHA1')) extra.push(`-c.win.signtoolOptions.certificateSha1=${process.env.WIN_CERT_SHA1}`);
  if (has('WIN_PUBLISHER_NAME')) extra.push(`-c.win.signtoolOptions.publisherName=${process.env.WIN_PUBLISHER_NAME}`);
  if (has('WIN_TIMESTAMP_SERVER')) extra.push(`-c.win.signtoolOptions.rfc3161TimeStampServer=${process.env.WIN_TIMESTAMP_SERVER}`);
  if (has('AZURE_SIGN_ENDPOINT')) {
    extra.push(`-c.win.azureSignOptions.endpoint=${process.env.AZURE_SIGN_ENDPOINT}`);
    extra.push(`-c.win.azureSignOptions.codeSigningAccountName=${process.env.AZURE_SIGN_ACCOUNT}`);
    extra.push(`-c.win.azureSignOptions.certificateProfileName=${process.env.AZURE_SIGN_PROFILE}`);
  }
}

// ---- 3. Resumo
const macSign = unsigned ? 'não (--unsigned)'
  : has('CSC_NAME') ? `sim, identidade "${process.env.CSC_NAME}"`
  : has('CSC_LINK') ? 'sim, certificado de CSC_LINK'
  : 'automática (usa Developer ID do Keychain, se houver)';
const notarize = unsigned ? 'não'
  : has('APPLE_ID') ? `sim, Apple ID ${process.env.APPLE_ID} (team ${process.env.APPLE_TEAM_ID || '?'})`
  : has('APPLE_API_KEY') ? 'sim, App Store Connect API key'
  : 'não (sem credenciais Apple)';
const winSign = unsigned ? 'não (--unsigned)'
  : has('WIN_CSC_LINK') ? 'sim, .pfx de WIN_CSC_LINK'
  : has('WIN_CERT_SUBJECT_NAME') || has('WIN_CERT_SHA1') ? 'sim, certificado do Windows Store / token'
  : has('AZURE_SIGN_ENDPOINT') ? 'sim, Azure Trusted Signing'
  : 'não (sem certificado)';

console.log('[build] Assinatura macOS : ' + macSign);
console.log('[build] Notarização Apple: ' + notarize);
console.log('[build] Assinatura Win   : ' + winSign);

// ---- 4. electron-builder
const bin = path.join(root, 'node_modules', '.bin', process.platform === 'win32' ? 'electron-builder.cmd' : 'electron-builder');
const finalArgs = [...builderArgs, ...extra];
console.log('[build] electron-builder ' + finalArgs.join(' '));
const res = spawnSync(bin, finalArgs, { stdio: 'inherit', cwd: root, env: process.env, shell: process.platform === 'win32' });
process.exit(res.status === null ? 1 : res.status);
