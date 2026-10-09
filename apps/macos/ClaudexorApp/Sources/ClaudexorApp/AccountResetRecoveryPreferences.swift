import ClaudexorKit
import Foundation

/// The engine owns durable receipts. Preferences retain only unresolved client
/// request identities and confirmed outcomes awaiting readback, without account snapshots.
@MainActor
struct AccountResetRecoveryPreferences {
    struct Entry: Codable {
        let key: String
        let body: ControlAccountResetRequest
        let location: ExecutionLocationID
        let label: String
        var receipt: ControlAccountResetResponse?
    }

    let load: () -> Data?
    let save: (Data?) -> Void

    static var standard: Self {
        let key = "claudexor.accounts.unresolvedResets"
        return Self(load: { UserDefaults.standard.data(forKey: key) }, save: { data in
            if let data { UserDefaults.standard.set(data, forKey: key) }
            else { UserDefaults.standard.removeObject(forKey: key) }
        })
    }
}
