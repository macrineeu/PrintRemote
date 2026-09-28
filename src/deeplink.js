const dispatch = require('./dispatch');

const SCHEME = 'serviceprint';

/**
 * Faz o parse de uma URL serviceprint://...
 * Formatos aceitos:
 *   serviceprint://print/ABC123
 *   serviceprint://print/ABC123?printer=Nome
 *   serviceprint://print?text=Ola%20mundo&printer=Nome
 *   serviceprint://print?html=%3Cb%3EOi%3C%2Fb%3E
 *   serviceprint://print?data=%5EXA...%5EXZ&format=zpl&printer=Zebra   (RAW)
 *
 * O job vindo da API pode ser HTML/texto ({ html | text }) ou RAW ({ data, format, printer | host | device }).
 */
function parse(rawUrl) {
  const url = new URL(rawUrl);
  if (url.protocol !== `${SCHEME}:`) throw new Error(`Protocolo inesperado: ${url.protocol}`);
  const action = url.hostname; // "print"
  const id = decodeURIComponent(url.pathname.replace(/^\/+/, '')) || null;
  const params = Object.fromEntries(url.searchParams.entries());
  return { action, id, params };
}

/**
 * Busca o job na API configurada. `cfg.jobsUrl` deve conter "{id}".
 * A API deve devolver JSON no mesmo formato do POST /print
 * ({ printer, text | html, copies, pageSize, ... }).
 */
async function fetchJob(id, cfg) {
  if (!cfg.jobsUrl) {
    throw new Error('Defina "jobsUrl" no config.json (ex: https://sua-api.com/prints/{id}) para buscar jobs por ID');
  }
  const url = cfg.jobsUrl.replace('{id}', encodeURIComponent(id));
  const headers = { Accept: 'application/json' };
  if (cfg.jobsToken) headers.Authorization = `Bearer ${cfg.jobsToken}`;

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`API respondeu ${res.status} ao buscar job ${id}`);
  return res.json();
}

/**
 * Trata uma URL recebida do SO e imprime.
 */
async function handle(rawUrl, cfg, log) {
  const { action, id, params } = parse(rawUrl);
  log(`Deep link recebido: ${rawUrl}`, 'info', { action, id, params });
  if (action !== 'print') throw new Error(`Ação desconhecida: "${action}"`);

  let job;
  if (id) {
    job = await fetchJob(id, cfg);
    log(`Job ${id} obtido da API`, 'info', job);
  } else if (params.text || params.html || params.data) {
    job = { text: params.text, html: params.html, data: params.data, format: params.format, encoding: params.encoding };
  } else {
    throw new Error('Informe um ID (serviceprint://print/ID) ou ?text=/?html=/?data=');
  }

  // Parâmetros da URL sobrescrevem o que veio da API.
  for (const k of ['printer', 'host', 'port', 'device', 'format']) if (params[k]) job[k] = params[k];
  if (params.copies) job.copies = Number(params.copies);

  const result = await dispatch.print(job, cfg);
  log(`Impresso em ${result.printer}${id ? ` (job ${id})` : ''}`, 'ok');
  return result;
}

/** Extrai a URL do protocolo de um argv (Windows/Linux). */
function findUrlInArgv(argv) {
  return argv.find((a) => typeof a === 'string' && a.startsWith(`${SCHEME}://`)) || null;
}

module.exports = { SCHEME, parse, handle, findUrlInArgv };
