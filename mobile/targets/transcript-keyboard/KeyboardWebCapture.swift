// Adapted from Hex's iOS keyboard (https://github.com/anomalyco/hex, MIT), ios/HEXKeyboard/KeyboardWebCapture.swift.
// See Typing/NOTICE.md. Shuddhalekhan keeps the default microphone only: no input choice, voice isolation or timing.

import AVFAudio
import Foundation
import UIKit
import WebKit

/// 16-bit mono PCM chunks from the page, written as a WAV file.
@MainActor
final class KeyboardPCMFile {
  let url: URL
  private var file: AVAudioFile?
  private let format: AVAudioFormat
  private(set) var frames: AVAudioFramePosition = 0

  init(url: URL, sampleRate: Double) throws {
    self.url = url
    guard let format = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: sampleRate, channels: 1, interleaved: true) else {
      throw CocoaError(.featureUnsupported)
    }
    self.format = format
    file = try AVAudioFile(forWriting: url, settings: format.settings, commonFormat: .pcmFormatInt16, interleaved: true)
  }

  var seconds: Double { Double(frames) / format.sampleRate }

  /// Throws when the write fails (out of storage); `frames` counts only what was written.
  func append(_ data: Data) throws {
    let count = data.count / 2
    guard count > 0, let file,
          let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count)) else { return }
    buffer.frameLength = AVAudioFrameCount(count)
    data.withUnsafeBytes { raw in
      guard let base = raw.baseAddress, let target = buffer.int16ChannelData?[0] else { return }
      memcpy(target, base, count * 2)
    }
    try file.write(from: buffer)
    frames += AVAudioFramePosition(count)
  }

  /// Closing flushes the WAV header; the file is complete once this returns.
  func close() { file = nil }
}

