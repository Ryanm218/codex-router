import Combine
import XCTest
@testable import ModelRouterTray

@MainActor
final class CodexCatalogRefreshTests: XCTestCase {
  func testInitialZeroOnlySeedsObservation() {
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
  }

  func testLaunchThenFinalExitEnqueuesOneRefresh() {
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
  }

  func testIntermediateInstanceExitDoesNotRefreshButFinalExitDoes() {
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    XCTAssertEqual(coordinator.observeCodexInstanceCount(2), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
  }

  func testRepeatedZeroDoesNotDuplicateRefresh() {
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
  }

  func testCodexExitIsIndependentOfAggregateHostAppState() {
    // The coordinator intentionally accepts only the Codex instance count.
    // A concurrently running ChatGPT app therefore cannot suppress this exit.
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    _ = coordinator.observeCodexInstanceCount(0)
    _ = coordinator.observeCodexInstanceCount(1)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
  }

  func testManagedRestartSuppressionConsumesExactlyOneFinalExit() async {
    let probe = AsyncRefreshProbe()
    let coordinator = CodexCatalogRefreshCoordinator(refresh: { await probe.run() })

    _ = coordinator.observeCodexInstanceCount(1)
    coordinator.armManagedRestartSuppression()
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .suppressManagedRestart)

    let suppressedExitStartedRefresh = await probe.waitUntilCallCount(1, timeout: .milliseconds(50))
    XCTAssertFalse(suppressedExitStartedRefresh)

    XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)

    let ordinaryExitStartedRefresh = await probe.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(ordinaryExitStartedRefresh)
    guard ordinaryExitStartedRefresh else { return }

    let runningSnapshot = await probe.snapshot
    XCTAssertEqual(runningSnapshot.callCount, 1)
    await probe.releaseNext()
    let ordinaryExitCompleted = await probe.waitUntilCompletionCount(1, timeout: .seconds(1))
    XCTAssertTrue(ordinaryExitCompleted)
  }

  func testTerminationFailureClearsManagedRestartSuppression() {
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    _ = coordinator.observeCodexInstanceCount(1)
    coordinator.armManagedRestartSuppression()
    coordinator.managedRestartTerminationFailed()

    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
  }

  func testRelaunchClearsAnUnconsumedManagedRestartSuppression() {
    let coordinator = CodexCatalogRefreshCoordinator(refresh: {})

    _ = coordinator.observeCodexInstanceCount(0)
    coordinator.armManagedRestartSuppression()
    XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)

    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
  }

  func testDuplicateExitObservationsKeepOnlyOneRefreshInFlight() async {
    let probe = AsyncRefreshProbe()
    let coordinator = CodexCatalogRefreshCoordinator(refresh: { await probe.run() })

    _ = coordinator.observeCodexInstanceCount(0)
    _ = coordinator.observeCodexInstanceCount(1)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)

    let started = await probe.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    guard started else { return }

    for _ in 0..<10 {
      XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
    }

    let blockedSnapshot = await probe.snapshot
    XCTAssertEqual(blockedSnapshot.callCount, 1)
    XCTAssertEqual(blockedSnapshot.maxConcurrent, 1)

    await probe.releaseNext()
    let completed = await probe.waitUntilCompletionCount(1, timeout: .seconds(1))
    XCTAssertTrue(completed)
    let completedSnapshot = await probe.snapshot
    XCTAssertEqual(completedSnapshot.callCount, 1)
    XCTAssertEqual(completedSnapshot.completionCount, 1)
  }

  func testCompleteCyclesWhileBlockedCoalesceToOneFollowUp() async {
    let probe = AsyncRefreshProbe()
    let coordinator = CodexCatalogRefreshCoordinator(refresh: { await probe.run() })

    _ = coordinator.observeCodexInstanceCount(0)
    _ = coordinator.observeCodexInstanceCount(1)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)

    let firstStarted = await probe.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(firstStarted)
    guard firstStarted else { return }

    for _ in 0..<2 {
      XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)
      XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
    }

    let firstBlockedSnapshot = await probe.snapshot
    XCTAssertEqual(firstBlockedSnapshot.callCount, 1)
    await probe.releaseNext()
    let secondStarted = await probe.waitUntilCallCount(2, timeout: .seconds(1))
    XCTAssertTrue(secondStarted)
    let secondBlockedSnapshot = await probe.snapshot
    XCTAssertEqual(secondBlockedSnapshot.callCount, 2)
    XCTAssertEqual(secondBlockedSnapshot.maxConcurrent, 1)
    guard secondStarted else { return }

    await probe.releaseNext()
    let secondCompleted = await probe.waitUntilCompletionCount(2, timeout: .seconds(1))
    XCTAssertTrue(secondCompleted)
    let completedSnapshot = await probe.snapshot
    XCTAssertEqual(completedSnapshot.callCount, 2)
    XCTAssertEqual(completedSnapshot.completionCount, 2)
  }
}

