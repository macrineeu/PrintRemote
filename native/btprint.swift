// btprint — envia um arquivo cru para um dispositivo Bluetooth clássico (SPP/RFCOMM) pelo endereço MAC.
// Uso: btprint <MAC> <arquivo> [canal]
//   canal omitido/0 → usa 1 (padrão SPP dessas impressoras). "sdp" → descobre via SDP (UUID 0x1101).
//   Obs: na Tomate MTI-773 o SDP aponta para o canal 23 ("WeChat"), que NÃO imprime; o canal 1 imprime.
// Saída: linhas "info: ..." e, se a impressora responder, "resposta: 0x.. 0x..". Código 0 = sucesso.
// Por que existe: em macOS recentes a porta /dev/cu.<nome> criada para SPP não estabelece a conexão
// RFCOMM — a escrita "funciona" e os bytes somem. Abrir o canal direto via IOBluetooth funciona.
import IOBluetooth
import Foundation

func fail(_ msg: String, _ code: Int32) -> Never { FileHandle.standardError.write((msg + "\n").data(using: .utf8)!); exit(code) }

let args = CommandLine.arguments
guard args.count >= 3 else { fail("uso: btprint <MAC> <arquivo> [canal]", 2) }
let mac = args[1]
guard let data = FileManager.default.contents(atPath: args[2]) else { fail("arquivo não encontrado: \(args[2])", 2) }
let useSdp = args.count > 3 && args[3].lowercased() == "sdp"
var channelId: BluetoothRFCOMMChannelID = (args.count > 3 && !useSdp) ? (BluetoothRFCOMMChannelID(args[3]) ?? 1) : (useSdp ? 0 : 1)
guard let device = IOBluetoothDevice(addressString: mac) else { fail("MAC inválido: \(mac)", 2) }

let wasConnected = device.isConnected()
print("info: dispositivo \(device.name ?? "?") pareado=\(device.isPaired()) conectado=\(wasConnected)")
if !wasConnected {
    let r = device.openConnection()
    guard r == kIOReturnSuccess else { fail(String(format: "não foi possível conectar (ACL) ao %@: erro 0x%x — impressora ligada e ao alcance?", mac, r), 3) }
}

if channelId == 0 {
    _ = device.performSDPQuery(nil)
    Thread.sleep(forTimeInterval: 1.5)
    let spp = IOBluetoothSDPUUID(uuid16: 0x1101)
    if let rec = device.getServiceRecord(for: spp) {
        var ch: BluetoothRFCOMMChannelID = 0
        if rec.getRFCOMMChannelID(&ch) == kIOReturnSuccess { channelId = ch; print("info: serviço Serial Port no canal \(ch)") }
    }
    if channelId == 0 { channelId = 1; print("info: SPP não anunciado via SDP; usando canal 1") }
}

final class Delegate: NSObject, IOBluetoothRFCOMMChannelDelegate {
    func rfcommChannelData(_ ch: IOBluetoothRFCOMMChannel!, data p: UnsafeMutableRawPointer!, length: Int) {
        let d = Data(bytes: p, count: length)
        print("resposta: " + d.map { String(format: "0x%02x", $0) }.joined(separator: " "))
    }
}
let del = Delegate()
var channel: IOBluetoothRFCOMMChannel?
var r = device.openRFCOMMChannelSync(&channel, withChannelID: channelId, delegate: del)
if r != kIOReturnSuccess && wasConnected {
    // Conexão ACL "fantasma": o macOS diz que o dispositivo está conectado, mas o canal RFCOMM não abre
    // (erro 0xe00002bc). Acontece quando a ligação anterior não foi encerrada (helper morto por timeout,
    // impressora desligada e religada). Derrubar a ACL e reconectar resolve.
    print(String(format: "info: canal RFCOMM falhou na conexão existente (0x%x); reconectando", r))
    device.closeConnection()
    Thread.sleep(forTimeInterval: 1.0)
    let rc = device.openConnection()
    guard rc == kIOReturnSuccess else { fail(String(format: "não foi possível reconectar (ACL) ao %@: erro 0x%x — impressora ligada e ao alcance?", mac, rc), 3) }
    channel = nil
    r = device.openRFCOMMChannelSync(&channel, withChannelID: channelId, delegate: del)
}
guard r == kIOReturnSuccess, let ch = channel else { fail(String(format: "não foi possível abrir o canal RFCOMM %d: erro 0x%x — se a impressora aparece como conectada no Bluetooth do Mac, desconecte-a (ou desligue e ligue) e tente de novo", Int(channelId), r), 4) }

let mtu = max(Int(ch.getMTU()), 23)
var sent = 0
data.withUnsafeBytes { (buf: UnsafeRawBufferPointer) in
    while sent < data.count {
        let n = min(mtu, data.count - sent)
        let w = ch.writeSync(UnsafeMutableRawPointer(mutating: buf.baseAddress!.advanced(by: sent)), length: UInt16(n))
        if w != kIOReturnSuccess { fail(String(format: "falha ao escrever no canal após %d bytes: erro 0x%x", sent, w), 5) }
        sent += n
    }
}
print("info: enviados \(sent) bytes (canal \(channelId), MTU \(mtu))")
RunLoop.current.run(until: Date().addingTimeInterval(1.5))   // tempo para a impressora responder
ch.close()
device.closeConnection()
exit(0)
