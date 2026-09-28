const express = require('express');
const cors = require('cors');
const raw = require('./raw');
const dispatch = require('./dispatch');

/** Resumo da request para log/debug: método, rota, origem, headers relevantes, query e body. */
function describeRequest(req) {
  return {
    method: req.method,
    path: req.originalUrl,
    origin: req.get('Origin') || null,
    ip: req.ip,
    headers: {
      'content-type': req.get('Content-Type') || null,
      'user-agent': req.get('User-Agent') || null,
      'x-print-token': req.get('X-Print-Token') ? '(enviado)' : null,
    },
    query: req.query,
    body: req.body,
  };
}

/** Corta html/text/data longos para não poluir o log. */
function summarizeJob(job) {
  const out = { ...job };
  for (const k of ['html', 'text', 'data']) {
    if (typeof out[k] === 'string' && out[k].length > 500) {
      out[k] = out[k].slice(0, 500) + `… (+${out[k].length - 500} chars)`;
    }
  }
  return out;
}

/**
 * Cria e inicia o servidor HTTP local.
 * @param {object} cfg       configuração (port, host, token, allowedOrigins, defaultPrinter)
 * @param {function} log     callback de log (msg, level, data)
 * @param {object} hooks     { handleDeepLink(url) } — usado pela rota de simulação
 */
