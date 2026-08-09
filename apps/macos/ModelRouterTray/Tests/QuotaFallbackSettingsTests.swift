import XCTest
@testable import ModelRouterTray

/// `RouterError` is file-private to ModelRouterTrayApp.swift and unreachable
/// even via @testable import. The store's failure path never reads a caught
/// error's content (see setQuotaFallbackEnabled's catch block), only that a
/// throw occurred, so any Error stands in for it here.
private struct TestControlError: Error {
  let message: String
}

@MainActor
final class QuotaFallbackViewStateTests: XCTestCase {
  private func view(
    enabled: Bool,
    readiness: String,
    precedence: Bool = false
  ) -> QuotaFallbackViewState {
    QuotaFallbackViewState(snapshot: QuotaFallbackSnapshot(
      enabled: enabled,
      model: "kimi-api/kimi-k3",
      providerReady: readiness == "ready",
      readiness: readiness,
      readinessHint: nil,
      nativeRedirectPrecedence: precedence,
      lastOutcome: nil
    ))
  }

  func testSummaryMatrix() {
    XCTAssertEqual(QuotaFallbackViewState(snapshot: nil).summary, "Unavailable · update router")
    XCTAssertEqual(view(enabled: false, readiness: "ready").summary, "Off")
    XCTAssertEqual(view(enabled: true, readiness: "ready").summary, "Kimi K3 · ready")
    XCTAssertEqual(view(enabled: true, readiness: "credential-missing").summary, "Kimi K3 · needs API key")
    XCTAssertEqual(view(enabled: true, readiness: "provider-not-selected").summary, "Kimi K3 · provider disabled")
    XCTAssertEqual(view(enabled: true, readiness: "future-value").summary, "Kimi K3 · not ready")
    XCTAssertEqual(
      view(enabled: true, readiness: "ready", precedence: true).summary,
      "Paused · native redirect takes precedence"
    )
  }

  func testPrecedenceIsIgnoredWhileDisabled() {
    // Precedence only means something once fallback is actually on; a
    // configured redirect must not make an off toggle read as "Paused".
    XCTAssertEqual(view(enabled: false, readiness: "ready", precedence: true).summary, "Off")
  }

  func testAccessibilityValueMatchesSummary() {
    let state = view(enabled: true, readiness: "credential-missing")
    XCTAssertEqual(state.accessibilityValue, state.summary)
  }

  func testCanToggleOnRequiresProviderReadiness() {
    XCTAssertFalse(QuotaFallbackViewState(snapshot: nil).canToggleOn)
    XCTAssertFalse(view(enabled: false, readiness: "credential-missing").canToggleOn)
    XCTAssertTrue(view(enabled: false, readiness: "ready").canToggleOn)
  }

  func testCanToggleOffOnlyRequiresBeingEnabled() {
    // Readiness can regress after enabling (a credential can be removed);
    // turning fallback back off must never be blocked by that regression.
    XCTAssertTrue(view(enabled: true, readiness: "credential-missing").canToggleOff)
    XCTAssertFalse(view(enabled: false, readiness: "ready").canToggleOff)
  }

  func testSanitizedFailureMessageMapping() {
    XCTAssertEqual(
      QuotaFallbackViewState(snapshot: nil).sanitizedFailureMessage,
      "Update Codex Router before changing quota fallback."
    )
    XCTAssertEqual(
      view(enabled: true, readiness: "target-not-registered").sanitizedFailureMessage,
      "Update Codex Router before changing quota fallback."
    )
    XCTAssertEqual(
      view(enabled: true, readiness: "credential-missing").sanitizedFailureMessage,
      "Add the Kimi API key, then try again."
    )
    XCTAssertEqual(
      view(enabled: true, readiness: "provider-not-selected").sanitizedFailureMessage,
      "Enable the Kimi API provider, then try again."
    )
    XCTAssertEqual(
      view(enabled: true, readiness: "ready").sanitizedFailureMessage,
      "Could not update quota fallback. No credentials were changed."
    )
  }

  func testOlderProbeWithNoQuotaFallbackFieldDecodesSuccessfully() throws {
    let json = """
    {
      "subagents": {"mode": "all", "enabled": [], "disabled": [], "all": true},
      "picker": {"hidden": []}
    }
    """
    let settings = try JSONDecoder().decode(ModelSettingsSnapshot.self, from: Data(json.utf8))
    XCTAssertNil(settings.quotaFallback)
  }
}

// Not actor-isolated on purpose: it is read from the @Sendable
// ScriptedRunner/onCommand closures below, which run off the MainActor.
private let quotaFallbackProbeJSON = Data("""
{
  "targets": {
    "codex": {
      "target": "codex",
      "configured": true,
      "active": true,
      "enabledProviders": ["kimi-api"],
      "models": [],
      "modelSettings": {
        "subagents": {"mode": "all", "enabled": [], "disabled": [], "all": true},
        "picker": {"hidden": []},
        "quotaFallback": {
          "enabled": true,
          "model": "kimi-api/kimi-k3",
          "providerReady": true,
          "readiness": "ready",
          "readinessHint": null,
          "nativeRedirectPrecedence": false,
          "lastOutcome": null
        }
      }
    }
  }
}
""".utf8)

