import ClaudexorKit
import SwiftUI

/// Used by the shared AccountsSurface in the popover and Settings. Only this
/// connector knows AppModel; the row and details are service-free native leaves.
struct AccountResourcesRow: View {
    @Environment(AppModel.self) private var model
    let row: AccountRowModel
    let contentWidth: CGFloat
    let login: () -> Void
    let loginDisabled: Bool
    let setEnabled: (Bool) -> Void
    let delete: (() -> Void)?
    @State private var expanded = false
    @State private var confirmation: Confirmation?

    private struct Confirmation {
        let title: String
        let message: String
        let request: ControlAccountResetRequest
        let label: String
        let connection: AccountResourceConnection
    }
    private var target: AccountTarget { AccountTarget(harness: row.harnessId, profileId: row.profileId) }
    private var location: ExecutionLocationID { model.activeExecutionLocation }
    private var snapshot: AccountResourceSnapshot? {
        model.activeQuotaResponse?.resources?.first { $0.target == target }
    }
    private var attempts: [AccountResetAttempt] {
        model.accountResourceActions.attempts(for: target, at: location)
    }
    private var capabilities: AccountResourceCapabilities? {
        model.accountResourceActions.capabilities(at: location, client: model.gateway(for: location))
    }

    var body: some View {
        AccountRowView(row: row, login: login, loginDisabled: loginDisabled,
                       setEnabled: setEnabled, delete: delete,
                       resourceSummary: AccountResourcePresentation.summary(snapshot, attempts: attempts),
                       resourceStatus: compactStatus, expanded: expanded,
                       toggleResources: { expanded.toggle() })
            .confirmationDialog(confirmation?.title ?? "Use reset", isPresented: Binding(
                get: { confirmation != nil }, set: { if !$0 { confirmation = nil } }),
                titleVisibility: .visible) {
                    if let confirmation {
                        Button(confirmation.title) {
                            self.confirmation = nil
                            Task {
                                await model.accountResourceActions.startReset(
                                    confirmation.request, label: confirmation.label,
                                    using: confirmation.connection)
                            }
                        }
                    }
                    Button("Cancel", role: .cancel) { confirmation = nil }
                } message: { Text(confirmation?.message ?? "") }
            .onChange(of: location) { _, _ in confirmation = nil; expanded = false }
        if expanded {
            GridRow {
                AccountResourceDetails(
                    row: row, snapshot: snapshot, capabilities: capabilities,
                    capabilityError: model.accountResourceActions.capabilityErrors[location],
                    recoveryNotice: model.accountResourceActions.recoveryNotice,
                    absences: model.activeQuotaResponse?.absences.filter {
                        $0.subject.harness == target.harness && $0.subject.subjectId == target.profileId
                    } ?? [],
                    attempts: attempts,
                    refreshState: model.accountResourceActions.refreshes[location]?[target],
                    refresh: refresh,
                    recover: recover,
                    reset: requestReset)
                .frame(width: contentWidth, alignment: .leading)
                .gridCellColumns(AccountsPresentation.AccountRowColumn.allCases.count + 1)
                .gridCellUnsizedAxes(.horizontal)
                .padding(.bottom, Theme.Spacing.sm)
            }
        }
    }

    private var compactStatus: String? {
        if let latest = attempts.last, latest.unconfirmed || latest.usageNeedsRefresh {
            return latest.unconfirmed ? "Reset result unconfirmed" : "Reset applied · usage not updated"
        }
        if model.accountResourceActions.refreshes[location]?[target]?.error != nil {
            return "Resources stale · refresh failed"
        }
        if row.quotaGroups.contains(where: { $0.freshness != "fresh" }) { return "Last-known quota" }
        return nil
    }

    private func refresh() {
        guard let connection = model.accountResourceConnection(at: location) else { return }
        Task { await model.accountResourceActions.refresh(target, using: connection) }
    }
    private func recover(_ key: String) {
        guard let connection = model.accountResourceConnection(at: location) else { return }
        Task { await model.accountResourceActions.recoverReset(key: key, using: connection) }
    }
    private func requestReset(_ offer: AccountResetOffer, _ grant: AccountResetGrant?) {
        guard let connection = model.accountResourceConnection(at: location) else { return }
        let previous = attempts.last
        let freshness: ResourceFreshness = attempts.contains(where: \.usageNeedsRefresh)
            ? .stale : snapshot?.resets.freshness ?? .unknown
        confirmation = Confirmation(
            title: AccountResourcePresentation.action(offer, another: previous != nil),
            message: AccountResourcePresentation.confirmation(account: row.displayName,
                offer: offer, grant: grant, freshness: freshness, previous: previous),
            request: ControlAccountResetRequest(target: target, offerId: offer.id, grantId: grant?.id),
            label: offer.label, connection: connection)
    }
}
