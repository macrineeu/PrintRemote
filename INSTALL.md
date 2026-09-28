# Instalação do Service Print (usuário final)

O Service Print é o serviço local de impressão para aplicações web. Ele fica rodando em segundo plano
(ícone de impressora ao lado do relógio) e recebe os pedidos de impressão do sistema web pela
porta `9100`, **só neste computador**. Sem ele, o sistema volta a gerar PDF para você imprimir à mão.

Baixe o instalador da sua plataforma e siga o passo a passo.

| Sistema | Arquivo |
|---|---|
| Windows 10/11 (64 bits) | `Service Print-Setup-<versão>-x64.exe` |
| macOS 11+ (Apple Silicon ou Intel, o mesmo arquivo) | `Service Print-<versão>-mac-universal.pkg` (assistente) ou `.dmg` |
| Linux | `Service Print-<versão>-linux-x64.AppImage` |

---

## Windows

1. Feche o navegador e, se já tiver o Service Print aberto, saia dele (botão direito no ícone da bandeja → **Sair**).
2. Dê dois cliques em `Service Print-Setup-<versão>-x64.exe`.
3. Se aparecer **"O Windows protegeu o PC"** (tela azul do SmartScreen), clique em **Mais informações** →
   **Executar assim mesmo**. Isso acontece quando o instalador ainda não é assinado ou o certificado é novo.
4. Siga o assistente:
   1. **Bem-vindo** → Avançar.
   2. **Licença** → Eu aceito → Avançar.
   3. **Modo de instalação** → *Somente para mim* (recomendado; não precisa de administrador) ou
      *Para todos os usuários* (pede senha de administrador).
   4. **Pasta de destino** → deixe a sugerida → Avançar.
   5. **Instalar** → aguarde a barra.
   6. **Concluir** → deixe marcado *Executar Service Print*.
5. O ícone aparece na bandeja (talvez escondido atrás da setinha `^` ao lado do relógio). Clique nele para
   abrir o painel: deve mostrar **Serviço ativo em http://127.0.0.1:9100** e a lista de impressoras.
6. Escolha a impressora e clique em **Imprimir teste**.

O Service Print passa a **iniciar junto com o Windows**. Para desativar: botão direito no ícone da
bandeja → desmarque *Iniciar com o sistema*.

**Impressoras:**
- **USB / rede**: instale-a normalmente no Windows (ela precisa aparecer em *Impressoras e scanners*). Etiquetadoras
  Zebra/Argox/Elgin funcionam com qualquer driver, o serviço manda os comandos crus.
- **Bluetooth (cupom térmico)**: pareie a impressora em *Bluetooth e dispositivos*, depois em
  *Mais configurações de Bluetooth → Portas COM* anote a porta de **saída** (ex.: `COM5`). Passe essa porta
  para quem configura o `config.json` (painel → **Abrir config**).

**Desinstalar:** *Configurações → Aplicativos → Service Print → Desinstalar*. As configurações
(`%APPDATA%\Service Print\config.json`) são mantidas para uma reinstalação futura; apague a pasta se quiser limpar tudo.

---

## macOS

### Opção A: assistente `.pkg` (recomendado)

1. Dê dois cliques em `Service Print-<versão>-mac-universal.pkg`.
2. Se o macOS disser que **"não pode ser aberto porque é de um desenvolvedor não identificado"**:
   clique com o **botão direito** no `.pkg` → **Abrir** → **Abrir** de novo. Em macOS 15 (Sequoia) pode ser
   necessário ir em *Ajustes do Sistema → Privacidade e Segurança*, rolar até o fim e clicar **Abrir Mesmo Assim**.
   (Isso não acontece quando o instalador está assinado e notarizado, veja `BUILD.md`.)
3. Siga o assistente: **Introdução → Licença (Concordar) → Tipo de instalação → Instalar** (pede a senha do Mac) → **Resumo**.
4. Abra o **Service Print** pela pasta *Aplicativos* ou pelo Launchpad.
5. Na primeira abertura o macOS pode pedir permissão de **Bluetooth** e de **Rede local**. Clique em **Permitir**,
   senão as impressoras Bluetooth e de rede não funcionam.
