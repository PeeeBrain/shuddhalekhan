import AuthenticationServices
import CryptoKit
import ExpoModulesCore
import Network
import Security
import UIKit

private enum ChatGptAuthError: String, Error, LocalizedError {
  case unavailable = "ChatGPT sign-in could not start. Open the app and try again."
  case timeout = "ChatGPT sign-in timed out. Please try again."
  case invalidURL = "ChatGPT sign-in URL was invalid."
  case random = "Could not prepare secure ChatGPT sign-in."
  var errorDescription: String? { rawValue }
}

public final class ShuddhalekhanChatGptModule: Module {
  public func definition() -> ModuleDefinition {
    Name("ShuddhalekhanChatGpt")
    AsyncFunction("start") { () async throws -> String in try await ChatGptBrowser.shared.start() }
    AsyncFunction("open") { (url: String) async throws -> String? in try await ChatGptBrowser.shared.open(url) }
    AsyncFunction("cancel") { () async in await ChatGptBrowser.shared.cancel() }
    AsyncFunction("random") { () throws -> String in
      var bytes = [UInt8](repeating: 0, count: 32)
      guard SecRandomCopyBytes(kSecRandomDefault, bytes.count, &bytes) == errSecSuccess else { throw ChatGptAuthError.random }
      return Self.base64URL(Data(bytes))
    }
    AsyncFunction("challenge") { (verifier: String) -> String in
      Self.base64URL(Data(SHA256.hash(data: Data(verifier.utf8))))
    }
    AsyncFunction("hostId") { () -> String in UUID().uuidString.lowercased() }
    OnAppContextDestroys { Task { @MainActor in ChatGptBrowser.shared.cancel() } }
  }

  private static func base64URL(_ data: Data) -> String {
    data.base64EncodedString().replacingOccurrences(of: "+", with: "-")
      .replacingOccurrences(of: "/", with: "_").replacingOccurrences(of: "=", with: "")
  }
}

/// Main-queue Network callbacks and the browser session share one lifetime, including pre-browser startup.
@MainActor
private final class ChatGptBrowser: NSObject, ASWebAuthenticationPresentationContextProviding {
  static let shared = ChatGptBrowser()
  private var listener: NWListener?
  private var ready: CheckedContinuation<String, Error>?
  private var callback: CheckedContinuation<String?, Error>?
  private var session: ASWebAuthenticationSession?
  private var anchor: UIWindow?
  private var timeout: Task<Void, Never>?
  private var clients: [UUID: NWConnection] = [:]
  private var buffers: [UUID: Data] = [:]
  private var redirectUri: String?
  private var generation = UUID()

  func start() async throws -> String {
    cancel()
    let parameters = NWParameters.tcp
    parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
    let listener = try NWListener(using: parameters)
    self.listener = listener
    return try await withCheckedThrowingContinuation { continuation in
      ready = continuation
      listener.stateUpdateHandler = { [weak self, weak listener] state in
        MainActor.assumeIsolated {
          guard let self, let listener, self.listener === listener else { return }
          switch state {
          case .ready:
            guard let port = listener.port else { self.finish(.failure(ChatGptAuthError.unavailable)); return }
            let uri = "http://127.0.0.1:\(port.rawValue)/auth/callback"
            self.redirectUri = uri
            self.ready?.resume(returning: uri)
            self.ready = nil
          case .failed:
            self.finish(.failure(ChatGptAuthError.unavailable))
          default: break
          }
        }
      }
      listener.newConnectionHandler = { [weak self, weak listener] connection in
        MainActor.assumeIsolated {
          guard let self, let listener, self.listener === listener, self.clients.count < 4 else { connection.cancel(); return }
          let id = UUID()
          self.clients[id] = connection
          self.buffers[id] = Data()
          connection.start(queue: .main)
          self.receive(id)
          Task { @MainActor [weak self, weak connection] in
            do { try await Task.sleep(for: .seconds(5)) } catch { return }
            guard self?.clients[id] === connection else { return }
            self?.close(id)
          }
        }
      }
      listener.start(queue: .main)
      timeout = Task { @MainActor [weak self, weak listener] in
        do { try await Task.sleep(for: .seconds(300)) } catch { return }
        guard let self, let listener, self.listener === listener else { return }
        self.finish(.failure(ChatGptAuthError.timeout))
      }
    }
  }

