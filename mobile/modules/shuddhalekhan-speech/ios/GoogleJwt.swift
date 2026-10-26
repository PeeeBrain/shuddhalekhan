import Foundation
import Security

enum GoogleJwt {
  private enum SigningError: Error { case invalidKey }

  static func sign(privateKey: String, input: String) throws -> String {
    guard privateKey.utf8.count <= 12_000, input.utf8.count <= 16_000,
          privateKey.hasPrefix("-----BEGIN PRIVATE KEY-----") else { throw SigningError.invalidKey }
    let encoded = privateKey
      .replacingOccurrences(of: "-----BEGIN PRIVATE KEY-----", with: "")
      .replacingOccurrences(of: "-----END PRIVATE KEY-----", with: "")
      .components(separatedBy: .whitespacesAndNewlines).joined()
    guard let der = Data(base64Encoded: encoded) else { throw SigningError.invalidKey }
    // Google exports PKCS#8; Security's RSA importer takes the inner PKCS#1 key.
    var outerOffset = 0
    let sequence = try readDER([UInt8](der), offset: &outerOffset, tag: 0x30)
    var offset = 0
    _ = try readDER(sequence, offset: &offset, tag: 0x02)
    _ = try readDER(sequence, offset: &offset, tag: 0x30)
    let keyBytes = try readDER(sequence, offset: &offset, tag: 0x04)
    guard let key = SecKeyCreateWithData(Data(keyBytes) as CFData, [
      kSecAttrKeyType: kSecAttrKeyTypeRSA,
      kSecAttrKeyClass: kSecAttrKeyClassPrivate,
    ] as CFDictionary, nil),
      let signature = SecKeyCreateSignature(key, .rsaSignatureMessagePKCS1v15SHA256,
        Data(input.utf8) as CFData, nil) as Data? else { throw SigningError.invalidKey }
    return signature.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }

  private static func readDER(_ bytes: [UInt8], offset: inout Int, tag: UInt8) throws -> [UInt8] {
    guard offset + 2 <= bytes.count, bytes[offset] == tag else { throw SigningError.invalidKey }
    offset += 1
    var length = Int(bytes[offset])
    offset += 1
    if length >= 128 {
      let count = length & 0x7f
      guard (1...4).contains(count), offset + count <= bytes.count else { throw SigningError.invalidKey }
      length = 0
      for _ in 0..<count { length = (length << 8) | Int(bytes[offset]); offset += 1 }
    }
    guard length <= bytes.count - offset else { throw SigningError.invalidKey }
    let content = Array(bytes[offset..<(offset + length)])
    offset += length
    return content
  }
}
