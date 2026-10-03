import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

extension GatewayClient {
    /// File a thread into `folder` (nil = no folder) with a folder-only
    /// PATCH /threads/:id and return the updated thread. An engine older than
    /// thread folders refuses the field (`GatewayError.isThreadFolderUnsupported`).
    public func setThreadFolder(id: String, folder: String?) async throws -> ThreadSummary {
        var req = request("threads/\(id)", method: "PATCH")
        req.setValue("application/json", forHTTPHeaderField: "Content-Type")
        req.httpBody = try Self.encoder.encode(ThreadFolderUpdateRequest(folder: folder))
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadSummary.self, from: data)
    }
}
