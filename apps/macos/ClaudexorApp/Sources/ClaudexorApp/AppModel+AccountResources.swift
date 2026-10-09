import ClaudexorKit
import Foundation

extension AppModel {
    func loadAccountResourceCapabilities(
        client: GatewayClient, at location: ExecutionLocationID
    ) async -> AccountResourceCapabilities? {
        await accountResourceActions.loadCapabilities(client: client, at: location) { [weak self] in
            self?.isCurrentGateway(client, at: location) == true
        }
    }

    func accountResourceConnection(at location: ExecutionLocationID) -> AccountResourceConnection? {
        guard let requestClient = gateway(for: location) else { return nil }
        return AccountResourceConnection(location: location, client: requestClient,
            isCurrent: { [weak self] in self?.isCurrentGateway(requestClient, at: location) == true },
            displayGeneration: { [weak self] in self?.accountsQuotaDisplayGenerations[location] ?? 0 },
            accept: { [weak self] response, target, generation in
                guard let self else { return }
                // Reset/refresh responses retain all accounts server-side. Only
                // the addressed slice belongs to this request in the UI; never
                // replace another account's newer display with that older copy.
                let previous = self.quotaResponse(at: location)
                let merged = response.replacingAccount(target, in: previous,
                    preferPreviousOnTie: (self.accountsQuotaDisplayGenerations[location] ?? 0) != generation)
                self.accountsNextUpAuthorityFresh[location] = false
                guard merged != previous else { return }
                self.storeAccountsQuotaSnapshot(merged, at: location)
            })
    }
}
