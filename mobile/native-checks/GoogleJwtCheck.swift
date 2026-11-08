import Foundation

// Run by scripts/build-ios.sh on macOS with a fresh PKCS#8 key and OpenSSL's RS256 signature of the same input.
// Usage: check-google-jwt <private-key.pem> <signing input> <expected base64url signature>
@main
struct GoogleJwtCheck {
  static func main() throws {
    let arguments = CommandLine.arguments
    precondition(arguments.count == 4, "usage: check-google-jwt <pem> <input> <expected>")
    let pem = try String(contentsOfFile: arguments[1], encoding: .utf8)
    // RSASSA-PKCS1-v1_5 is deterministic, so the native signer must match OpenSSL byte for byte.
    let signature = try GoogleJwt.sign(privateKey: pem, input: arguments[2])
    precondition(signature == arguments[3], "signature differs from OpenSSL")
    precondition((try? GoogleJwt.sign(privateKey: "-----BEGIN PRIVATE KEY-----\nnot a key\n-----END PRIVATE KEY-----", input: "x")) == nil)
    print("Google JWT signing checks passed.")
  }
}
