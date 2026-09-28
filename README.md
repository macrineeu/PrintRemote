# Service Print

Serviço local de impressão em Electron, open source (MIT). Fica rodando na máquina (ícone no tray) e expõe
uma API HTTP que qualquer aplicação web chama para imprimir em impressoras do sistema operacional: cupom
térmico ESC/POS (USB, rede, serial ou Bluetooth), etiquetadoras ZPL/PPLA/EPL e impressoras comuns via driver.

## Rodar

```bash
npm install
npm start
```

Para **instalar** em uma máquina de cliente, use o instalador (`INSTALL.md`). Para **gerar** o instalador,
assinar e notarizar, veja `BUILD.md`.

Ao abrir, o painel mostra a URL do serviço (padrão `http://127.0.0.1:9100`), as impressoras
detectadas e um log. Fechar a janela só a esconde; o serviço continua no tray.

## Deep link `serviceprint://`

Além da API HTTP, a web pode disparar a impressão abrindo uma URL com protocolo customizado.
O SO acorda o app (ou entrega a URL ao app já aberto) e ele imprime.

```html
<a href="serviceprint://print/ABC123">Imprimir</a>
```
```js
window.location.href = 'serviceprint://print/ABC123';
```

Formatos aceitos:

| URL | Comportamento |
|---|---|
| `serviceprint://print/ABC123` | Busca o job em `jobsUrl` (trocando `{id}`) e imprime |
| `serviceprint://print/ABC123?printer=Nome&copies=2` | Idem, sobrescrevendo impressora/cópias |
| `serviceprint://print?text=Ola%20mundo` | Imprime o texto inline, sem API |
| `serviceprint://print?html=...` | Imprime HTML inline (URL-encoded) |

A API em `jobsUrl` deve responder JSON no mesmo formato do `POST /print`:

```json
{ "printer": "Epson TM-T20", "text": "Pedido #1234\nTotal R$ 35,00", "copies": 1 }
```

Se `jobsToken` estiver preenchido, o app envia `Authorization: Bearer <jobsToken>`.

Observações:
- Na primeira vez o navegador pede confirmação ("Abrir Service Print?"). O usuário pode marcar "sempre permitir".
- O deep link é fire-and-forget: a web não recebe resposta. Se precisar de status, use a API HTTP
  ou faça a sua API marcar o job como impresso quando o app buscá-lo.
- **macOS:** o protocolo só é registrado com o app empacotado (`npm run build:mac`). Em `npm start` não funciona.
- **Windows/Linux:** funciona também em dev (`npm start` registra apontando para o electron local).

## Perfis de impressora (`printers` no config.json)

Cada perfil diz **como** falar com a impressora. O nome do perfil é o que a web manda em `printer`.

```json
"defaultPrinter": "Cupom",
"printers": {
  "Cupom":   { "type": "escpos", "bluetooth": "AA:BB:CC:DD:EE:FF", "channel": 1, "columns": 32, "codepage": "cp1252", "feed": 4 },
  "Zebra":   { "type": "raw",    "host": "192.168.0.50", "port": 9100 },
  "HP":      { "type": "system", "queue": "HP_LaserJet" }
}
```

| `type` | Para | O que acontece com o job |
|---|---|---|
| `escpos` | bobina térmica (cupom), ex. Epson TM, Elgin i9, Tomate MTI-773 | `text` vira ESC/POS e sai cru; `data` sai cru como está |
| `raw` | etiquetadora ZPL/PPLA/EPL | `data` sai cru; `text` também vira ESC/POS |
| `system` | impressora comum (laser, jato de tinta) | `html`/`text` passam pelo driver gráfico do SO |

Destino (um por perfil): `bluetooth` (MAC da impressora, macOS), `device` (porta serial: `COM3` no Windows,
`/dev/ttyUSB0` no Linux), `host`+`port` (rede TCP) ou `queue` (fila do SO). Opções ESC/POS: `columns` (32 para 58 mm, 48 para 80 mm),
`codepage` (`cp1252`, `cp860`, `cp850`, `cp437`), `feed` (linhas ao final), `cut`, `cashDrawer`.

### Bluetooth no macOS: por que `bluetooth` (MAC) e não `/dev/cu.*`