@MainActor
final class RouterStoreQuotaFallbackTests: XCTestCase {

  private final class ScriptedRunner: @unchecked Sendable {
    private let lock = NSLock()
    private var recordedArguments: [[String]] = []
    var onCommand: (@Sendable ([String], Data?) async throws -> Data)?

    func run(_ arguments: [String], _ stdin: Data?) async throws -> Data {
      lock.withLock { recordedArguments.append(arguments) }
      if let onCommand {
        return try await onCommand(arguments, stdin)
      }
      return quotaFallbackProbeJSON
    }

    var calls: [[String]] {
      lock.withLock { recordedArguments }
    }
  }

  func testEnablingIssuesTheExactSetCommand() async {
    let runner = ScriptedRunner()
    let store = RouterStore(controlRunnerOverride: { args, stdin in try await runner.run(args, stdin) })
    await store.setQuotaFallbackEnabled(true)
    XCTAssertEqual(runner.calls.first, ["quota-fallback", "set", "kimi-api/kimi-k3"])
  }

  func testDisablingIssuesTheExactOffCommand() async {
    let runner = ScriptedRunner()
    let store = RouterStore(controlRunnerOverride: { args, stdin in try await runner.run(args, stdin) })
    await store.setQuotaFallbackEnabled(false)
    XCTAssertEqual(runner.calls.first, ["quota-fallback", "off"])
  }

  func testARapidSecondToggleIssuesNoCommandWhileBusy() async {
    let runner = ScriptedRunner()
    let gate = AsyncGate()
    runner.onCommand = { args, _ in
      if args.first == "quota-fallback" { await gate.wait() }
      return quotaFallbackProbeJSON
    }
    let store = RouterStore(controlRunnerOverride: { args, stdin in try await runner.run(args, stdin) })

    let first = Task { await store.setQuotaFallbackEnabled(true) }
    await gate.waitUntilBlocked()
    // Issued while the first toggle is still busy inside the gate: this must
    // return immediately without recording a command of its own.
    await store.setQuotaFallbackEnabled(false)
    await gate.release()
    await first.value

    // Exactly the first toggle's mutation, then its post-success refresh --
    // never the second call's "off", and never a duplicate mutation.
    XCTAssertEqual(runner.calls, [["quota-fallback", "set", "kimi-api/kimi-k3"], ["--json"]])
  }

  func testSuccessRefreshesBeforeSettingTheSuccessMessage() async {
    let runner = ScriptedRunner()
    let store = RouterStore(controlRunnerOverride: { args, stdin in try await runner.run(args, stdin) })
    await store.setQuotaFallbackEnabled(true)

    // The mutation is followed by a real refresh call (the probe the success
    // message text is only written after), not an unconditional message.
    XCTAssertEqual(runner.calls, [["quota-fallback", "set", "kimi-api/kimi-k3"], ["--json"]])
    XCTAssertEqual(store.message, "Quota fallback enabled. ChatGPT remains primary.")
    XCTAssertEqual(store.quotaFallback?.enabled, true)
  }

  func testFailureRestoresThePriorStateThenRefreshes() async {
    let runner = ScriptedRunner()
    let store = RouterStore(controlRunnerOverride: { args, stdin in try await runner.run(args, stdin) })
    runner.onCommand = { args, _ in
      if args == ["quota-fallback", "set", "kimi-api/kimi-k3"] {
        throw TestControlError(message: "boom")
      }
      return quotaFallbackProbeJSON
    }

    await store.setQuotaFallbackEnabled(true)

    // Compensated back to off, then refreshed from the (off) router state.
    XCTAssertEqual(runner.calls, [
      ["quota-fallback", "set", "kimi-api/kimi-k3"],
      ["quota-fallback", "off"],
      ["--json"],
    ])
  }

  func testAFailureNeverLeaksTheRawErrorIntoTheMessage() async {
    let runner = ScriptedRunner()
    let store = RouterStore(controlRunnerOverride: { args, stdin in try await runner.run(args, stdin) })
    runner.onCommand = { args, _ in
      if args.first == "quota-fallback" {
        throw TestControlError(message: "upstream said SECRET_RAW_BODY: leaked detail")
      }
      return quotaFallbackProbeJSON
    }

    await store.setQuotaFallbackEnabled(true)

    XCTAssertNotNil(store.message)
    XCTAssertFalse(store.message?.contains("SECRET_RAW_BODY") ?? true)
  }
}

/// A minimal async rendezvous: lets a test hold one in-flight `runControl`
/// call open so a second call can be issued while the store is still busy.
private actor AsyncGate {
  private var blocked = false
  private var waiters: [CheckedContinuation<Void, Never>] = []
  private var blockedWaiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    blocked = true
    blockedWaiters.forEach { $0.resume() }
    blockedWaiters.removeAll()
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func waitUntilBlocked() async {
    if blocked { return }
    await withCheckedContinuation { continuation in
      blockedWaiters.append(continuation)
    }
  }

  func release() {
    waiters.forEach { $0.resume() }
    waiters.removeAll()
  }
}