6. O ícone aparece na barra superior. Abra o painel, confira **Serviço ativo em http://127.0.0.1:9100** e faça um
   **Imprimir teste**.

### Opção B: imagem `.dmg`

1. Abra o `.dmg` e arraste **Service Print** para a pasta **Aplicativos** que aparece ao lado.
2. Ejete o disco e abra o app pela pasta *Aplicativos*. Se aparecer o aviso de desenvolvedor não identificado,
   use botão direito → **Abrir** (só na primeira vez).
3. Siga os passos 5 e 6 acima.

O Service Print passa a **abrir junto com o login** (Ajustes do Sistema → Geral → Itens de Início). Para desativar,
use o menu do ícone na barra superior.

**Impressora Bluetooth (cupom térmico):** pareie em *Ajustes do Sistema → Bluetooth* (senha normalmente `0000`)
e informe o **endereço MAC** da impressora a quem configura o `config.json` (ele aparece em
*Bluetooth → ⓘ ao lado da impressora* ou em `system_profiler SPBluetoothDataType`). Detalhes em `README.md`.

**Desinstalar:** arraste *Service Print* de *Aplicativos* para o Lixo. Configurações ficam em
`~/Library/Application Support/Service Print/`.

---

## Linux

```bash
chmod +x "Service Print-<versão>-linux-x64.AppImage"
./"Service Print-<versão>-linux-x64.AppImage"
```

Se o AppImage não abrir, instale `libfuse2` (`sudo apt install libfuse2`). Para iniciar com a sessão, adicione o
AppImage aos programas de inicialização do seu ambiente (o serviço não faz isso sozinho no Linux).

Impressoras USB: crie a fila no CUPS com driver *Raw* ou *Generic*. Bluetooth SPP: `rfcomm bind` e use
`/dev/rfcomm0` como `device`.

---

## Depois de instalar: ligar à sua aplicação web

1. Sua aplicação detecta o serviço com `GET http://localhost:9100/health` e lista as impressoras em
   `GET /printers`. A partir daí ela envia os jobs para `POST /print`, `/print/raw`, `/print/label` ou `/print/pdf`.
2. Se a aplicação não detectar: confira no painel do Service Print se o serviço está ativo, e se a origem da
   aplicação está liberada em `allowedOrigins` no `config.json` (em produção deve ser o domínio dela, não `*`).
3. Perfis de impressora (`escpos`, `raw`, `system`), token e demais opções: `README.md`, seção *Configuração*.

## Problemas comuns

| Sintoma | O que fazer |
|---|---|
| Painel diz que a porta 9100 está em uso | Outra instância aberta, ou outro programa usa a 9100. Feche-o ou mude `port` no `config.json` (e na sua aplicação). |
| A aplicação não detecta o serviço | Serviço fechado, `allowedOrigins` sem o domínio da aplicação, ou antivírus/firewall bloqueando `127.0.0.1:9100`. |
| Impressora Bluetooth "imprime" e nada sai (macOS) | Use `bluetooth` (MAC) no perfil, não `/dev/cu.*`. Ver README. |
| Bluetooth: "não foi possível conectar (ACL)" ou "canal RFCOMM" erro `0xe00002bc`, com a impressora ligada (macOS) | Ligação anterior ficou presa. O serviço reconecta sozinho; se persistir, em *Ajustes → Bluetooth* clique **Desconectar** na impressora (ou desligue e ligue) e imprima de novo. |
| Etiqueta sai como texto `^XA^FO...` | O perfil está como `system`; troque para `raw`. |
| Nada acontece ao clicar em imprimir pelo link `serviceprint://` | Aceite o diálogo "Abrir Service Print?" do navegador e marque *sempre permitir*. |

Log detalhado: menu do ícone → **Abrir log** (`service-print.log`).