Em macOS recentes a porta serial `/dev/cu.<nome>` criada para impressoras Bluetooth SPP **não estabelece a
conexão RFCOMM**: a escrita "funciona" e os bytes somem. O serviço então abre o canal RFCOMM direto pelo
endereço MAC com um helper nativo (`native/btprint.swift`, compilado em `assets/mac/btprint`, universal).
`channel` é o canal RFCOMM; o padrão 1 é o SPP dessas impressoras. Se a impressora responder ao status
ESC/POS, a resposta volta em `response` (ex: `0x12` = online).

Para recompilar o helper: veja o comando em `native/README.md`.

No **Windows** o pareamento cria uma porta `COMx` (Bluetooth → Mais opções → Portas COM) e ela funciona
normalmente: use `"device": "COM5"`.

### Notas de compatibilidade: Tomate MTI-773 (mini impressora 58 mm)

Mini impressora térmica 58 mm, ESC/POS, 203 dpi, 384 dots (32 colunas), Bluetooth e USB, sem guilhotina.
Senha de pareamento padrão `0000`, canal RFCOMM `1`. O que **não** funcionou nesta impressora:
- `/dev/cu.MTI-773` no macOS: porta morta (ver acima). Use `bluetooth` com o MAC.
- Canal RFCOMM 23 (o que o SDP anuncia como Serial Port, registro "WeChat"): aceita conexão, não imprime.
- USB no macOS: enumera como `MIAOBAO 58Printer` (0483:5840, classe printer) mas responde STALL a tudo,
  tanto no CUPS quanto via libusb. No Windows provavelmente precisa do driver do fabricante.
- Ela também anuncia BLE (serviço `18F0`, característica `2AF1` write), que é como o iPhone imprime.
  Não implementado; seria o caminho se o Bluetooth clássico falhar.

### Texto com formatação ESC/POS

No campo `text`, cada linha pode começar com tags:

| Tag | Efeito |
|---|---|
| `[C]` `[R]` `[L]` | centralizado, direita, esquerda |
| `[B]` | negrito |
| `[H]` `[W]` `[BIG]` | altura dupla, largura dupla, ambos |
| `[U]` | sublinhado |
| `[-]` | linha de traços na largura toda |
| `[CUT]` | corte (ignorado sem guilhotina) |
| `[BC:EAN13]7891000000017` | código de barras nativo. Tipos: EAN13, EAN8, CODE128, CODE39, UPCA, ITF. Opções `:h=80` altura, `:w=2` largura, `:hri=0` sem texto |
| `[QR]https://...` | QR code. Opções `:s=6` tamanho do módulo, `:ec=M` correção L/M/Q/H |

Exemplo de **etiqueta de produto** em impressora de cupom 58 mm:

```json
{ "text": "[C][B]Camiseta Básica\n[C]SKU: CAM-001\n[C][BC:EAN13:h=70]7891000000017\n[C][BIG]R$ 59,80" }
```

```json
{ "text": "[C][BIG]MINHA LOJA\n[-]\n2x Camiseta    R$ 59,80\n[R][B]TOTAL R$ 59,80" }
```

Linhas maiores que a largura quebram automaticamente. Para sobrescrever opções por job: `"escpos": { "codepage": "cp860" }`.

## Configuração

Arquivo `config.json` na pasta de dados do app (o caminho aparece no painel; há um botão para abrir).

```json
{
  "port": 9100,
  "host": "127.0.0.1",
  "token": "",
  "allowedOrigins": ["*"],
  "defaultPrinter": "",
  "jobsUrl": "https://sua-api.com/prints/{id}",
  "jobsToken": "",
  "startAtLogin": true
}
```

- `token`: se preenchido, toda request precisa do header `X-Print-Token`.
- `allowedOrigins`: lista de origens liberadas no CORS. Em produção troque `*` pelo domínio da sua web.
- `defaultPrinter`: perfil ou fila usada quando a request não informa `printer`.
- `printers`: perfis de impressora (ver seção acima).
- `jobsUrl`: endpoint da sua API que devolve o job para o deep link `serviceprint://print/{id}`.
- `jobsToken`: bearer token enviado ao buscar o job (opcional).
- `startAtLogin`: abrir o serviço junto com o login (só no app instalado; também no menu do tray).

Reinicie o app após alterar.

## API

