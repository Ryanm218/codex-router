import XCTest
@testable import ModelRouterTray

@MainActor
final class CodexCatalogRefreshCoordinatorTests: XCTestCase {
  func testFinalExitTriggersRefresh() async {
    let calls = CallCounter()
    let coordinator = CodexCatalogRefreshCoordinator { await calls.increment() }
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(1), .none)
    XCTAssertEqual(coordinator.observeCodexInstanceCount(0), .enqueueRefresh)
    await calls.waitForOne()
    let count = await calls.current()
    XCTAssertEqual(count, 1)
  }
}

actor CallCounter {
  private(set) var value = 0
  func current() -> Int { value }
  func increment() { value += 1 }
  func waitForOne() async {
    for _ in 0..<100 where value == 0 {
      try? await Task.sleep(for: .milliseconds(10))
    }
  }
}
