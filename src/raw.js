/**
 * Impressão RAW: envia bytes direto para a impressora, sem passar pelo driver
 * gráfico. É o que impressoras de etiqueta (ZPL/PPLA/EPL) e térmicas ESC/POS
 * precisam — se o conteúdo passar pelo driver do fabricante, ele vira imagem e
 * a impressora imprime "^XA^FO..." como texto legível na etiqueta.
 *
 * Destinos suportados (um por job):
 *   printer  → fila do sistema operacional
 *                macOS/Linux: `lp -d <fila> -o raw`
 *                Windows:     winspool (OpenPrinter/WritePrinter, datatype RAW) via PowerShell
 *   host     → impressora de rede, TCP (porta padrão 9100)
 *   device   → porta serial / Bluetooth SPP (ex: COM3 no Windows, /dev/ttyUSB0 no Linux)
 *   bluetooth→ endereço MAC de impressora Bluetooth clássica (SPP). No macOS abre o canal RFCOMM
 *              direto via helper nativo (assets/mac/btprint), porque a porta /dev/cu.<nome> não
 *              estabelece a conexão em macOS recentes. No Windows use "device": "COMx".
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const { execFile } = require('child_process');

const TCP_TIMEOUT_MS = 15000;
const BT_TIMEOUT_MS = 30000;

/** Decodifica o campo "data" do job para Buffer. */
function decode(data, encoding = 'utf8') {
  if (Buffer.isBuffer(data)) return data;
  if (typeof data !== 'string') throw new Error('"data" deve ser string');
  switch (encoding) {
    case 'base64':
      return Buffer.from(data, 'base64');
    case 'latin1':
    case 'binary':
      return Buffer.from(data, 'latin1');
    case 'utf8':
    case 'utf-8':
      return Buffer.from(data, 'utf8');
    default:
      throw new Error(`encoding "${encoding}" não suportado (use utf8, latin1 ou base64)`);
  }
}

/**
 * Remove as linhas de cabeçalho iniciadas por ";" que alguns geradores de etiqueta colocam no topo
 * do arquivo (informativas — ZPL e PPLA não têm sintaxe de comentário).
 * Só remove linhas que estão ANTES do primeiro comando real.
 */
function stripCommentHeader(buf) {
  const text = buf.toString('latin1');
  const lines = text.split(/\r?\n/);
  let i = 0;
  while (i < lines.length && (lines[i].startsWith(';') || lines[i].trim() === '')) i++;
  if (i === 0) return buf;
  return Buffer.from(lines.slice(i).join('\n'), 'latin1');
}

/** Prepara os bytes finais do job. */
function prepare(job) {
  let buf = decode(job.data, job.encoding);
  const format = String(job.format || '').toLowerCase();
  if (job.stripComments !== false && ['zpl', 'ppla', 'epl', 'zebra', 'argox', 'elgin'].includes(format)) {
    buf = stripCommentHeader(buf);
  }
  if (buf.length === 0) throw new Error('Conteúdo vazio após preparo');
  // Garante quebra de linha final: alguns firmwares só executam o último comando ao receber "\n".
  if (buf[buf.length - 1] !== 0x0a) buf = Buffer.concat([buf, Buffer.from('\n')]);
  return buf;
}

function tmpFile(ext = 'bin') {
  return path.join(os.tmpdir(), `service-print-${Date.now()}-${Math.random().toString(36).slice(2)}.${ext}`);
}

// ─── Destino: fila do sistema ────────────────────────────────────────────────

function sendToQueueUnix(printerName, buf) {
  return new Promise((resolve, reject) => {
    const file = tmpFile();
    fs.writeFileSync(file, buf);
    const args = ['-d', printerName, '-o', 'raw', '-t', 'service-print', file];
    execFile('lp', args, { timeout: 30000 }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      if (err) {
        const msg = (stderr || err.message).trim();
        return reject(new Error(`lp falhou para a fila "${printerName}": ${msg}. Confira o nome em GET /printers`));
      }
      resolve({ via: 'cups', detail: stdout.trim() });
    });
  });
}

/**
 * Manda um ARQUIVO para a fila do CUPS SEM `-o raw`: o próprio sistema converte
 * (PDF → o que o driver entende). É o caminho do PDF em impressora comum no macOS/Linux.
 */