| Método | Rota        | Descrição                         |
|--------|-------------|-----------------------------------|
| GET    | `/health`   | Verifica se o serviço está de pé  |
| GET    | `/printers` | Lista impressoras do sistema      |
| POST   | `/print`    | Envia um job HTML/texto (passa pelo driver gráfico) |
| POST   | `/print/raw` | **Etiquetadoras:** envia bytes crus (ZPL, PPLA, EPL, ESC/POS) direto para a impressora |
| POST   | `/print/label` | **Etiquetas com layout em impressora de cupom:** rasteriza HTML (mm) e imprime em modo gráfico ESC/POS |
| POST   | `/print/pdf` | **PDF pronto (ex.: DANFE NFC-e/NF-e, comprovantes):** cupom térmico recebe as páginas em bitmap ESC/POS; impressora comum recebe o arquivo |
| ANY    | `/echo`     | **Simulação:** devolve e registra tudo que recebeu (headers, query, body) |
| POST   | `/deeplink` | **Simulação:** executa o fluxo do `serviceprint://` sem o protocolo registrado |

### Simulando / depurando

Tudo que chega aparece no painel do app (aba "Console", com o payload expandível), no terminal
quando rodando com `npm start`, e no arquivo `service-print.log` na pasta de dados.

```js
// 1. Ver exatamente o que a web está enviando (não imprime nada)
await fetch('http://127.0.0.1:9100/echo', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ qualquer: 'coisa', pedido: 'ABC123' }),
}).then(r => r.json());
// → { ok: true, received: { method, path, origin, headers, query, body }, receivedAt }

// 2. Validar um job de impressão sem mandar para a impressora
await fetch('http://127.0.0.1:9100/print', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ text: 'teste', printer: 'X', dryRun: true }),
});

// 3. Simular o deep link (útil no macOS em dev, onde o protocolo não registra)
await fetch('http://127.0.0.1:9100/deeplink', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ url: 'serviceprint://print/ABC123' }),
});
```

Ou via terminal:

```bash
curl -X POST http://127.0.0.1:9100/echo -H 'Content-Type: application/json' -d '{"pedido":"ABC123"}'
curl -X POST http://127.0.0.1:9100/deeplink -H 'Content-Type: application/json' -d '{"url":"serviceprint://print?text=Ola"}'
```

### POST /print/raw — etiquetadoras (ZPL/PPLA/EPL)

Manda o conteúdo **sem passar pelo driver gráfico**. É o que impressoras de etiqueta precisam: se o ZPL
passar pelo driver do fabricante, ele vira imagem e a impressora imprime `^XA^FO...` como texto.

```json
{
  "data": "^XA^PW480^LL320^FO20,20^A0N,30,30^FDProduto^FS^PQ2^XZ",
  "format": "zpl",
  "printer": "Zebra_ZD220"
}
```

| Campo | Descrição |
|---|---|
| `data` | comandos da impressora (obrigatório) |
| `encoding` | `utf8` (padrão), `latin1` ou `base64` para conteúdo binário |
| `format` | `zpl`, `ppla`, `epl`, `escpos`. Para `zpl`/`ppla` o serviço remove linhas de cabeçalho iniciadas por `;` |
| `printer` | fila do sistema (nome de `GET /printers`). macOS/Linux: `lp -o raw`. Windows: winspool datatype RAW |
| `host` + `port` | impressora de rede via TCP (porta padrão 9100). Usa no lugar de `printer` |
| `device` | porta serial / Bluetooth SPP, ex `/dev/tty.XXX` ou `COM3`. Usa no lugar de `printer` |
| `copies` | repete o envio. ZPL/PPLA já trazem a quantidade (`^PQ` / `Q`), normalmente deixe 1 |
| `dryRun` | `true` prepara e mostra os bytes sem enviar |

Também aceita `Content-Type: text/plain` com os comandos no body e os demais campos na query:
`POST /print/raw?printer=Zebra&format=zpl`.

Um job enviado em `POST /print` contendo `data` (e sem `html`/`text`) é tratado como RAW.

### POST /print/label — etiqueta com layout em impressora de cupom

Para imprimir uma etiqueta desenhada em HTML (medidas em mm) numa impressora ESC/POS, que não entende ZPL nem
posicionamento em mm: o serviço rasteriza o HTML na largura da bobina e envia em modo gráfico.

```json
{
  "printer": "Cupom",
  "largura_mm": 40,
  "altura_mm": 25,
  "gap_mm": 2,
  "etiquetas": [
    { "html": "<div style=\"width:40mm;height:25mm\">Camiseta<br>R$ 59,80</div>", "quantidade": 2 }
  ]
}
```