@MainActor
final class RouterStoreCatalogRefreshTests: XCTestCase {
  func testInitialAbsentCodexObservationDoesNotRunCatalogRefresh() async {
    let runner = CatalogControlRunner()
    let store = makeStore(runner: runner)

    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)

    let started = await runner.waitUntilCallCount(1, timeout: .milliseconds(50))
    XCTAssertFalse(started)
    let calls = await runner.calls
    XCTAssertEqual(calls, [])
  }

  func testFinalCodexExitRunsOnlyTheExactCatalogRefreshCommand() async {
    let runner = CatalogControlRunner()
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)

    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    let calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"]])
  }

  func testOnlyTheLastOfMultipleCodexInstancesRunsCatalogRefresh() async {
    let runner = CatalogControlRunner()
    let store = makeStore(runner: runner)

    store.observeHostApplications(codexInstanceCount: 2, chatGPTInstanceCount: 0)
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)
    let intermediateExitStarted = await runner.waitUntilCallCount(1, timeout: .milliseconds(50))
    XCTAssertFalse(intermediateExitStarted)

    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    let finalExitStarted = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(finalExitStarted)
    let calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"]])
  }

  func testChatGPTRemainingOpenKeepsAggregateHostRunningButDoesNotSuppressCatalogRefresh() async {
    let runner = CatalogControlRunner()
    let store = makeStore(runner: runner)

    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 1)
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 1)
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 1)

    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    XCTAssertTrue(store.hostAppRunning)
    let calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"]])
  }

  func testRepeatedZeroObservationsDoNotDuplicateCatalogRefresh() async {
    let runner = CatalogControlRunner()
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    let duplicateStarted = await runner.waitUntilCallCount(2, timeout: .milliseconds(50))

    XCTAssertFalse(duplicateStarted)
    let calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"]])
  }

  func testCompletedCyclesDuringCatalogRefreshCoalesceToOneSecondRun() async {
    let gate = CatalogAsyncGate()
    let runner = CatalogControlRunner { arguments, _ in
      if arguments == ["catalog-refresh"] { await gate.wait() }
      return catalogUpdatedJSON
    }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let firstStarted = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(firstStarted)
    for _ in 0..<3 {
      store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)
      store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    }

    await gate.releaseNext()
    let secondStarted = await runner.waitUntilCallCount(2, timeout: .seconds(1))
    XCTAssertTrue(secondStarted)
    let thirdStarted = await runner.waitUntilCallCount(3, timeout: .milliseconds(50))
    XCTAssertFalse(thirdStarted)
    await gate.releaseNext()

    let calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"], ["catalog-refresh"]])
  }

  func testCatalogRefreshWaitsForAnExistingProviderOperation() async {
    let providerGate = CatalogAsyncGate()
    let runner = CatalogControlRunner { arguments, _ in
      if arguments == ["quota-fallback", "set", "kimi-api/kimi-k3"] {
        await providerGate.wait()
      }
      if arguments == ["--json"] { return emptyRouterSnapshotJSON }
      return catalogUpdatedJSON
    }
    let store = makeStore(runner: runner)

    let providerTask = Task { await store.setQuotaFallbackEnabled(true) }
    let providerStarted = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(providerStarted)
    triggerFinalCodexExit(on: store)

    await providerGate.releaseNext()
    await providerTask.value
    let catalogStarted = await runner.waitUntilCallCount(3, timeout: .seconds(1))
    XCTAssertTrue(catalogStarted)
    let calls = await runner.calls
    XCTAssertEqual(calls, [
      ["quota-fallback", "set", "kimi-api/kimi-k3"],
      ["--json"],
      ["catalog-refresh"],
    ])
  }

  func testRelaunchWhileQueuedRefreshWaitsSkipsControlUntilNextFinalExit() async {
    let providerGate = CatalogAsyncGate()
    let runner = CatalogControlRunner { arguments, _ in
      if arguments == ["quota-fallback", "set", "kimi-api/kimi-k3"] {
        await providerGate.wait()
      }
      if arguments == ["--json"] { return emptyRouterSnapshotJSON }
      return catalogUpdatedJSON
    }
    let store = makeStore(runner: runner)

    let providerTask = Task { await store.setQuotaFallbackEnabled(true) }
    let providerStarted = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(providerStarted)
    guard providerStarted else { return }

    triggerFinalCodexExit(on: store)
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)
    let refreshReservationFinished = waitForCatalogRefreshReservationToFinish(
      on: store,
      timeout: .seconds(1)
    )

    await providerGate.releaseNext()
    await providerTask.value
    let reservationFinished = await refreshReservationFinished.value
    XCTAssertTrue(reservationFinished)

    var calls = await runner.calls
    XCTAssertEqual(calls, [
      ["quota-fallback", "set", "kimi-api/kimi-k3"],
      ["--json"],
    ])

    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    let ordinaryExitRefreshed = await runner.waitUntilCallCount(3, timeout: .seconds(1))
    XCTAssertTrue(ordinaryExitRefreshed)
    calls = await runner.calls
    XCTAssertEqual(calls, [
      ["quota-fallback", "set", "kimi-api/kimi-k3"],
      ["--json"],
      ["catalog-refresh"],
    ])
  }

  func testProviderMutationCannotBeginWhileCatalogRefreshOwnsTheBoundary() async {
    let catalogGate = CatalogAsyncGate()
    let runner = CatalogControlRunner { arguments, _ in
      if arguments == ["catalog-refresh"] { await catalogGate.wait() }
      return catalogUpdatedJSON
    }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let catalogStarted = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(catalogStarted)
    XCTAssertEqual(store.providerOperation, "catalog-refresh")

    await store.setQuotaFallbackEnabled(true)
    var calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"]])
    await catalogGate.releaseNext()
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))
    XCTAssertTrue(finished)

    calls = await runner.calls
    XCTAssertEqual(calls, [["catalog-refresh"]])
  }

  func testManagedCodexRestartSuppressesItsExitButNotTheNextOrdinaryQuit() async {
    let runner = CatalogControlRunner { arguments, _ in
      arguments == ["--json"] ? emptyRouterSnapshotJSON : catalogUpdatedJSON
    }
    let store = makeStore(
      runner: runner,
      codexRestartRunnerOverride: { willTerminate, didTerminate in
        willTerminate(1)
        didTerminate()
      }
    )
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)

    await store.setLoginFree(true)
    let managedExitRefreshed = await runner.waitUntilCallCount(3, timeout: .milliseconds(50))
    XCTAssertFalse(managedExitRefreshed)
    var calls = await runner.calls
    XCTAssertEqual(calls, [["auth-mode", "on"], ["--json"]])

    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    let ordinaryExitRefreshed = await runner.waitUntilCallCount(3, timeout: .seconds(1))
    XCTAssertTrue(ordinaryExitRefreshed)
    calls = await runner.calls
    XCTAssertEqual(calls, [["auth-mode", "on"], ["--json"], ["catalog-refresh"]])
  }

  func testManagedTerminationFailureDoesNotSuppressALaterOrdinaryQuit() async {
    let runner = CatalogControlRunner { arguments, _ in
      arguments == ["--json"] ? emptyRouterSnapshotJSON : catalogUpdatedJSON
    }
    let store = makeStore(
      runner: runner,
      codexRestartRunnerOverride: { willTerminate, _ in
        willTerminate(1)
        throw CatalogTestError("termination rejected")
      }
    )
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)

    await store.setLoginFree(true)
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)

    let ordinaryExitRefreshed = await runner.waitUntilCallCount(3, timeout: .seconds(1))
    XCTAssertTrue(ordinaryExitRefreshed)
    let calls = await runner.calls
    XCTAssertEqual(calls, [["auth-mode", "on"], ["--json"], ["catalog-refresh"]])
  }

  func testUpdatedCatalogUsesTheNextLaunchMessage() async {
    let runner = CatalogControlRunner()
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))

    XCTAssertTrue(finished)
    XCTAssertEqual(store.message, "Model catalog refreshed for the next Codex launch.")
  }

  func testUpdatedCatalogAfterFastRelaunchUsesQuitAgainMessage() async {
    let gate = CatalogAsyncGate()
    let runner = CatalogControlRunner { arguments, _ in
      if arguments == ["catalog-refresh"] { await gate.wait() }
      return catalogUpdatedJSON
    }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)
    await gate.releaseNext()
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))

    XCTAssertTrue(finished)
    XCTAssertEqual(store.message, "Model catalog refreshed. Quit and reopen Codex once more.")
  }

  func testUnchangedCatalogUsesTheAlreadyCurrentMessage() async {
    let runner = CatalogControlRunner { _, _ in catalogUnchangedJSON }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))

    XCTAssertTrue(finished)
    XCTAssertEqual(store.message, "Model catalog is already current.")
  }

  func testSkippedCatalogRefreshIsQuiet() async {
    let runner = CatalogControlRunner { _, _ in catalogSkippedJSON }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))

    XCTAssertTrue(finished)
    XCTAssertNil(store.message)
  }

  func testInvalidCatalogResultUsesOnlyTheFixedFailureMessage() async {
    let runner = CatalogControlRunner { _, _ in
      Data(#"{"status":"SECRET_RAW_BODY","nativeModels":9}"#.utf8)
    }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))

    XCTAssertTrue(finished)
    XCTAssertEqual(store.message, "Catalog refresh failed; the previous catalog remains active.")
    XCTAssertFalse(store.message?.contains("SECRET_RAW_BODY") ?? true)
  }

  func testThrownCatalogErrorNeverLeaksRawBody() async {
    let runner = CatalogControlRunner { _, _ in
      throw CatalogTestError("upstream returned SECRET_RAW_BODY")
    }
    let store = makeStore(runner: runner)

    triggerFinalCodexExit(on: store)
    let started = await runner.waitUntilCallCount(1, timeout: .seconds(1))
    XCTAssertTrue(started)
    let finished = await waitForProviderOperationToFinish(on: store, timeout: .seconds(1))

    XCTAssertTrue(finished)
    XCTAssertEqual(store.message, "Catalog refresh failed; the previous catalog remains active.")
    XCTAssertFalse(store.message?.contains("SECRET_RAW_BODY") ?? true)
  }

  private func makeStore(
    runner: CatalogControlRunner,
    codexRestartRunnerOverride: RouterCodexRestartRunner? = nil
  ) -> RouterStore {
    RouterStore(
      controlRunnerOverride: { arguments, stdin in
        try await runner.run(arguments, stdin)
      },
      codexRestartRunnerOverride: codexRestartRunnerOverride
    )
  }

  private func triggerFinalCodexExit(on store: RouterStore) {
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
    store.observeHostApplications(codexInstanceCount: 1, chatGPTInstanceCount: 0)
    store.observeHostApplications(codexInstanceCount: 0, chatGPTInstanceCount: 0)
  }

  private func waitForProviderOperationToFinish(
    on store: RouterStore,
    timeout: Duration
  ) async -> Bool {
    if store.providerOperation == nil { return true }
    let waiter = CatalogPublishedWaiter()
    return await withCheckedContinuation { continuation in
      waiter.continuation = continuation
      waiter.cancellable = store.$providerOperation.sink { operation in
        if operation == nil { waiter.resolve(true) }
      }
      Task { @MainActor [weak waiter] in
        try? await Task.sleep(for: timeout)
        waiter?.resolve(false)
      }
    }
  }

  private func waitForCatalogRefreshReservationToFinish(
    on store: RouterStore,
    timeout: Duration
  ) -> Task<Bool, Never> {
    let waiter = CatalogOperationCycleWaiter()
    waiter.cancellable = store.$providerOperation.sink { operation in
      waiter.observe(operation)
    }
    return Task { @MainActor in
      await waiter.wait(timeout: timeout)
    }
  }
}

