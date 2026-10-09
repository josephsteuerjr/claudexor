import Foundation

public extension ControlQuotaResponse {
    /// Commit an exact-account control response into the existing quota owner.
    /// Unaddressed rows keep their data, absence and independent observation age.
    /// A later background read may already own newer facts for THIS account.
    /// Compare provider observation/attempt times; the existing display generation
    /// breaks ties (including undated facts) in favour of an intervening owner.
    func replacingAccount(
        _ target: AccountTarget, in previous: ControlQuotaResponse?,
        preferPreviousOnTie: Bool = false
    ) -> ControlQuotaResponse {
        guard let previous else { return self }
        func matches(_ subject: QuotaSubject) -> Bool {
            subject.harness == target.harness && subject.subjectId == target.profileId
        }
        func quotaTime(_ response: ControlQuotaResponse) -> Date? {
            (response.snapshots.filter { matches($0.subject) }.map(\.observedAt)
             + response.absences.filter { matches($0.subject) }.map(\.observedAt))
                .compactMap(parseOffsetTimestamp).max()
        }
        let quotaOwner = keepPreviousResourceObservation(incoming: quotaTime(self), previous: quotaTime(previous),
                                                         onTie: preferPreviousOnTie) ? previous : self
        let snapshots = previous.snapshots.filter { !matches($0.subject) }
            + quotaOwner.snapshots.filter { matches($0.subject) }
        let absences = previous.absences.filter { !matches($0.subject) }
            + quotaOwner.absences.filter { matches($0.subject) }
        let oldResource = previous.resources?.first { $0.target == target }
        let incomingResource = resources?.first { $0.target == target }
        let addressedResource = incomingResource.map {
            $0.preservingNewer(in: oldResource, preferPreviousOnTie: preferPreviousOnTie)
        } ?? (preferPreviousOnTie ? oldResource : nil)
        let resources = (previous.resources ?? []).filter { $0.target != target }
            + [addressedResource].compactMap { $0 }
        let skipped = (previous.refreshSkipped ?? []).filter { $0.subject.map(matches) != true }
            + (quotaOwner.refreshSkipped ?? []).filter { $0.subject.map(matches) == true }
        let refreshedAt = keepPreviousResourceObservation(
            incoming: refreshedAt.flatMap(parseOffsetTimestamp), previous: previous.refreshedAt.flatMap(parseOffsetTimestamp),
            onTie: preferPreviousOnTie) ? previous.refreshedAt : refreshedAt
        return ControlQuotaResponse(snapshots: snapshots, absences: absences,
                                    refreshedAt: refreshedAt, refreshSkipped: skipped.isEmpty ? nil : skipped,
                                    resources: resources)
    }
}

private extension AccountResourceSnapshot {
    func preservingNewer(in previous: Self?, preferPreviousOnTie: Bool) -> Self {
        guard let previous else { return self }
        return Self(target: target,
            balances: balances.preservingNewer(in: previous.balances, onTie: preferPreviousOnTie),
            spending: spending.preservingNewer(in: previous.spending, onTie: preferPreviousOnTie),
            resets: resets.preservingNewer(in: previous.resets, onTie: preferPreviousOnTie),
            diagnostics: diagnostics.preservingNewer(in: previous.diagnostics, onTie: preferPreviousOnTie))
    }
}

private extension ResourceFacet {
    var comparisonTime: Date? { [observedAt, lastAttemptAt].compactMap { $0.flatMap(parseOffsetTimestamp) }.max() }
    func preservingNewer(in previous: Self, onTie: Bool) -> Self {
        keepPreviousResourceObservation(incoming: comparisonTime, previous: previous.comparisonTime, onTie: onTie)
            ? previous : self
    }
}

private func keepPreviousResourceObservation(incoming: Date?, previous: Date?, onTie: Bool) -> Bool {
    switch (incoming, previous) {
    case let (incoming?, previous?): return previous > incoming || (previous == incoming && onTie)
    case (nil, _?): return true
    case (_?, nil): return false
    case (nil, nil): return onTie
    }
}
