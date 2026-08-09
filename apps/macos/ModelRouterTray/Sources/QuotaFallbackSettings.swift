import SwiftUI

struct QuotaFallbackOutcomeSnapshot: Decodable, Equatable {
  let at: String
  let outcome: String
  let status: Int?
}

struct QuotaFallbackSnapshot: Decodable, Equatable {
  let enabled: Bool
  let model: String
  let providerReady: Bool
  let readiness: String
  let readinessHint: String?
  let nativeRedirectPrecedence: Bool
  let lastOutcome: QuotaFallbackOutcomeSnapshot?
}

/// Pure projection from the optional router snapshot to what the row shows.
/// Keeping this separate from the view lets the summary/enablement/failure
/// mapping be pinned by tests without touching SwiftUI at all.
struct QuotaFallbackViewState {
  let snapshot: QuotaFallbackSnapshot?

  init(snapshot: QuotaFallbackSnapshot?) {
    self.snapshot = snapshot
  }

  static let actionLabel = "Use Kimi K3 when ChatGPT quota is exhausted"

  static let helpText = "Only confirmed account-quota exhaustion can switch providers. Rate " +
    "limits, context limits, partial streams, and tasks with opaque native history stay on " +
    "ChatGPT."

  var summary: String {
    guard let snapshot else { return "Unavailable · update router" }
    guard snapshot.enabled else { return "Off" }
    if snapshot.nativeRedirectPrecedence { return "Paused · native redirect takes precedence" }
    switch snapshot.readiness {
    case "ready": return "Kimi K3 · ready"
    case "credential-missing": return "Kimi K3 · needs API key"
    case "provider-not-selected": return "Kimi K3 · provider disabled"
    default: return "Kimi K3 · not ready"
    }
  }

  var accessibilityValue: String { summary }

  /// Activation (off -> on) requires a ready provider. An already-enabled
  /// policy can always be turned back off regardless of current readiness,
  /// since readiness can regress after enabling (e.g. a removed credential).
  var canToggleOn: Bool {
    snapshot?.providerReady == true
  }

  var canToggleOff: Bool {
    snapshot?.enabled == true
  }

  /// Derived only from readiness, never from a caught error's own text, so a
  /// raw process or credential failure can never reach the displayed message.
  var sanitizedFailureMessage: String {
    guard let snapshot, snapshot.readiness != "target-not-registered" else {
      return "Update Codex Router before changing quota fallback."
    }
    switch snapshot.readiness {
    case "credential-missing":
      return "Add the Kimi API key, then try again."
    case "provider-not-selected":
      return "Enable the Kimi API provider, then try again."
    default:
      return "Could not update quota fallback. No credentials were changed."
    }
  }
}

struct QuotaFallbackRow: View {
  @ObservedObject var store: RouterStore

  private var state: QuotaFallbackViewState {
    QuotaFallbackViewState(snapshot: store.quotaFallback)
  }

  private var isBusy: Bool { store.providerOperation == "quota-fallback" }

  var body: some View {
    HStack(spacing: 12) {
      VStack(alignment: .leading, spacing: 3) {
        Text(QuotaFallbackViewState.actionLabel)
          .font(.system(size: 12, weight: .medium))
        Text(state.summary)
          .font(.system(size: 9))
          .foregroundStyle(routerMuted)
          .accessibilityLabel("Quota fallback status: \(state.summary)")
      }
      Spacer()
      if isBusy {
        ProgressView()
          .controlSize(.small)
          .tint(routerAccent)
          .frame(width: 24)
          .accessibilityLabel("Updating quota fallback")
      } else {
        Toggle("", isOn: Binding(
          get: { store.quotaFallback?.enabled ?? false },
          set: { enabled in Task { await store.setQuotaFallbackEnabled(enabled) } }
        ))
        .labelsHidden()
        .toggleStyle(.switch)
        .controlSize(.small)
        .tint(routerMint)
        .disabled(store.providerOperation != nil || (!state.canToggleOn && !state.canToggleOff))
        .accessibilityLabel(QuotaFallbackViewState.actionLabel)
        .accessibilityValue(state.accessibilityValue)
        .accessibilityHint(QuotaFallbackViewState.helpText)
      }
    }
    .padding(.vertical, 1)
  }
}