private let catalogUpdatedJSON = Data(#"{"status":"updated","nativeModels":9}"#.utf8)
private let catalogUnchangedJSON = Data(#"{"status":"unchanged","nativeModels":9}"#.utf8)
private let catalogSkippedJSON = Data(#"{"status":"skipped","nativeModels":0}"#.utf8)
private let emptyRouterSnapshotJSON = Data(#"{"targets":{}}"#.utf8)

private struct CatalogTestError: LocalizedError {
  let detail: String
  init(_ detail: String) { self.detail = detail }
  var errorDescription: String? { detail }
}

@MainActor
private final class CatalogPublishedWaiter {
  var cancellable: AnyCancellable?
  var continuation: CheckedContinuation<Bool, Never>?
  private var resolved = false

  func resolve(_ value: Bool) {
    guard !resolved else { return }
    resolved = true
    cancellable?.cancel()
    cancellable = nil
    continuation?.resume(returning: value)
    continuation = nil
  }
}

@MainActor
private final class CatalogOperationCycleWaiter {
  var cancellable: AnyCancellable?
  private var observedCatalogRefresh = false
  private var continuation: CheckedContinuation<Bool, Never>?
  private var resolution: Bool?

  func observe(_ operation: String?) {
    if operation == "catalog-refresh" {
      observedCatalogRefresh = true
    } else if observedCatalogRefresh, operation == nil {
      resolve(true)
    }
  }

  func resolve(_ value: Bool) {
    guard resolution == nil else { return }
    resolution = value
    cancellable?.cancel()
    cancellable = nil
    continuation?.resume(returning: value)
    continuation = nil
  }

  func wait(timeout: Duration) async -> Bool {
    if let resolution { return resolution }
    return await withCheckedContinuation { continuation in
      self.continuation = continuation
      Task { @MainActor [weak self] in
        try? await Task.sleep(for: timeout)
        self?.resolve(false)
      }
    }
  }
}

private actor CatalogControlRunner {
  typealias Handler = @Sendable ([String], Data?) async throws -> Data

  private var recordedCalls: [[String]] = []
  private var callCountWaiters: [UUID: (target: Int, continuation: CheckedContinuation<Bool, Never>)] = [:]
  private let handler: Handler

  init(handler: @escaping Handler = { _, _ in catalogUpdatedJSON }) {
    self.handler = handler
  }

  var calls: [[String]] { recordedCalls }

  func run(_ arguments: [String], _ stdin: Data?) async throws -> Data {
    recordedCalls.append(arguments)
    resumeSatisfiedCallCountWaiters()
    return try await handler(arguments, stdin)
  }

  func waitUntilCallCount(_ target: Int, timeout: Duration) async -> Bool {
    if recordedCalls.count >= target { return true }
    let id = UUID()
    return await withCheckedContinuation { continuation in
      callCountWaiters[id] = (target, continuation)
      Task { [weak self] in
        try? await Task.sleep(for: timeout)
        await self?.timeOutCallCountWaiter(id)
      }
    }
  }

  private func resumeSatisfiedCallCountWaiters() {
    let satisfied = callCountWaiters.filter { $0.value.target <= recordedCalls.count }
    for (id, waiter) in satisfied {
      callCountWaiters.removeValue(forKey: id)
      waiter.continuation.resume(returning: true)
    }
  }

  private func timeOutCallCountWaiter(_ id: UUID) {
    callCountWaiters.removeValue(forKey: id)?.continuation.resume(returning: false)
  }
}

private actor CatalogAsyncGate {
  private var releaseCount = 0
  private var waiters: [CheckedContinuation<Void, Never>] = []

  func wait() async {
    if releaseCount > 0 {
      releaseCount -= 1
      return
    }
    await withCheckedContinuation { continuation in
      waiters.append(continuation)
    }
  }

  func releaseNext() {
    if waiters.isEmpty {
      releaseCount += 1
    } else {
      waiters.removeFirst().resume()
    }
  }
}

private actor AsyncRefreshProbe {
  private struct CountWaiter {
    let target: Int
    let continuation: CheckedContinuation<Bool, Never>
  }

  struct Snapshot {
    let callCount: Int
    let completionCount: Int
    let maxConcurrent: Int
  }

  private var callCount = 0
  private var completionCount = 0
  private var concurrent = 0
  private var maxConcurrent = 0
  private var releaseWaiters: [CheckedContinuation<Void, Never>] = []
  private var callCountWaiters: [UUID: CountWaiter] = [:]
  private var completionCountWaiters: [UUID: CountWaiter] = [:]

  var snapshot: Snapshot {
    Snapshot(
      callCount: callCount,
      completionCount: completionCount,
      maxConcurrent: maxConcurrent
    )
  }

  func run() async {
    callCount += 1
    concurrent += 1
    maxConcurrent = max(maxConcurrent, concurrent)
    resumeSatisfiedCallCountWaiters()

    await withCheckedContinuation { continuation in
      releaseWaiters.append(continuation)
    }

    concurrent -= 1
    completionCount += 1
    resumeSatisfiedCompletionCountWaiters()
  }

  func waitUntilCallCount(_ target: Int, timeout: Duration) async -> Bool {
    if callCount >= target { return true }
    let id = UUID()
    return await withCheckedContinuation { continuation in
      callCountWaiters[id] = CountWaiter(target: target, continuation: continuation)
      Task { [weak self] in
        try? await Task.sleep(for: timeout)
        await self?.timeOutCallCountWaiter(id)
      }
    }
  }

  func waitUntilCompletionCount(_ target: Int, timeout: Duration) async -> Bool {
    if completionCount >= target { return true }
    let id = UUID()
    return await withCheckedContinuation { continuation in
      completionCountWaiters[id] = CountWaiter(target: target, continuation: continuation)
      Task { [weak self] in
        try? await Task.sleep(for: timeout)
        await self?.timeOutCompletionCountWaiter(id)
      }
    }
  }

  func releaseNext() {
    guard !releaseWaiters.isEmpty else { return }
    releaseWaiters.removeFirst().resume()
  }

  private func resumeSatisfiedCallCountWaiters() {
    let satisfied = callCountWaiters.filter { $0.value.target <= callCount }
    for (id, waiter) in satisfied {
      callCountWaiters.removeValue(forKey: id)
      waiter.continuation.resume(returning: true)
    }
  }

  private func resumeSatisfiedCompletionCountWaiters() {
    let satisfied = completionCountWaiters.filter { $0.value.target <= completionCount }
    for (id, waiter) in satisfied {
      completionCountWaiters.removeValue(forKey: id)
      waiter.continuation.resume(returning: true)
    }
  }

  private func timeOutCallCountWaiter(_ id: UUID) {
    callCountWaiters.removeValue(forKey: id)?.continuation.resume(returning: false)
  }

  private func timeOutCompletionCountWaiter(_ id: UUID) {
    completionCountWaiters.removeValue(forKey: id)?.continuation.resume(returning: false)
  }
}