function start(cfg, log = console.log, hooks = {}) {
  const app = express();

  app.use(
    cors({
      origin: cfg.allowedOrigins.includes('*') ? true : cfg.allowedOrigins,
      methods: ['GET', 'POST', 'OPTIONS'],
      allowedHeaders: ['Content-Type', 'X-Print-Token'],
    })
  );
  app.use(express.json({ limit: '10mb' }));
  app.use(express.text({ limit: '10mb', type: ['text/*'] }));

  // Log de toda request recebida (exceto preflight)
  app.use((req, _res, next) => {
    if (req.method !== 'OPTIONS') log(`${req.method} ${req.originalUrl} ← ${req.get('Origin') || req.ip}`);
    next();
  });

  // Autenticação opcional por token
  app.use((req, res, next) => {
    if (!cfg.token) return next();
    if (req.get('X-Print-Token') === cfg.token) return next();
    log(`401 ${req.method} ${req.path} (token inválido)`, 'warn');
    res.status(401).json({ ok: false, error: 'Token inválido' });
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true, service: 'service-print', version: require('../package.json').version });
  });

  /**
   * SIMULAÇÃO: devolve exatamente o que recebeu e registra no painel/console.
   * Use para conferir se a web está mandando o payload certo.
   */
  app.all('/echo', (req, res) => {
    const info = describeRequest(req);
    log(`Echo recebido (${req.method})`, 'ok', info);
    res.json({ ok: true, received: info, receivedAt: new Date().toISOString() });
  });

  /**
   * SIMULAÇÃO: dispara o mesmo fluxo do deep link sem precisar do protocolo registrado.
   * Body: { "url": "serviceprint://print/ABC123" }
   */
  app.post('/deeplink', async (req, res) => {
    const url = req.body && req.body.url;
    if (!url || !hooks.handleDeepLink) {
      return res.status(400).json({ ok: false, error: 'Informe { "url": "serviceprint://print/ID" }' });
    }
    log(`Simulando deep link via HTTP`, 'info', { url });
    try {
      const result = await hooks.handleDeepLink(url, { rethrow: true });
      res.json({ ok: true, ...result });
    } catch (err) {
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.get('/printers', async (_req, res) => {
    try {
      const printers = await dispatch.listPrinters(cfg);
      log(`${printers.length} impressora(s) encontrada(s)`, 'info', printers.map((p) => `${p.name} [${p.type}]`));
      res.json({ ok: true, printers });
    } catch (err) {
      log(`Erro ao listar impressoras: ${err.message}`, 'error');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Impressão RAW: bytes direto para a impressora (ZPL/PPLA/EPL/ESC-POS).
   * É o caminho para etiquetadoras (ZPL/PPLA/EPL) — o conteúdo NÃO passa pelo driver gráfico.
   * Body JSON: { data, encoding?, format?, printer? | host?+port? | device?, copies?, dryRun? }
   * Também aceita Content-Type text/plain com o conteúdo no body e os demais campos na query string.
   */
  app.post('/print/raw', async (req, res) => {
    const job = typeof req.body === 'string' ? { ...req.query, data: req.body } : { ...req.query, ...(req.body || {}) };
    log(`Payload recebido em /print/raw`, 'info', summarizeJob(job));
    if (!job.data) {
      log('Payload inválido: falta "data"', 'warn');
      return res.status(400).json({ ok: false, error: 'Informe "data" com os comandos da impressora' });
    }
    if (!job.printer && !job.host && !job.device && !job.bluetooth && !cfg.defaultPrinter) {
      return res.status(400).json({ ok: false, error: 'Informe o destino: "printer" (perfil ou fila), "host" (rede) ou "device" (serial)' });
    }
    if (job.dryRun) {
      const buf = raw.prepare(job);
      log(`dryRun=true, ${buf.length} bytes preparados, não enviado`, 'ok', { preview: buf.toString('latin1').slice(0, 500) });
      return res.json({ ok: true, dryRun: true, bytes: buf.length, preview: buf.toString('latin1').slice(0, 2000) });
    }
    try {
      const result = await dispatch.print({ ...job, type: 'raw' }, cfg);
      log(`RAW enviado para ${result.printer} (${result.bytes} bytes via ${result.via})`, 'ok');
      res.json({ ok: true, ...result });
    } catch (err) {
      log(`Falha RAW: ${err.message}`, 'error');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  /**
   * Etiquetas com layout (HTML em mm) em impressora de cupom ESC/POS.
   * Body: { printer?, largura_mm, altura_mm, dpi?, gap_mm?, etiquetas: [{ html, quantidade }], dryRun?, preview? }
   * dryRun=true → não imprime; devolve dimensões em pontos e PNG (base64) da primeira etiqueta rasterizada.
   */
  app.post('/print/label', async (req, res) => {
    const job = req.body || {};
    const resumo = { ...job, etiquetas: Array.isArray(job.etiquetas) ? `${job.etiquetas.length} etiqueta(s), ${job.etiquetas.reduce((a, e) => a + (Number(e && e.quantidade) || 1), 0)} cópia(s)` : job.etiquetas };
    log(`Payload recebido em /print/label`, 'info', resumo);
    if (!Array.isArray(job.etiquetas) || !job.etiquetas.length || !job.largura_mm || !job.altura_mm) {
      return res.status(400).json({ ok: false, error: 'Informe "largura_mm", "altura_mm" e "etiquetas": [{ html, quantidade }]' });
    }
    try {
      const result = await dispatch.printLabels(job, cfg);
      const { previewPng, ...semPng } = result;
      log(result.dryRun ? `dryRun: ${result.labels} etiqueta(s) ${result.widthDots}×${result.heightDots} dots, não enviado` : `Etiquetas impressas em ${result.printer} [${result.labels} un, ${result.widthDots}×${result.heightDots} dots, ${result.bytes} bytes]`, 'ok', semPng);
      res.json({ ok: true, ...result });
    } catch (err) {
      log(`Falha em /print/label: ${err.message}`, 'error');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/print/pdf', async (req, res) => {
    const job = req.body || {};
    const tamanho = typeof job.pdf === 'string' ? Math.round((job.pdf.length * 3) / 4) : 0;
    log(`Payload recebido em /print/pdf`, 'info', { ...job, pdf: tamanho ? `(PDF base64, ~${tamanho} bytes)` : job.pdf });
    if (!job.pdf) {
      return res.status(400).json({ ok: false, error: 'Informe "pdf" com o arquivo em base64' });
    }
    if (!job.printer && !cfg.defaultPrinter) {
      return res.status(400).json({ ok: false, error: 'Informe "printer" (perfil ou fila do sistema)' });
    }
    try {
      const result = await dispatch.printPdf(job, cfg);
      const { previewPng, ...semPng } = result;
      log(result.dryRun ? `dryRun: PDF ${result.pages ?? '?'} página(s), não enviado` : `PDF impresso em ${result.printer} [${result.type}${result.pages ? `, ${result.pages} pág` : ''}${result.bytes ? `, ${result.bytes} bytes` : ''}]`, 'ok', semPng);
      res.json({ ok: true, ...result });
    } catch (err) {
      log(`Falha em /print/pdf: ${err.message}`, 'error');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.post('/print', async (req, res) => {
    const job = req.body || {};
    log(`Payload recebido em /print`, 'info', summarizeJob(job));
    if (!job.html && !job.text && !job.data) {
      log('Payload inválido: falta "html", "text" ou "data"', 'warn');
      return res.status(400).json({ ok: false, error: 'Informe "html" ou "text" (ou "data" para RAW) no corpo da request' });
    }
    // dryRun: valida e registra, mas não manda para a impressora.
    if (job.dryRun) {
      log('dryRun=true, não enviado à impressora', 'ok');
      return res.json({ ok: true, dryRun: true, job: summarizeJob(job) });
    }
    const target = job.printer || cfg.defaultPrinter || '(padrão)';
    try {
      const result = await dispatch.print(job, cfg);
      log(`Impresso em ${result.printer} [${result.type}${result.bytes ? `, ${result.bytes} bytes` : ''}]`, 'ok');
      res.json({ ok: true, ...result });
    } catch (err) {
      log(`Falha ao imprimir em ${target}: ${err.message}`, 'error');
      res.status(500).json({ ok: false, error: err.message });
    }
  });

  app.use((req, res) => {
    log(`404 ${req.method} ${req.originalUrl}`, 'warn');
    res.status(404).json({ ok: false, error: 'Rota não encontrada' });
  });

  // Erros de parse (JSON inválido, body grande demais) e exceções não tratadas → sempre JSON.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    const status = err.status || err.statusCode || 500;
    const msg = err.type === 'entity.parse.failed' ? `JSON inválido: ${err.message}` : err.message;
    log(`${status} ${req.method} ${req.originalUrl}: ${msg}`, 'error');
    res.status(status).json({ ok: false, error: msg });
  });

  return new Promise((resolve, reject) => {
    const server = app.listen(cfg.port, cfg.host, () => {
      log(`Servidor ouvindo em http://${cfg.host}:${cfg.port}`, 'ok');
      // A web chama pelo nome (http://localhost:9100). O navegador pode resolver
      // "localhost" para ::1 antes de 127.0.0.1, então escutamos também no
      // loopback IPv6 (melhor esforço: sem IPv6 na máquina, só avisa no log).
      if (cfg.host === '127.0.0.1') {
        const v6 = app.listen(cfg.port, '::1', () => log(`Servidor ouvindo também em http://[::1]:${cfg.port}`, 'info'));
        v6.on('error', (err) => log(`Loopback IPv6 indisponível (${err.code || err.message}); seguindo só em IPv4`, 'warn'));
        const close = server.close.bind(server);
        server.close = (cb) => { v6.close(); return close(cb); };
      }
      resolve(server);
    });
    server.on('error', reject);
  });
}

module.exports = { start };
