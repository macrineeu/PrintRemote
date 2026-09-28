/**
 * Codificador ESC/POS para impressoras térmicas de bobina (cupom), como a
 * Tomate MTI-773 (58 mm, 384 dots, 32 colunas na fonte A).
 *
 * Entrada: texto simples OU lista de linhas com formatação básica.
 * Saída: Buffer pronto para ser enviado cru (Bluetooth/serial, USB, rede).
 *
 * Marcação inline opcional no texto (uma tag por linha, no começo):
 *   [C]  centralizado     [R]  direita      [L] esquerda (padrão)
 *   [B]  negrito          [H]  altura dupla [W] largura dupla  [BIG] ambos
 *   [U]  sublinhado       [-]  linha de traços na largura toda
 *   [CUT] corte (ignorado em impressora sem guilhotina)
 *   [BC:EAN13]7891000000017   código de barras (EAN13, EAN8, CODE128, CODE39, UPCA, ITF)
 *   [BC:EAN13:h=80:w=2:hri=0]  opções: h altura em dots, w largura do módulo (2-6), hri 0/1 texto abaixo
 *   [QR]https://...            QR code   ([QR:s=6:ec=M] s tamanho do módulo 1-16, ec L/M/Q/H)
 *   Ex: "[C][B]MINHA LOJA"  →  centralizado e em negrito
 */
const ESC = 0x1b;
const GS = 0x1d;

const CODEPAGES = {
  cp437: 0,
  cp850: 2,
  cp860: 3, // português
  cp858: 19,
  cp1252: 16,
};

const DEFAULTS = {
  columns: 32,      // 58 mm = 32 col (fonte A) | 80 mm = 48 col
  codepage: 'cp1252',
  feed: 4,          // linhas em branco no fim para o papel sair da cabeça
  cut: false,       // MTI-773 não tem guilhotina
  cashDrawer: false,
};

function bytes(...parts) {
  return Buffer.concat(parts.map((p) => (Buffer.isBuffer(p) ? p : Buffer.from(Array.isArray(p) ? p : [p]))));
}

/**
 * Converte texto para o codepage. cp1252 e latin1 coincidem para os acentos
 * do português, então usamos o latin1 nativo do Node. Para cp860/cp850 os
 * acentos ficam em posições diferentes; cobrimos os mais comuns.
 */
const CP860 = { ç: 0x87, Ç: 0x80, ã: 0x84, Ã: 0x8e, õ: 0x94, Õ: 0x99, á: 0xa0, Á: 0x86, é: 0x82, É: 0x90, í: 0xa1, Í: 0x8b, ó: 0xa2, Ó: 0x9f, ú: 0xa3, Ú: 0x96, â: 0x83, Â: 0x8f, ê: 0x88, Ê: 0x89, ô: 0x93, Ô: 0x8c, à: 0x85, À: 0x91, ü: 0x81, Ü: 0x9a, º: 0xa7, ª: 0xa6, '°': 0xf8 };
const CP850 = { ...CP860, Ç: 0x80, ã: 0xc6, Ã: 0xc7, õ: 0xe4, Õ: 0xe5, Á: 0xb5, É: 0x90, Í: 0xd6, Ó: 0xe0, Ú: 0xe9, Â: 0xb6, Ê: 0xd2, Ô: 0xe2, À: 0xb7 };

function encodeText(str, codepage) {
  if (codepage === 'cp860' || codepage === 'cp850' || codepage === 'cp858') {
    const map = codepage === 'cp860' ? CP860 : CP850;
    const out = [];
    for (const ch of str) {
      const c = ch.codePointAt(0);
      if (c < 0x80) out.push(c);
      else if (map[ch] !== undefined) out.push(map[ch]);
      else out.push(0x3f); // ?
    }
    return Buffer.from(out);
  }
  // cp1252 / cp437: latin1 cobre o cp1252; para cp437 acentos saem aproximados.
  return Buffer.from(str, 'latin1');
}

const BARCODES = { UPCA: 65, UPCE: 66, EAN13: 67, EAN8: 68, CODE39: 69, ITF: 70, CODABAR: 71, CODE93: 72, CODE128: 73 };

/** GS k (função B): código de barras 1D. */
function barcode(type, data, o = {}) {
  const m = BARCODES[type.toUpperCase()];
  if (!m) throw new Error(`Código de barras "${type}" não suportado (${Object.keys(BARCODES).join(', ')})`);
  let d = String(data).replace(/\s+/g, '');
  if (m === 67 && d.length === 13) d = d.slice(0, 12); // EAN13: a impressora calcula o dígito verificador
  if (m === 68 && d.length === 8) d = d.slice(0, 7);
  if (m === 73) d = '{B' + d;                            // CODE128 conjunto B
  const h = Math.min(Math.max(Number(o.h) || 80, 1), 255);
  const w = Math.min(Math.max(Number(o.w) || 2, 1), 6);
  const hri = o.hri === undefined ? 2 : Number(o.hri) ? 2 : 0;
  return bytes([GS, 0x48, hri], [GS, 0x68, h], [GS, 0x77, w], [GS, 0x66, 0], [GS, 0x6b, m, d.length], Buffer.from(d, 'latin1'), [0x0a]);
}

/** GS ( k: QR code (modelo 2). */
function qrcode(data, o = {}) {
  const buf = Buffer.from(String(data), 'utf8');
  const size = Math.min(Math.max(Number(o.s) || 6, 1), 16);
  const ec = { L: 48, M: 49, Q: 50, H: 51 }[String(o.ec || 'M').toUpperCase()] ?? 49;
  const len = buf.length + 3;
  return bytes(
    [GS, 0x28, 0x6b, 4, 0, 49, 65, 50, 0],            // modelo 2
    [GS, 0x28, 0x6b, 3, 0, 49, 67, size],             // tamanho do módulo
    [GS, 0x28, 0x6b, 3, 0, 49, 69, ec],               // correção de erro
    [GS, 0x28, 0x6b, len & 0xff, (len >> 8) & 0xff, 49, 80, 48], buf, // armazena
    [GS, 0x28, 0x6b, 3, 0, 49, 81, 48],               // imprime
    [0x0a]
  );
}

