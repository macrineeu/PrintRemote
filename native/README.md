# Helpers nativos

## btprint (macOS)

Envia um arquivo cru para uma impressora Bluetooth clássica (SPP/RFCOMM) pelo endereço MAC.

```bash
swiftc -O -target arm64-apple-macos11  -o /tmp/btprint-arm64  native/btprint.swift
swiftc -O -target x86_64-apple-macos11 -o /tmp/btprint-x86_64 native/btprint.swift
lipo -create /tmp/btprint-arm64 /tmp/btprint-x86_64 -output assets/mac/btprint
chmod +x assets/mac/btprint
```

Uso direto: `assets/mac/btprint AA:BB:CC:DD:EE:FF arquivo.bin [canal|sdp]`.
O binário é embarcado fora do asar (`asarUnpack` no package.json).
