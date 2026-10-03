import Foundation
import Testing
@testable import ClaudexorKit

/// GatewayClient's thread lifecycle commands (GatewayClient+Threads.swift).
/// Own stub protocol and a serialized suite: the shared request stub of the
/// other suites is a static, so parallel tests must never share it.
@Suite(.serialized)
struct ThreadLifecycleClientTests {
    /// Each lifecycle command posts exactly its own server route and returns
    /// the server's projection (the call-order contract kept from #349:
    /// Delete = trash, Restore = restore, Delete Now = purge; never chained).
    @Test func threadLifecycleCommandsPostOnlyTheirOwnRoute() async throws {
        let recorder = LifecycleRequestRecorder()
        LifecycleClientStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            recorder.append("\(request.httpMethod ?? "") \(path)")
            let state = path.hasSuffix("/trash") ? "trashed" : path.hasSuffix("/purge") ? "purged" : "active"
            let body = #"{"id":"th-1","title":"Delete me","repoRoot":"/tmp/project","mode":"agent","workspaceMode":"in_place","authPreference":"auto","primaryHarness":null,"eligibleHarnesses":[],"state":"\#(state)","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-09-24T00:00:00Z","updatedAt":"2026-09-24T00:00:00Z"}"#
            return (Self.response(request, status: 200), Data(body.utf8))
        }
        defer { LifecycleClientStubURLProtocol.handler = nil }
        let client = Self.client()

        #expect(try await client.trashThread(id: "th-1").state == "trashed")
        #expect(try await client.restoreThread(id: "th-1").state == "active")
        #expect(try await client.purgeThread(id: "th-1").state == "purged")
        #expect(recorder.entries == [
            "POST /v2/threads/th-1/trash",
            "POST /v2/threads/th-1/restore",
            "POST /v2/threads/th-1/purge",
        ])
    }

    /// A purge the engine refuses (409 while any turn of the thread runs)
    /// surfaces the typed problem and makes no further request.
    @Test func threadPurgeRefusalCarriesTheTypedBusyProblem() async throws {
        let recorder = LifecycleRequestRecorder()
        LifecycleClientStubURLProtocol.handler = { request in
            recorder.append(request.url?.path ?? "")
            return (
                Self.response(request, status: 409),
                Data(#"{"code":"thread_busy","message":"thread th-1 has an active turn (running)","retryable":false}"#.utf8))
        }
        defer { LifecycleClientStubURLProtocol.handler = nil }
        do {
            _ = try await Self.client().purgeThread(id: "th-1")
            Issue.record("a refused purge must throw")
        } catch let error as GatewayError {
            guard case .http(let status, _) = error else {
                Issue.record("expected an HTTP refusal, got \(error)")
                return
            }
            #expect(status == 409)
            #expect(error.controlProblem?.code == "thread_busy")
        }
        #expect(recorder.entries == ["/v2/threads/th-1/purge"])
    }

    private static func client() -> GatewayClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [LifecycleClientStubURLProtocol.self]
        return GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config))
    }

    private static func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
    }
}

private final class LifecycleRequestRecorder: @unchecked Sendable {
    private let lock = NSLock()
    private var recorded: [String] = []

    func append(_ entry: String) { lock.withLock { recorded.append(entry) } }
    var entries: [String] { lock.withLock { recorded } }
}

private final class LifecycleClientStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) -> (HTTPURLResponse, Data))?

    override class func canInit(with request: URLRequest) -> Bool { true }
    override class func canonicalRequest(for request: URLRequest) -> URLRequest { request }

    override func startLoading() {
        guard let handler = Self.handler else {
            client?.urlProtocol(self, didFailWithError: URLError(.cannotConnectToHost))
            return
        }
        let (response, data) = handler(request)
        client?.urlProtocol(self, didReceive: response, cacheStoragePolicy: .notAllowed)
        client?.urlProtocol(self, didLoad: data)
        client?.urlProtocolDidFinishLoading(self)
    }

    override func stopLoading() {}
}