function parseOpts(str) {
  const o = {};
  for (const part of (str || '').split(':').filter(Boolean)) {
    const [k, v] = part.split('=');
    if (k && v !== undefined) o[k.toLowerCase()] = v;
  }
  return o;
}

function parseTags(line) {
  const fmt = { align: 0, bold: false, dh: false, dw: false, underline: false, rule: false, cut: false, barcode: null, qr: null };
  let rest = line;
  const re = /^\[(C|R|L|B|H|W|BIG|U|-|CUT|BC(?::[^\]]*)?|QR(?::[^\]]*)?)\]/i;
  let m;
  while ((m = re.exec(rest))) {
    const t = m[1].toUpperCase();
    if (t.startsWith('BC')) {
      const [, type, ...opts] = t.split(':');
      fmt.barcode = { type: type || 'EAN13', opts: parseOpts(opts.join(':')) };
      rest = rest.slice(m[0].length);
      break;
    }
    if (t.startsWith('QR')) {
      fmt.qr = parseOpts(t.slice(3));
      rest = rest.slice(m[0].length);
      break;
    }
    if (t === 'C') fmt.align = 1;
    else if (t === 'R') fmt.align = 2;
    else if (t === 'L') fmt.align = 0;
    else if (t === 'B') fmt.bold = true;
    else if (t === 'H') fmt.dh = true;
    else if (t === 'W') fmt.dw = true;
    else if (t === 'BIG') fmt.dh = fmt.dw = true;
    else if (t === 'U') fmt.underline = true;
    else if (t === '-') fmt.rule = true;
    else if (t === 'CUT') fmt.cut = true;
    rest = rest.slice(m[0].length);
  }
  return { fmt, text: rest };
}

/** Quebra uma linha longa respeitando a largura de colunas. */
function wrap(text, cols) {
  if (text.length <= cols) return [text];
  const out = [];
  const words = text.split(' ');
  let cur = '';
  for (const w of words) {
    if (w.length > cols) {
      if (cur) out.push(cur), (cur = '');
      for (let i = 0; i < w.length; i += cols) out.push(w.slice(i, i + cols));
      continue;
    }
    if ((cur + ' ' + w).trim().length > cols) {
      out.push(cur);
      cur = w;
    } else cur = (cur + ' ' + w).trim();
  }
  if (cur) out.push(cur);
  return out;
}

/**
 * Gera o Buffer ESC/POS.
 * @param {string|string[]} text   texto (linhas separadas por \n) ou array de linhas
 * @param {object} opts            { columns, codepage, feed, cut, cashDrawer }
 */
function encode(text, opts = {}) {
  const o = { ...DEFAULTS, ...opts };
  const cp = CODEPAGES[o.codepage] ?? CODEPAGES.cp1252;
  const lines = Array.isArray(text) ? text : String(text ?? '').replace(/\r\n/g, '\n').split('\n');

  const parts = [];
  parts.push(bytes([ESC, 0x40]));          // ESC @  inicializa
  parts.push(bytes([ESC, 0x74, cp]));      // ESC t  codepage
  parts.push(bytes([ESC, 0x52, 0x0c]));    // ESC R  charset internacional: Portugal

  for (const raw of lines) {
    const { fmt, text: t } = parseTags(raw);
    if (fmt.cut) {
      if (o.cut) parts.push(bytes([GS, 0x56, 0x42, 0x00]));
      continue;
    }
    if (fmt.barcode || fmt.qr) {
      parts.push(bytes([ESC, 0x61, fmt.align]));
      parts.push(fmt.barcode ? barcode(fmt.barcode.type, t.trim(), fmt.barcode.opts) : qrcode(t.trim(), fmt.qr));
      continue;
    }
    const cols = fmt.dw ? Math.floor(o.columns / 2) : o.columns;
    const content = fmt.rule ? ['-'.repeat(cols)] : wrap(t, cols);

    parts.push(bytes([ESC, 0x61, fmt.align]));                        // ESC a  alinhamento
    parts.push(bytes([ESC, 0x45, fmt.bold ? 1 : 0]));                 // ESC E  negrito
    parts.push(bytes([ESC, 0x2d, fmt.underline ? 1 : 0]));            // ESC -  sublinhado
    parts.push(bytes([GS, 0x21, (fmt.dw ? 0x10 : 0) | (fmt.dh ? 0x01 : 0)])); // GS !  tamanho
    for (const l of content) parts.push(encodeText(l, o.codepage), bytes([0x0a]));
  }

  // volta ao normal e alimenta o papel
  parts.push(bytes([ESC, 0x61, 0], [ESC, 0x45, 0], [ESC, 0x2d, 0], [GS, 0x21, 0]));
  if (o.feed > 0) parts.push(bytes([ESC, 0x64, Math.min(o.feed, 255)])); // ESC d n
  if (o.cut) parts.push(bytes([GS, 0x56, 0x42, 0x00]));                  // GS V  corte parcial
  if (o.cashDrawer) parts.push(bytes([ESC, 0x70, 0x00, 0x19, 0xfa]));    // ESC p  gaveta

  return Buffer.concat(parts);
}

module.exports = { encode, barcode, qrcode, DEFAULTS, CODEPAGES, BARCODES };
