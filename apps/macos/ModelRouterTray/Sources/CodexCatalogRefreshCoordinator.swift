import Foundation

@MainActor
final class CodexCatalogRefreshCoordinator {
  enum ObservationAction: Equatable {
    case none
    case enqueueRefresh
    case suppressManagedRestart
  }

  private var previousCodexInstanceCount: Int?
  private var suppressNextFinalExit = false
  private var refreshTask: Task<Void, Never>?
  private var refreshPending = false
  private let refresh: @MainActor () async -> Void

  init(refresh: @escaping @MainActor () async -> Void) {
    self.refresh = refresh
  }

  @discardableResult
  func observeCodexInstanceCount(_ count: Int) -> ObservationAction {
    guard let previousCodexInstanceCount else {
      self.previousCodexInstanceCount = count
      return .none
    }

    self.previousCodexInstanceCount = count

    if previousCodexInstanceCount == 0, count > 0 {
      suppressNextFinalExit = false
      return .none
    }

    guard previousCodexInstanceCount > 0, count == 0 else {
      return .none
    }

    if suppressNextFinalExit {
      suppressNextFinalExit = false
      return .suppressManagedRestart
    }

    enqueueRefresh()
    return .enqueueRefresh
  }

  func armManagedRestartSuppression() {
    suppressNextFinalExit = true
  }

  func managedRestartTerminationFailed() {
    suppressNextFinalExit = false
  }

  func managedRestartCompleted() {
    suppressNextFinalExit = false
  }

  private func enqueueRefresh() {
    guard refreshTask == nil else {
      refreshPending = true
      return
    }

    refreshTask = Task { [weak self] in
      await self?.drainRefreshes()
    }
  }

  private func drainRefreshes() async {
    while true {
      refreshPending = false
      await refresh()
      guard refreshPending else { break }
    }
    refreshTask = nil
  }
}