function sendFileToQueueUnix(printerName, file, { copies = 1, title = 'service-print' } = {}) {
  return new Promise((resolve, reject) => {
    const args = ['-d', printerName, '-n', String(Math.max(1, Number(copies) || 1)), '-t', title, file];
    execFile('lp', args, { timeout: 30000 }, (err, stdout, stderr) => {
      if (err) {
        const msg = (stderr || err.message).trim();
        return reject(new Error(`lp falhou para a fila "${printerName}": ${msg}. Confira o nome em GET /printers`));
      }
      resolve({ via: 'cups', detail: stdout.trim() });
    });
  });
}

const WINDOWS_RAW_PS1 = String.raw`
param([Parameter(Mandatory=$true)][string]$Printer, [Parameter(Mandatory=$true)][string]$File)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @"
using System;
using System.IO;
using System.Runtime.InteropServices;
public class RawPrinter {
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct DOCINFOW {
    [MarshalAs(UnmanagedType.LPWStr)] public string pDocName;
    [MarshalAs(UnmanagedType.LPWStr)] public string pOutputFile;
    [MarshalAs(UnmanagedType.LPWStr)] public string pDataType;
  }
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern bool OpenPrinter(string src, out IntPtr h, IntPtr pd);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool ClosePrinter(IntPtr h);
  [DllImport("winspool.drv", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern int StartDocPrinter(IntPtr h, int level, ref DOCINFOW di);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndDocPrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool StartPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool EndPagePrinter(IntPtr h);
  [DllImport("winspool.drv", SetLastError = true)]
  public static extern bool WritePrinter(IntPtr h, byte[] buf, int len, out int written);

  public static int Send(string printer, string file) {
    byte[] bytes = File.ReadAllBytes(file);
    IntPtr h;
    if (!OpenPrinter(printer, out h, IntPtr.Zero))
      throw new Exception("OpenPrinter falhou (impressora '" + printer + "' existe?) erro " + Marshal.GetLastWin32Error());
    try {
      DOCINFOW di = new DOCINFOW();
      di.pDocName = "service-print";
      di.pDataType = "RAW";
      if (StartDocPrinter(h, 1, ref di) == 0)
        throw new Exception("StartDocPrinter falhou, erro " + Marshal.GetLastWin32Error());
      try {
        if (!StartPagePrinter(h)) throw new Exception("StartPagePrinter falhou, erro " + Marshal.GetLastWin32Error());
        int written;
        if (!WritePrinter(h, bytes, bytes.Length, out written))
          throw new Exception("WritePrinter falhou, erro " + Marshal.GetLastWin32Error());
        EndPagePrinter(h);
        return written;
      } finally { EndDocPrinter(h); }
    } finally { ClosePrinter(h); }
  }
}
"@
$written = [RawPrinter]::Send($Printer, $File)
Write-Output "written=$written"
`;

function sendToQueueWindows(printerName, buf) {
  return new Promise((resolve, reject) => {
    const file = tmpFile();
    const script = tmpFile('ps1');
    fs.writeFileSync(file, buf);
    fs.writeFileSync(script, WINDOWS_RAW_PS1, 'utf8');
    const args = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, '-Printer', printerName, '-File', file];
    execFile('powershell.exe', args, { timeout: 60000, windowsHide: true }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      fs.unlink(script, () => {});
      if (err) return reject(new Error(`winspool falhou: ${(stderr || stdout || err.message).trim()}`));
      resolve({ via: 'winspool', detail: stdout.trim() });
    });
  });
}

function sendToQueue(printerName, buf) {
  if (!printerName) throw new Error('Informe "printer" (nome da fila) para impressão RAW');
  return process.platform === 'win32' ? sendToQueueWindows(printerName, buf) : sendToQueueUnix(printerName, buf);
}

// ─── Destino: TCP (impressora de rede) ───────────────────────────────────────

function sendToTcp(host, port, buf) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port: Number(port) || 9100 });
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      socket.destroy();
      if (err) reject(err);
      else resolve({ via: 'tcp', detail: `${host}:${port || 9100}` });
    };
    socket.setTimeout(TCP_TIMEOUT_MS, () => finish(new Error(`Timeout ao conectar/enviar para ${host}:${port}`)));
    socket.on('error', (err) => finish(new Error(`TCP ${host}:${port}: ${err.message}`)));
    socket.on('connect', () => {
      socket.end(buf, () => finish());
    });
  });
}

// ─── Destino: porta serial / Bluetooth SPP ───────────────────────────────────

