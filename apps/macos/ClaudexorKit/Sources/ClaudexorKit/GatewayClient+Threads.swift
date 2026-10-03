import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

// MARK: - Thread lifecycle: trash → restore → purge
//
// The server-owned lifecycle routes (`POST /v2/threads/:id/trash|restore|purge`).
// Kept beside GatewayClient.swift (INV-124 readability ratchet). Each call
// returns the server's ThreadSummary; the app never invents lifecycle state.
extension GatewayClient {
    /// Move a thread into recoverable trash. It stays restorable until its
    /// `purgeAfter`; the engine purges it after that window.
    public func trashThread(id: String) async throws -> ThreadSummary {
        try await mutateThreadLifecycle(id: id, action: "trash")
    }

    /// Return a trashed thread to its pre-trash state (refused once the
    /// trash window has ended).
    public func restoreThread(id: String) async throws -> ThreadSummary {
        try await mutateThreadLifecycle(id: id, action: "restore")
    }

    /// Irreversibly purge a thread that is already in trash. The server
    /// refuses with 409 `thread_busy` while any turn of the thread is live.
    public func purgeThread(id: String) async throws -> ThreadSummary {
        try await mutateThreadLifecycle(id: id, action: "purge")
    }

    private func mutateThreadLifecycle(id: String, action: String) async throws -> ThreadSummary {
        let req = request("threads/\(id)/\(action)", method: "POST")
        let (data, resp) = try await session.data(for: req)
        guard let http = resp as? HTTPURLResponse, http.statusCode == 200 else {
            let status = (resp as? HTTPURLResponse)?.statusCode ?? -1
            throw GatewayError.http(status: status, body: String(decoding: data, as: UTF8.self))
        }
        return try Self.decoder.decode(ThreadSummary.self, from: data)
    }
}