/// A keyboard can't use AVAudioEngine's microphone, but since iOS 26 a web view in it can call getUserMedia
/// with Full Access. A 2×2, nearly transparent web view records and posts 16-bit PCM back over a message handler.
@MainActor
final class KeyboardWebCapture: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
  enum Event {
    /// The page was asked to open the microphone: from here a permission prompt may be up.
    case asked
    case started(sampleRate: Double)
    case samples(Data, peak: Float)
    case stopped
    case failed(String)
    /// The microphone stayed unavailable for 15 s (Hex's wait for an interruption to end).
    case interrupted
    /// Its content process ended, or its page didn't load or stopped answering: the web view is done.
    case processTerminated
  }

  var onEvent: ((Event) -> Void)?
  private let webView: WKWebView
  private var isLoaded = false
  private var startWhenLoaded = false
  /// Which start the page's messages belong to: a cancelled capture's late messages never reach the next one.
  private var run = 0

  init(host: UIView) {
    let configuration = WKWebViewConfiguration()
    configuration.allowsInlineMediaPlayback = true
    configuration.mediaTypesRequiringUserActionForPlayback = []
    webView = WKWebView(frame: CGRect(x: 0, y: 0, width: 2, height: 2), configuration: configuration)
    super.init()
    configuration.userContentController.add(WeakMessageHandler(self), name: "capture")
    webView.navigationDelegate = self
    webView.uiDelegate = self
    webView.isUserInteractionEnabled = false
    webView.alpha = 0.02
    webView.accessibilityElementsHidden = true
    host.addSubview(webView)
    webView.loadHTMLString(Self.page, baseURL: URL(string: "https://keyboard.shuddhalekhan.local/"))
  }

  func attach(to host: UIView) {
    if webView.superview !== host { host.addSubview(webView) }
  }

  func start() {
    run += 1
    guard isLoaded else {
      startWhenLoaded = true
      return
    }
    ask()
  }

  /// `.asked` once the page has run it: a content process that stalls first leaves the deadline to hand over.
  private func ask() {
    let asked = run
    send("captureStart(\(run))") { [weak self] in
      if let self, self.run == asked { self.onEvent?(.asked) }
    }
  }

  /// `flush`: keep the end of what was said (a cancel keeps nothing, so lets the microphone go at once).
  func stop(flush: Bool = true) {
    startWhenLoaded = false
    // A cancel's queued messages (a late start, audio, an error) never reach a quick retry.
    if !flush { run += 1 }
    // Before the page loads nothing has started, and its function isn't defined yet.
    guard isLoaded else { return }
    send("captureStop(\(flush))")
  }

  /// `0`: the functions are async, and WebKit can't return their promise (nor, in some releases, `undefined`).
  private func send(_ script: String, then done: (@MainActor @Sendable () -> Void)? = nil) {
    webView.evaluateJavaScript(script + "; 0") { [weak self] _, error in
      if error != nil { self?.onEvent?(.processTerminated) } else { done?() }
    }
  }

  /// After its content process ended, so it never stays behind next to the one the next dictation makes.
  func tearDown() {
    onEvent = nil
    startWhenLoaded = false
    webView.stopLoading()
    webView.setMicrophoneCaptureState(.none)
    webView.navigationDelegate = nil
    webView.uiDelegate = nil
    webView.configuration.userContentController.removeScriptMessageHandler(forName: "capture")
    webView.removeFromSuperview()
  }

  func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
    isLoaded = true
    if startWhenLoaded {
      startWhenLoaded = false
      ask()
    }
  }

  func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
    loadFailed()
  }

  func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
    loadFailed()
  }

  private func loadFailed() {
    startWhenLoaded = false
    onEvent?(.processTerminated)
  }

  func webView(
    _ webView: WKWebView,
    requestMediaCapturePermissionFor origin: WKSecurityOrigin,
    initiatedByFrame frame: WKFrameInfo,
    type: WKMediaCaptureType,
    decisionHandler: @escaping @MainActor (WKPermissionDecision) -> Void
  ) {
    decisionHandler(type == .microphone ? .grant : .deny)
  }

  func webViewWebContentProcessDidTerminate(_ webView: WKWebView) {
    isLoaded = false
    onEvent?(.processTerminated)
  }

  func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
    guard let body = message.body as? [String: Any], let type = body["type"] as? String,
          (body["run"] as? Int) == run else { return }
    switch type {
    case "started":
      onEvent?(.started(sampleRate: (body["rate"] as? Double) ?? 48_000))
    case "pcm":
      guard let encoded = body["data"] as? String, let data = Data(base64Encoded: encoded) else { return }
      onEvent?(.samples(data, peak: Float((body["peak"] as? Double) ?? 0)))
    case "stopped":
      onEvent?(.stopped)
    case "error":
      onEvent?(.failed((body["message"] as? String) ?? "unknown"))
    case "interrupted":
      onEvent?(.interrupted)
    default:
      break
    }
  }

  private static let page = """
  <!doctype html><meta charset="utf-8"><script>
  let ctx, stream, source, node, running = false, generation = 0, revive = null, run = 0;
  // A stop waiting for the buffer the processor still holds (`captureStop`), and its end, which a new start waits for.
  let flushed = null, stopping = null;
  // For opening the microphone again (`heal`): when the track went muted, the next try and its back-off.
  let mutedAt = 0, reopening = false, nextReopen = 0, backoff = 1000, heard = false, downSince = 0;
  const post = (m) => webkit.messageHandlers.capture.postMessage({ ...m, run });
  const release = (s, c) => {
    if (s) s.getTracks().forEach((t) => t.stop());
    if (c) c.close().catch(() => {});
  };
  const constraints = { audio: { channelCount: 1, echoCancellation: false, noiseSuppression: false, autoGainControl: false } };
  const track = () => stream && stream.getAudioTracks()[0];
  function listen(t) {
    t.onmute = () => { if (t === track()) mutedAt = Date.now(); };
  }
  // iOS gives the audio session to other sounds (a notification, an alarm, a call): WebKit interrupts or suspends
  // the context and mutes the track, may end it, and may leave either so once the sound is over. Every 250 ms:
  // resume a context that isn't running, then open the microphone again for a track that ended or stayed muted
  // 3 s, trying again after 1, 2, 4, then every 8 s. The same dictation carries on.
  function heal() {
    if (!running || !ctx) return;
    const t0 = track();
    if (ctx.state === "running" && t0 && t0.readyState !== "ended" && !t0.muted) downSince = 0;
    else if (!downSince) downSince = Date.now();
    else if (Date.now() - downSince > 15000) {
      downSince = 0;
      return post({ type: "interrupted" });
    }
    if (ctx.state !== "running") {
      if (ctx.state !== "closed") ctx.resume().catch(() => {});
      return;
    }
    const t = track();
    const ended = !t || t.readyState === "ended";
    if (!ended && !(t.muted && Date.now() - mutedAt >= 3000)) return;
    if (reopening || Date.now() < nextReopen) return;
    reopen();
  }
  async function reopen() {
    reopening = true;
    const start = generation;
    try {
      const s = await navigator.mediaDevices.getUserMedia(constraints);
      if (start !== generation || !running) return release(s);
      let next;
      try {
        next = ctx.createMediaStreamSource(s);
        next.connect(node);
      } catch (error) {
        release(s);
        throw error;
      }
      const old = stream;
      try { source.disconnect(); } catch (e) {}
      stream = s;
      source = next;
      listen(track());
      mutedAt = Date.now();
      if (!track().muted) backoff = 1000;
      release(old);
    } catch (error) {
    } finally {
      if (start === generation) {
        reopening = false;
        nextReopen = Date.now() + backoff;
        backoff = Math.min(8000, backoff * 2);
      }
    }
  }
  async function captureStart(id) {
    // A stop sent while this start waits for the previous stop's end cancels it.
    const asked = generation;
    while (stopping) await stopping;
    if (running || asked !== generation) return;
    running = true;
    run = id;
    // A stop while this start waits makes it stale: it releases what it opened instead of going on.
    const start = ++generation;
    const stale = () => start !== generation;
    let s = null, c = null;
    try {
      s = await navigator.mediaDevices.getUserMedia(constraints);
      if (stale()) return release(s);
      // Shared at once, so a stop while the context resumes lets this microphone go too.
      stream = s;
      // 48 kHz whatever the route (a 96 kHz one would double what the transcription budget holds); WebKit resamples.
      c = ctx = new AudioContext({ sampleRate: 48000 });
      let timer;
      try {
        await Promise.race([c.resume(), new Promise((_, reject) =>
          timer = setTimeout(() => reject(new Error("The audio context didn't start.")), 3000))]);
      } finally {
        clearTimeout(timer);
      }
      if (stale()) return release(s, c);
      mutedAt = Date.now();
      heard = false;
      downSince = 0;
      listen(track());
      source = ctx.createMediaStreamSource(stream);
      node = ctx.createScriptProcessor(4096, 1, 1);
      node.onaudioprocess = (event) => {
        if (!running && !flushed) return;
        // Until audio flows, a muted track (a call holds the microphone) sends nothing: the first-audio wait hands over.
        if (!heard) { const t = track(); if (!t || t.muted) return; heard = true; }
        const input = event.inputBuffer.getChannelData(0);
        const pcm = new Int16Array(input.length);
        let peak = 0;
        for (let i = 0; i < input.length; i++) {
          const v = Math.max(-1, Math.min(1, input[i]));
          peak = Math.max(peak, Math.abs(v));
          pcm[i] = v < 0 ? v * 0x8000 : v * 0x7fff;
        }
        const bytes = new Uint8Array(pcm.buffer);
        let binary = "";
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
        post({ type: "pcm", data: btoa(binary), peak });
        if (flushed) flushed();
      };
      source.connect(node);
      node.connect(ctx.destination);
      revive = setInterval(heal, 250);
      post({ type: "started", rate: ctx.sampleRate });
    } catch (error) {
      release(s, c);
      if (stale()) return;
      running = false;
      if (revive) { clearInterval(revive); revive = null; }
      ctx = stream = source = node = null;
      post({ type: "error", message: (error && (error.name + ": " + error.message)) || String(error) });
    }
  }
  // The processor hands audio over 4,096 samples at a time (85 ms at 48 kHz), so at a stop it still holds the end
  // of what was said: the stop waits for that buffer (at most 250 ms) before it lets the microphone go.
  async function captureStop(flush) {
    generation++;
    const wasRunning = running;
    running = false;
    if (revive) { clearInterval(revive); revive = null; }
    if (flushed) flushed();
    let done = () => {};
    if (wasRunning) stopping = new Promise((resolve) => (done = resolve));
    if (flush && wasRunning && node && ctx && ctx.state === "running") {
      await new Promise((resolve) => {
        const timer = setTimeout(() => flushed && flushed(), 250);
        flushed = () => { clearTimeout(timer); flushed = null; resolve(); };
      });
    }
    // Taken before the close's wait, so a start that follows never loses what it opened to this stop.
    const s = stream, c = ctx, src = source, n = node;
    ctx = stream = source = node = null;
    reopening = false;
    nextReopen = 0;
    backoff = 1000;
    try { n && n.disconnect(); src && src.disconnect(); } catch (e) {}
    if (s) s.getTracks().forEach((t) => t.stop());
    if (c) { try { await c.close(); } catch (e) {} }
    if (wasRunning) post({ type: "stopped" });
    if (wasRunning) stopping = null;
    done();
  }
  </script>
  """
}

private final class WeakMessageHandler: NSObject, WKScriptMessageHandler {
  weak var target: WKScriptMessageHandler?

  init(_ target: WKScriptMessageHandler) {
    self.target = target
  }

  func userContentController(_ controller: WKUserContentController, didReceive message: WKScriptMessage) {
    target?.userContentController(controller, didReceive: message)
  }
}