function sendToDevice(devicePath, buf) {
  return new Promise((resolve, reject) => {
    let p = devicePath;
    // Windows: COM10+ precisa do prefixo \\.\ ; aplicamos sempre para uniformizar.
    if (process.platform === 'win32' && /^COM\d+$/i.test(p)) p = `\\\\.\\${p}`;
    fs.writeFile(p, buf, (err) => {
      if (err) return reject(new Error(`Falha ao escrever em ${devicePath}: ${err.message}`));
      resolve({ via: 'device', detail: devicePath });
    });
  });
}

// ─── Destino: Bluetooth clássico por MAC (macOS) ─────────────────────────────

function helperPath(name) {
  // Em produção o binário fica fora do app.asar (asarUnpack) em app.asar.unpacked/assets/...
  const base = path.join(__dirname, '..', 'assets');
  return path.join(base.replace(`app.asar${path.sep}`, `app.asar.unpacked${path.sep}`), name);
}

function sendToBluetooth(mac, channel, buf) {
  return new Promise((resolve, reject) => {
    if (process.platform !== 'darwin') {
      return reject(new Error('Destino "bluetooth" (MAC) só é suportado no macOS. No Windows/Linux use "device" com a porta COM/tty do pareamento.'));
    }
    const bin = helperPath(path.join('mac', 'btprint'));
    const file = tmpFile();
    fs.writeFileSync(file, buf);
    const args = [mac, file, String(channel || 1)];
    execFile(bin, args, { timeout: BT_TIMEOUT_MS }, (err, stdout, stderr) => {
      fs.unlink(file, () => {});
      const lines = String(stdout || '').trim().split('\n').filter(Boolean);
      const resposta = lines.find((l) => l.startsWith('resposta:'));
      if (err) {
        let msg = (stderr || '').trim();
        if (!msg && err.killed) {
          msg = `helper btprint não respondeu em ${Math.round(BT_TIMEOUT_MS / 1000)} s e foi encerrado — se o macOS mostrou o aviso "Service Print deseja usar o Bluetooth", clique em Permitir e tente de novo (Ajustes > Privacidade e Segurança > Bluetooth)`;
        } else if (!msg) {
          msg = `helper btprint terminou com ${err.signal ? `sinal ${err.signal}` : `código ${err.code}`}: ${err.message}`;
        }
        return reject(new Error(`Bluetooth ${mac}: ${msg}`));
      }
      resolve({ via: 'bluetooth', detail: `${mac} canal ${channel || 1}`, response: resposta ? resposta.replace('resposta: ', '') : undefined });
    });
  });
}

// ─── Entrada principal ───────────────────────────────────────────────────────

/**
 * @param {object} job
 * @param {string}  job.data       conteúdo (ZPL/PPLA/ESC-POS...)
 * @param {string} [job.encoding]  utf8 (padrão) | latin1 | base64
 * @param {string} [job.format]    zpl | ppla | epl | escpos (informativo; zpl/ppla removem cabeçalho ";")
 * @param {string} [job.printer]   fila do SO
 * @param {string} [job.host]      IP/host da impressora de rede
 * @param {number} [job.port]      porta TCP (padrão 9100)
 * @param {string} [job.device]    porta serial (COM3, /dev/ttyUSB0)
 * @param {string} [job.bluetooth] MAC da impressora Bluetooth (ex: AA:BB:CC:DD:EE:FF)
 * @param {number} [job.channel]   canal RFCOMM (padrão 1)
 * @param {number} [job.copies]    repete o envio N vezes (ZPL/PPLA já têm ^PQ/Q; normalmente deixe 1)
 * @param {string} [defaultPrinter]
 */
async function print(job, defaultPrinter = '') {
  const buf = prepare(job);
  const copies = Number(job.copies) > 0 ? Number(job.copies) : 1;

  let send;
  let target;
  if (job.host) {
    target = `${job.host}:${job.port || 9100}`;
    send = () => sendToTcp(job.host, job.port || 9100, buf);
  } else if (job.bluetooth) {
    target = `bluetooth ${job.bluetooth}`;
    send = () => sendToBluetooth(job.bluetooth, job.channel, buf);
  } else if (job.device) {
    target = job.device;
    send = () => sendToDevice(job.device, buf);
  } else {
    target = job.printer || defaultPrinter;
    send = () => sendToQueue(target, buf);
  }

  let result;
  for (let i = 0; i < copies; i++) result = await send();
  return { success: true, printer: target, bytes: buf.length, copies, ...result };
}

module.exports = { print, prepare, decode, stripCommentHeader, sendFileToQueueUnix, tmpFile };
