import Foundation

/// Mirrors packages/schema/src/account-resources.ts. Provider amounts stay
/// decimal strings with their reported units; the client never converts money.
public struct AccountTarget: Codable, Hashable, Sendable {
    public let harness: String
    public let profileId: String
    private enum CodingKeys: String, CodingKey {
        case harness
        case profileId = "profile_id"
    }
    public init(harness: String, profileId: String) {
        self.harness = harness
        self.profileId = profileId
    }
}

public struct ResourceFacet<Value: Codable & Equatable & Sendable>: Codable, Equatable, Sendable {
    public let value: Value?
    public let source: String?
    public let observedAt: String?
    public let freshness: ResourceFreshness
    public let lastAttemptAt: String?
    public let lastError: String?
    private enum CodingKeys: String, CodingKey {
        case value, source, freshness
        case observedAt = "observed_at"
        case lastAttemptAt = "last_attempt_at"
        case lastError = "last_error"
    }
}

public enum ResourceFreshness: String, Codable, Sendable {
    case fresh, stale, unknown
}

public struct AccountBalance: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let amount: String?
    public let unit: String
    public let currency: String?
    public let decimalPlaces: Int?
    public let hasBalance: Bool?
    public let unlimited: Bool?
    private enum CodingKeys: String, CodingKey {
        case id, label, amount, unit, currency, unlimited
        case hasBalance = "has_balance"
        case decimalPlaces = "decimal_places"
    }
}

public struct AccountSpending: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let enabled: Bool?
    public let used: String?
    public let limit: String?
    public let unit: String
    public let currency: String?
    public let decimalPlaces: Int?
    public let resetsAt: String?
    public let reason: String?
    private enum CodingKeys: String, CodingKey {
        case id, label, enabled, used, limit, unit, currency, reason
        case resetsAt = "resets_at"
        case decimalPlaces = "decimal_places"
    }
}

public struct AccountResetGrant: Codable, Equatable, Sendable, Identifiable {
    public let id: String
    public let label: String
    public let description: String?
    public let availableCount: Int?
    public let totalCount: Int?
    public let usableNow: Bool?
    public let startsAt: String?
    public let expiresAt: String?
    public let clears: [String]
    private enum CodingKeys: String, CodingKey {
        case id, label, description, clears
        case availableCount = "available_count"
        case totalCount = "total_count"
        case usableNow = "usable_now"
        case startsAt = "starts_at"
        case expiresAt = "expires_at"
    }
}

public struct AccountResetOffer: Codable, Equatable, Sendable, Identifiable {
    public enum Kind: String, Codable, Sendable {
        case grantedReset = "granted_reset"
        case sessionRefill = "session_refill"
    }
    public let id: String
    public let kind: Kind
    public let label: String
    public let description: String?
    public let availableCount: Int?
    public let eligible: Bool?
    public let usableNow: Bool?
    public let reason: String?
    public let resetsAt: String?
    public let weeklyLimitApplies: Bool
    /// Detail may be capped or absent. Its length is never inventory.
    public let grants: [AccountResetGrant]?
    private enum CodingKeys: String, CodingKey {
        case id, kind, label, description, eligible, reason, grants
        case availableCount = "available_count"
        case usableNow = "usable_now"
        case resetsAt = "resets_at"
        case weeklyLimitApplies = "weekly_limit_applies"
    }
}

public struct AccountResourceDiagnostic: Codable, Equatable, Sendable {
    public let code: String
    public let detail: String?
}

public struct AccountResourceSnapshot: Codable, Equatable, Sendable {
    public let target: AccountTarget
    public let balances: ResourceFacet<[AccountBalance]>
    public let spending: ResourceFacet<[AccountSpending]>
    public let resets: ResourceFacet<[AccountResetOffer]>
    public let diagnostics: ResourceFacet<[AccountResourceDiagnostic]>
}

/// Rich and legacy reads share the existing quota display owner. This wrapper
/// enforces the rich response's required resources field at the wire boundary.
public struct ControlAccountResourcesResponse: Codable, Equatable, Sendable {
    public let quota: ControlQuotaResponse
    public var resources: [AccountResourceSnapshot] { quota.resources ?? [] }
    private enum CodingKeys: String, CodingKey { case resources }
    public init(from decoder: Decoder) throws {
        let c = try decoder.container(keyedBy: CodingKeys.self)
        _ = try c.decode([AccountResourceSnapshot].self, forKey: .resources)
        quota = try ControlQuotaResponse(from: decoder)
    }
    public func encode(to encoder: Encoder) throws { try quota.encode(to: encoder) }
}

public struct ControlAccountResetRequest: Codable, Equatable, Sendable {
    public let target: AccountTarget
    public let offerId: String
    public let grantId: String?
    private enum CodingKeys: String, CodingKey {
        case target
        case offerId = "offer_id"
        case grantId = "grant_id"
    }
    public init(target: AccountTarget, offerId: String, grantId: String? = nil) {
        self.target = target
        self.offerId = offerId
        self.grantId = grantId
    }
}

public struct ControlAccountResetResponse: Codable, Equatable, Sendable {
    public enum State: String, Codable, Sendable { case running, completed }
    public enum Outcome: String, Codable, Sendable {
        case pending, reset, cooldown, unavailable, unknown
        case alreadyRedeemed = "already_redeemed"
        case alreadyUsed = "already_used"
        case nothingToReset = "nothing_to_reset"
        case noCredit = "no_credit"
        case notEligible = "not_eligible"
        public var confirmsReset: Bool { self == .reset || self == .alreadyRedeemed }
    }
    public struct Readback: Codable, Equatable, Sendable {
        public enum State: String, Codable, Sendable { case pending, fresh, failed }
        public let state: State
        public let attemptedAt: String?
        public let detail: String?
        private enum CodingKeys: String, CodingKey {
            case state, detail
            case attemptedAt = "attempted_at"
        }
    }
    public let id: String
    public let request: ControlAccountResetRequest
    public let state: State
    public let createdAt: String
    public let completedAt: String?
    public let outcome: Outcome
    public let detail: String?
    public let readback: Readback
    public let resources: ControlAccountResourcesResponse?

    /// Client recovery retains the outcome, never a second account-data snapshot.
    public func withoutResources() -> Self {
        Self(id: id, request: request, state: state, createdAt: createdAt,
             completedAt: completedAt, outcome: outcome, detail: detail,
             readback: readback, resources: nil)
    }

    private enum CodingKeys: String, CodingKey {
        case id, request, state, outcome, detail, readback, resources
        case createdAt = "created_at"
        case completedAt = "completed_at"
    }
}
