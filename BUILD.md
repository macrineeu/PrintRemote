# Gerando o instalador (desenvolvedor)

Empacotamento com [electron-builder](https://www.electron.build). Toda a configuração fica em
`electron-builder.yml`; **assinatura e notarização ficam em `build/signing.env`** (não versionado).

```
build/
  icon.svg / icon.png       ícone (1024px; .icns e .ico são gerados no build)
  entitlements.mac*.plist   Hardened Runtime (JIT, Bluetooth, rede, impressão)
  license.txt, license_pt.txt   licença mostrada no assistente (Windows e .pkg)
  installer.nsh             texto das telas e limpeza no desinstalador (Windows)
  pkg/welcome.html, conclusion.html   telas do assistente .pkg (macOS)
  signing.env.example       modelo de configuração de assinatura → copie para signing.env
scripts/build.js            carrega signing.env, resume o que vai assinar e chama o electron-builder
```

## Requisitos

- Node 20+ e `npm install`.
- **macOS**: gerar em um Mac. Xcode Command Line Tools (`xcode-select --install`). Para o `.pkg` assinado, os
  certificados *Developer ID Application* **e** *Developer ID Installer* no Keychain.
- **Windows**: gerar em Windows, ou em macOS/Linux com [Wine](https://www.electron.build/multi-platform-build)
  (só a assinatura por token USB/HSM exige Windows de verdade).
- **Linux**: qualquer plataforma.

## Comandos

| Comando | Gera |
|---|---|
| `npm run build:mac` | `dist/Service Print-<v>-mac-universal.dmg` e `.pkg` (Apple Silicon + Intel) |
| `npm run build:win` | `dist/Service Print-Setup-<v>-x64.exe` (NSIS assistido) |
| `npm run build:linux` | `dist/Service Print-<v>-linux-x64.AppImage` |
| `npm run build:mac:dir` | só `dist/mac-universal/Service Print.app`, sem assinar. Para testar rápido |
| `npm run build:unsigned -- --mac` | ignora `signing.env` e a identidade do Keychain |
| `npm run icon` | regera `build/icon.png` a partir de `build/icon.svg` (macOS, usa `qlmanage`) |

Argumentos extras vão direto ao electron-builder: `npm run build:mac -- --arm64` gera só Apple Silicon (mais rápido
para testar).

O script imprime no início o que vai fazer:

```
[build] build/signing.env carregado (4 variáveis: CSC_NAME, APPLE_ID, APPLE_APP_SPECIFIC_PASSWORD, APPLE_TEAM_ID)
[build] Assinatura macOS : sim, identidade "Developer ID Application: Macrineu Tecnologia (ABCDE12345)"
[build] Notarização Apple: sim, Apple ID fulano@macrineutecnologia.io (team ABCDE12345)
[build] Assinatura Win   : não (sem certificado)
```

## Assinatura: `build/signing.env`

```bash
cp build/signing.env.example build/signing.env
```

Preencha só o que for usar; vazio = não assina. Variáveis já presentes no ambiente (CI) têm prioridade
sobre o arquivo. O arquivo está no `.gitignore`, assim como `*.p12`, `*.pfx` e `*.p8`.

### macOS: assinar + notarizar

Sem isso o macOS mostra "desenvolvedor não identificado" e, em versões recentes, só libera em *Privacidade e Segurança*.

1. Conta Apple Developer (US$ 99/ano). Em [developer.apple.com/account/resources/certificates](https://developer.apple.com/account/resources/certificates/list)
   crie **Developer ID Application** e **Developer ID Installer**, instale ambos no Keychain
   (ou pelo Xcode → Settings → Accounts → Manage Certificates).
2. Confira o nome: `security find-identity -v -p codesigning`.
3. Em `signing.env`:
   ```
   CSC_NAME=Developer ID Application: Macrineu Tecnologia LTDA (ABCDE12345)
   APPLE_ID=conta@macrineutecnologia.io
   APPLE_APP_SPECIFIC_PASSWORD=xxxx-xxxx-xxxx-xxxx   # appleid.apple.com → App-Specific Passwords
   APPLE_TEAM_ID=ABCDE12345
   ```
   Em CI, prefira exportar o certificado (`CSC_LINK` + `CSC_KEY_PASSWORD`, arquivo .p12 ou base64) e a chave da
   App Store Connect API (`APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`).
4. `npm run build:mac`. A notarização leva de 1 a 15 minutos; o electron-builder já grampeia (staple) o ticket.
5. Verificar:
   ```bash
   codesign -dv --verbose=2 "dist/mac-universal/Service Print.app"
   spctl -a -vv -t install "dist/Service Print-1.0.0-mac-universal.pkg"   # deve dizer "accepted ... Notarized Developer ID"
   xcrun stapler validate "dist/Service Print-1.0.0-mac-universal.dmg"
   ```

O helper Bluetooth `assets/mac/btprint` é assinado junto (`mac.binaries`), com os mesmos entitlements. Se
recompilar o helper (`native/README.md`), não precisa assinar à mão.

### macOS sem Developer ID: assinatura ad-hoc automática

Sem identidade no Keychain (ou com `--unsigned`) o electron-builder pula a assinatura e o `.app` sairia sem
nenhuma: o executável fica só com a assinatura do linker, identificador "Electron". O macOS não consegue
associar a permissão de **Bluetooth** (Ajustes > Privacidade e Segurança) a esse bundle e o helper `btprint`
falha ao conectar na impressora (erro `0xe00002bc`) sempre que o app é aberto pelo Finder/Launchpad — pelo
terminal funciona, porque aí o responsável pela permissão é o Terminal.

Por isso `scripts/afterPack.js` (hook `afterPack` do `electron-builder.yml`) assina o `.app` **ad-hoc**
(`codesign --sign -`) com o bundle id `io.macrineutecnologia.serviceprint` e os entitlements do projeto. Com
Developer ID configurado, o electron-builder assina de verdade logo depois e sobrescreve o ad-hoc. Para
conferir: `codesign -dv "dist/mac-universal/Service Print.app"` deve mostrar `Identifier=io.macrineutecnologia.serviceprint`.

Se a impressão Bluetooth falhar só no app instalado, confira se "Service Print" está marcado em
Ajustes > Privacidade e Segurança > Bluetooth; para forçar o macOS a perguntar de novo:
`tccutil reset BluetoothAlways io.macrineutecnologia.serviceprint`.

### Windows: Authenticode

Sem assinatura o SmartScreen mostra "O Windows protegeu o PC" até o instalador ganhar reputação. Certificado **EV**
pula essa fase; **OV** ganha reputação com o tempo.

- **Arquivo .pfx** (OV, ou EV exportável):
  ```
  WIN_CSC_LINK=C:\certs\macrineutecnologia.pfx     # ou file://, https://, ou base64
  WIN_CSC_KEY_PASSWORD=senha
  WIN_PUBLISHER_NAME=Macrineu Tecnologia LTDA       # CN exato do certificado
  ```
- **Token USB / HSM / Windows Certificate Store** (EV): instale o certificado no Windows e informe
  `WIN_CERT_SUBJECT_NAME=Macrineu Tecnologia LTDA` **ou** `WIN_CERT_SHA1=<thumbprint>`. Precisa gerar no Windows.
- **Azure Trusted Signing**: `AZURE_SIGN_ENDPOINT`, `AZURE_SIGN_ACCOUNT`, `AZURE_SIGN_PROFILE` + `az login`.

Timestamp padrão é o da DigiCert; troque com `WIN_TIMESTAMP_SERVER`. Verificar: botão direito no `.exe` →
*Propriedades → Assinaturas Digitais*, ou `signtool verify /pa /v "Service Print-Setup-1.0.0-x64.exe"`.

## O que o instalador faz

**Windows (NSIS assistido)**: Bem-vindo → Licença → *Só para mim / Todos os usuários* → Pasta → Instalar →
Concluir (com "Executar"). Cria atalhos na Área de Trabalho e no Menu Iniciar, registra em *Programas e
Recursos*. O desinstalador remove também a chave *Run* (iniciar com o Windows) e o protocolo
`serviceprint://` (`build/installer.nsh`); `%APPDATA%\Service Print` é mantido.

**macOS (.pkg)**: Introdução (texto em `build/pkg/welcome.html`) → Licença → Instalar em `/Applications` →
Resumo (`conclusion.html`). O `.dmg` é a alternativa "arrastar para Aplicativos". `Info.plist` recebe
`NSBluetoothAlwaysUsageDescription` e `NSLocalNetworkUsageDescription` (obrigatórios para o pedido de permissão).

**Em todos**: na primeira execução instalada o app registra `serviceprint://` e, se `startAtLogin` não for
`false` no `config.json`, o item de inicialização (`app.setLoginItemSettings`, abre oculto).

## Versão e publicação

Versão vem do `package.json` (`npm version patch|minor|major`). Os artefatos saem em `dist/` com o nome
`Service Print-<versão>-<os>-<arch>.<ext>`. Não há auto-update configurado; para isso, adicionar `publish`
no `electron-builder.yml` e `electron-updater` no app.
