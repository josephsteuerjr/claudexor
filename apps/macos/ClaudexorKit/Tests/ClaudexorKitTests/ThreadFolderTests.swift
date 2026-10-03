import Foundation
import Testing
@testable import ClaudexorKit

/// Thread folders on the client side: the folder-only PATCH, the name bound,
/// and the typed refusal of an engine that predates the `folder` field.
@Suite(.serialized) struct ThreadFolderTests {
    /// The refusal body a pre-folders engine sends for `{"folder": …}` (its
    /// strict PATCH schema normalized by the control-api request boundary).
    static let oldEngineRefusal = #"{"code":"invalid_request","message":"Request validation failed for 1 field.","retryable":false,"fieldErrors":{"/folder":["Unexpected field; not part of this request."]},"requiredActions":[],"evidenceRefs":[],"context":{"issueCount":1,"omittedIssueCount":0}}"#

    static let threadJSON = #"{"id":"th-1","title":"t","folder":"Research","repoRoot":"/p","mode":"agent","workspaceMode":"in_place","authPreference":"auto","primaryHarness":null,"eligibleHarnesses":[],"state":"active","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"t","updatedAt":"t"}"#

    private func client() -> GatewayClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FolderStubURLProtocol.self]
        return GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config))
    }

    @Test func setThreadFolderSendsOnlyTheFolderAndClearsWithAnExplicitNull() async throws {
        defer { FolderStubURLProtocol.handler = nil }
        nonisolated(unsafe) var seen: [(method: String?, path: String?, body: [String: Any])] = []
        FolderStubURLProtocol.handler = { request in
            let body = FolderStubURLProtocol.body(of: request)
                .flatMap { try? JSONSerialization.jsonObject(with: $0) as? [String: Any] } ?? [:]
            seen.append((request.httpMethod, request.url?.path, body))
            return (FolderStubURLProtocol.response(for: request, status: 200), Data(Self.threadJSON.utf8))
        }

        let moved = try await client().setThreadFolder(id: "th-1", folder: "Research")
        #expect(moved.folder == "Research")
        _ = try await client().setThreadFolder(id: "th-1", folder: nil)

        #expect(seen.count == 2)
        #expect(seen.allSatisfy { $0.method == "PATCH" && $0.path == "/v2/threads/th-1" })
        // Exactly one wire field: a folder move never carries title/state/routing.
        #expect(seen[0].body.count == 1 && seen[0].body["folder"] as? String == "Research")
        #expect(seen[1].body.count == 1 && seen[1].body["folder"] is NSNull)
    }

    @Test func aPreFoldersEngineRefusalIsTypedAndNothingElseIs() async throws {
        defer { FolderStubURLProtocol.handler = nil }
        FolderStubURLProtocol.handler = { request in
            (FolderStubURLProtocol.response(for: request, status: 400), Data(Self.oldEngineRefusal.utf8))
        }
        do {
            _ = try await client().setThreadFolder(id: "th-1", folder: "Research")
            Issue.record("a 400 must throw")
        } catch let error as GatewayError {
            #expect(error.isThreadFolderUnsupported)
        }

        // Other refusals keep their own meaning (the caller shows the engine's reason).
        let trashed = #"{"code":"thread_trashed","message":"thread th-1 is trashed","retryable":false}"#
        #expect(!GatewayError.http(status: 409, body: trashed).isThreadFolderUnsupported)
        let otherField = Self.oldEngineRefusal.replacingOccurrences(of: "/folder", with: "/title")
        #expect(!GatewayError.http(status: 400, body: otherField).isThreadFolderUnsupported)
        #expect(!GatewayError.http(status: 500, body: Self.oldEngineRefusal).isThreadFolderUnsupported)
        #expect(!GatewayError.http(status: 400, body: "not json").isThreadFolderUnsupported)
        #expect(!GatewayError.transport("offline").isThreadFolderUnsupported)
    }

    @Test func folderNameBoundMirrorsTheEngineSchema() {
        #expect(ThreadFolderName.normalized("  Research \n") == "Research")
        #expect(ThreadFolderName.normalized(" \t ") == nil)
        #expect(ThreadFolderName.normalized(String(repeating: "a", count: 120))?.count == 120)
        #expect(ThreadFolderName.normalized(String(repeating: "a", count: 121)) == nil)
        // The engine counts UTF-16 code units: 60 emoji fit, 61 do not.
        #expect(ThreadFolderName.normalized(String(repeating: "😀", count: 60)) != nil)
        #expect(ThreadFolderName.normalized(String(repeating: "😀", count: 61)) == nil)
    }
}

private final class FolderStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.badServerResponse))
            return
        }
        do {
            let (response, data) = try handler(request)
            client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
            client?.urlProtocol(self, didLoad: data)
            client?.urlProtocolDidFinishLoading(self)
        } catch {
            client?.urlProtocol(self, didFailWithError: error)
        }
    }

    override func stopLoading() {}

    static func response(for request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
    }

    /// URLSession moves a request body into `httpBodyStream` before the
    /// protocol sees it.
    static func body(of request: URLRequest) -> Data? {
        if let body = request.httpBody { return body }
        guard let stream = request.httpBodyStream else { return nil }
        stream.open()
        defer { stream.close() }
        var data = Data()
        var buffer = [UInt8](repeating: 0, count: 4096)
        while true {
            let count = stream.read(&buffer, maxLength: buffer.count)
            if count < 0 { return nil }
            if count == 0 { break }
            data.append(buffer, count: count)
        }
        return data
    }
}
