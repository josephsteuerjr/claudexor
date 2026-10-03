/**
 * Thread folders: one optional, daemon-owned `folder` label per thread
 * (ThreadSummary.folder). This file holds the folder-move request body, the
 * name bound the app checks before sending, and the typed refusal of an engine
 * that predates folders.
 */
import Foundation

/// Body for a folder-only PATCH /threads/:id. `folder` is always encoded, so
/// nil sends an explicit JSON null (the thread leaves its folder). The engine
/// treats a folder-only PATCH as filing, not activity: the thread keeps its
/// `updatedAt`, so list order and the CLI `--resume` target do not change.
public struct ThreadFolderUpdateRequest: Encodable, Sendable, Equatable {
    public var folder: String?

    public init(folder: String?) {
        self.folder = folder
    }

    enum CodingKeys: String, CodingKey { case folder }

    public func encode(to encoder: Encoder) throws {
        var c = encoder.container(keyedBy: CodingKeys.self)
        try c.encode(folder, forKey: .folder)  // nil encodes an explicit null
    }
}

/// The folder-name bound of the engine's `ThreadFolderName` schema: trimmed,
/// 1...120 characters counted as UTF-16 code units, as the engine counts them.
public enum ThreadFolderName {
    public static let maxLength = 120

    /// The trimmed name the engine will store, or nil when it is empty or longer
    /// than `maxLength`.
    public static func normalized(_ raw: String) -> String? {
        let name = raw.trimmingCharacters(in: .whitespacesAndNewlines)
        return (1...maxLength).contains(name.utf16.count) ? name : nil
    }
}

extension GatewayError {
    /// True when the engine refused a thread PATCH because it does not know the
    /// `folder` field: an engine older than thread folders answers its strict
    /// request validation with a 400 that points at `/folder`. A folder-aware
    /// engine points there only for an empty or over-long name, which the app
    /// never sends (`ThreadFolderName.normalized`).
    public var isThreadFolderUnsupported: Bool {
        guard case .http(400, _) = self, let problem = controlProblem else { return false }
        return problem.code == "invalid_request" && problem.fieldErrors["/folder"] != nil
    }
}