| Campo | Descrição |
|---|---|
| `largura_mm`, `altura_mm` | tamanho da etiqueta (obrigatórios) |
| `etiquetas` | lista de `{ html, quantidade }` (obrigatório) |
| `dpi`, `gap_mm` | resolução (padrão 203) e espaço entre etiquetas |
| `dryRun` | `true` devolve dimensões em dots e o PNG da primeira etiqueta sem imprimir |

Qual endpoint usar depende do `type` do perfil escolhido:

| `type` da impressora | Conteúdo que a aplicação envia | Endpoint |
|---|---|---|
| `escpos` (cupom térmico) | etiqueta em HTML (mm) | `POST /print/label` (rasteriza) |
| `raw` (etiquetadora) | comandos ZPL / PPLA / EPL | `POST /print/raw` |
| `system` (impressora comum) | folha HTML + `pageSize` | `POST /print` |

Etiqueta mais larga que a bobina (ex.: modelo 60 mm numa bobina de 58 mm / 384 dots) é **reduzida inteira**: janela e
zoom encolhem juntos, e a resposta traz `"scaled": true`.

**Impressora USB no Windows:** instale a etiquetadora normalmente (qualquer driver, inclusive do fabricante)
e use o nome da fila em `printer`. Como o envio é RAW via winspool, o driver não rasteriza.
**Impressora USB no macOS/Linux:** crie a fila no CUPS com driver "Raw" ou "Generic". Impressora
Bluetooth pareada como porta serial: use `device`.

### POST /print/pdf — PDF pronto

```json
{ "pdf": "<arquivo em base64>", "printer": "Cupom", "copies": 1 }
```

| `type` da impressora | O que acontece |
|---|---|
| `escpos` | cada página é desenhada (pdf.js) na largura da bobina (384/576 dots) e sai em `GS v 0`; `gap_mm` entre páginas, `feed`/`cut` do perfil no fim |
| `system` | macOS/Linux: o arquivo vai para a fila do CUPS (`lp`), que converte o PDF. Windows: as páginas viram imagem e saem pelo driver no tamanho exato da página |
| `raw` | recusado: etiquetadora não imprime PDF |

`dryRun: true` prepara e devolve `pages`, `bytes` e `previewPng` (primeira página) sem enviar. O pdf.js roda no
build `legacy` (`src/pdf-render.html`) porque o build moderno usa APIs que o Chromium do Electron 33 não tem.

Caso de uso típico: a aplicação gera o documento fiscal (DANFE NFC-e) ou um comprovante como PDF de 58/80 mm,
baixa o arquivo e faz o `POST /print/pdf` sem abrir aba no navegador. Se o serviço não estiver de pé, a
aplicação pode cair no fluxo normal de abrir o PDF.

### POST /print

```json
{
  "printer": "Nome_Da_Impressora",
  "text": "Pedido #1234\nTotal: R$ 35,00",
  "copies": 1,
  "silent": true,
  "pageSize": { "width": 80000, "height": 200000 },
  "margins": { "marginType": "none" }
}
```

Envie `text` (texto puro) **ou** `html` (HTML completo). Os demais campos são opcionais.
`pageSize` aceita nomes (`"A4"`, `"Letter"`) ou `{ width, height }` em micrômetros
(80000 = 80 mm, útil para bobina térmica).

Resposta: `{ "ok": true, "printer": "Nome_Da_Impressora" }` ou `{ "ok": false, "error": "..." }`.

### Exemplo no browser

```js
await fetch('http://127.0.0.1:9100/print', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Print-Token': 'seu-token' },
  body: JSON.stringify({ printer: 'MinhaImpressora', text: 'Olá!' }),
});
```

Abra `test/client.html` no navegador para testar a comunicação web → serviço.

## Observações

- A web chama o serviço **pelo nome**, `http://localhost:9100`, não pelo IP. Página HTTPS chamando
  `http://localhost` funciona nos browsers modernos (localhost é contexto seguro), mas pode exigir liberação em
  políticas de rede corporativa. O serviço escuta em `127.0.0.1` e, quando disponível, também em `::1`, porque o
  navegador pode resolver `localhost` para qualquer um dos dois.
- Impressoras Bluetooth precisam estar pareadas e instaladas no SO para aparecer em `/printers`.
- Empacotar: `npm run build:mac` / `npm run build:win` / `npm run build:linux` (gera em `dist/`). Assinatura e
  notarização em `build/signing.env`; passo a passo em `BUILD.md`.