  func open(_ value: String) async throws -> String? {
    guard let uri = redirectUri, listener != nil, callback == nil,
      let url = URL(string: value), let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
      parts.scheme == "https", parts.host == "auth.openai.com", parts.port == nil,
      parts.user == nil, parts.password == nil, parts.fragment == nil, parts.path == "/api/accounts/authorize",
      parts.queryItems?.filter({ $0.name == "redirect_uri" }).map(\.value) == [uri] else {
      cancel()
      throw ChatGptAuthError.invalidURL
    }
    anchor = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
      .filter { $0.activationState == .foregroundActive }.flatMap(\.windows).first { $0.isKeyWindow }
    guard anchor != nil else { cancel(); throw ChatGptAuthError.unavailable }
    return try await withCheckedThrowingContinuation { continuation in
      callback = continuation
      let generation = self.generation
      let session = ASWebAuthenticationSession(url: url, callbackURLScheme: "shuddhalekhan") { [weak self] url, error in
        Task { @MainActor in
          guard let self, self.generation == generation, self.callback != nil else { return }
          if let url { self.finish(.success(url.absoluteString)) }
          else if let error = error as? ASWebAuthenticationSessionError, error.code == .canceledLogin {
            self.finish(.success(nil))
          } else { self.finish(.failure(ChatGptAuthError.unavailable)) }
        }
      }
      self.session = session
      session.presentationContextProvider = self
      if !session.start() { finish(.failure(ChatGptAuthError.unavailable)) }
    }
  }

  func presentationAnchor(for session: ASWebAuthenticationSession) -> ASPresentationAnchor {
    // open() requires a foreground key window before creating the session.
    anchor ?? ASPresentationAnchor()
  }

  func cancel() { finish(.success(nil)) }

  private func finish(_ result: Result<String?, Error>) {
    generation = UUID()
    let pending = callback
    callback = nil
    let starting = ready
    ready = nil
    timeout?.cancel()
    timeout = nil
    listener?.stateUpdateHandler = nil
    listener?.newConnectionHandler = nil
    listener?.cancel()
    listener = nil
    redirectUri = nil
    let browser = session
    session = nil
    browser?.cancel()
    anchor = nil
    for connection in clients.values { connection.cancel() }
    clients.removeAll()
    buffers.removeAll()
    if let starting {
      if case .failure(let error) = result { starting.resume(throwing: error) }
      else { starting.resume(throwing: CancellationError()) }
    }
    pending?.resume(with: result)
  }

  private func close(_ id: UUID) {
    clients.removeValue(forKey: id)?.cancel()
    buffers[id] = nil
  }

  private func receive(_ id: UUID) {
    guard let connection = clients[id] else { return }
    connection.receive(minimumIncompleteLength: 1, maximumLength: 16_384) { [weak self] data, _, complete, error in
      MainActor.assumeIsolated {
        guard let self, self.clients[id] === connection else { return }
        if let data { self.buffers[id]?.append(data) }
        guard let buffer = self.buffers[id], buffer.count <= 16_384, error == nil else { self.close(id); return }
        if buffer.range(of: Data("\r\n\r\n".utf8)) != nil {
          self.reply(id, request: buffer)
        } else if complete { self.close(id) }
        else { self.receive(id) }
      }
    }
  }

  private func reply(_ id: UUID, request: Data) {
    guard let connection = clients[id], let text = String(data: request, encoding: .utf8),
      let line = text.components(separatedBy: "\r\n").first else { close(id); return }
    let fields = line.split(separator: " ")
    var response = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    if fields.count == 3, fields[0] == "GET", fields[2] == "HTTP/1.1",
      let target = URLComponents(string: String(fields[1])), target.scheme == nil, target.host == nil,
      target.path == "/auth/callback", target.fragment == nil, let query = target.percentEncodedQuery,
      !query.contains("\r"), !query.contains("\n") {
      response = "HTTP/1.1 302 Found\r\nLocation: shuddhalekhan://chatgpt-auth?\(query)\r\nCache-Control: no-store\r\nContent-Length: 0\r\nConnection: close\r\n\r\n"
    }
    connection.send(content: Data(response.utf8), completion: .contentProcessed { [weak self] _ in
      MainActor.assumeIsolated { self?.close(id) }
    })
  }
}
