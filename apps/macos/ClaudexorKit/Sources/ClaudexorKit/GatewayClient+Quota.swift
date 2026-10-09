import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public extension GatewayClient {
    func quota(
        refresh: Bool = false,
        resources: Bool = false,
        target: AccountTarget? = nil
    ) async throws -> ControlQuotaResponse {
        var req = request("quota", method: refresh ? "POST" : "GET",
                          queryItems: resources ? [URLQueryItem(name: "view", value: "resources")] : [])
        if let target {
            guard refresh else { throw GatewayError.transport("Account refresh requires POST") }
            struct Body: Encodable { let target: AccountTarget }
            req.setValue("application/json", forHTTPHeaderField: "Content-Type")
            req.httpBody = try Self.encoder.encode(Body(target: target))
        }
        let (data, response) = try await session.data(for: req)
        guard let http = response as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (response as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        if resources {
            return try Self.decoder.decode(ControlAccountResourcesResponse.self, from: data).quota
        }
        return try Self.decoder.decode(ControlQuotaResponse.self, from: data)
    }
}
