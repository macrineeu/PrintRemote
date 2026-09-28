/*
 * Hook afterPack do electron-builder (ver electron-builder.yml).
 *
 * macOS: assina o .app AD-HOC (identidade "-") com o bundle id e os entitlements do projeto sempre que o
 * build sair sem Developer ID. Sem isso o electron-builder deixa o bundle sem assinatura nenhuma: o binário
 * do Electron fica só com a assinatura do linker, identificador "Electron", e o macOS não consegue associar
 * a permissão de Bluetooth (Privacidade e Segurança) ao app. Resultado: aberto pelo Finder, o helper
 * assets/mac/btprint falha ao conectar na impressora (erro 0xe00002bc); aberto pelo terminal, funciona,
 * porque aí quem "responde" pela permissão é o Terminal.
 *
 * Quando há Developer ID, o electron-builder assina de verdade logo depois deste hook e sobrescreve a
 * assinatura ad-hoc — este passo é inofensivo nesse caso.
 */
const path = require('path');
const { execFileSync } = require('child_process');

module.exports = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const { packager, appOutDir } = context;
  // Build universal: o electron-builder empacota x64 e arm64 em pastas "*-x64-temp"/"*-arm64-temp" e depois
  // funde as duas. Assinar esses intermediários faz a fusão falhar ("non-binary files ... identical SHAs"),
  // então só assinamos o resultado final (este hook roda de novo para ele).
  if (/-(x64|arm64)-temp$/.test(appOutDir)) return;
  const appPath = path.join(appOutDir, `${packager.appInfo.productFilename}.app`);
  const identifier = packager.appInfo.macBundleIdentifier || packager.appInfo.id;
  const macConfig = (packager.config && packager.config.mac) || {};
  const entitlements = path.resolve(packager.projectDir, macConfig.entitlements || 'build/entitlements.mac.plist');

  const args = ['--force', '--deep', '--sign', '-', '--identifier', identifier, '--entitlements', entitlements, appPath];
  try {
    execFileSync('codesign', args, { stdio: ['ignore', 'ignore', 'pipe'] });
    execFileSync('codesign', ['--verify', '--deep', '--strict', appPath], { stdio: ['ignore', 'ignore', 'pipe'] });
    console.log(`  • afterPack: ${path.basename(appPath)} assinado ad-hoc como ${identifier} (entitlements: ${path.relative(packager.projectDir, entitlements)})`);
  } catch (err) {
    const msg = (err.stderr && err.stderr.toString().trim()) || err.message;
    throw new Error(`afterPack: falha ao assinar ad-hoc ${appPath}: ${msg}`);
  }
};
