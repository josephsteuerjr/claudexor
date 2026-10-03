import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// Thread folders in the app: the zero-folder list stays flat, one name on two
/// engines is one section, a folder rename/remove leaves trashed threads alone,
/// and an engine that predates folders gets a plain update hint.
@Suite(.serialized) struct ThreadFolderAppTests {
    static func thread(_ id: String, folder: String?, state: String = "active") throws -> ThreadSummary {
        let folderJSON = folder.map { "\"\($0)\"" } ?? "null"
        let json = #"{"id":"\#(id)","title":"\#(id)","folder":\#(folderJSON),"repoRoot":"/p","mode":"agent","workspaceMode":"in_place","authPreference":"auto","primaryHarness":null,"eligibleHarnesses":[],"state":"\#(state)","trashedAt":null,"purgeAfter":null,"runIds":[],"headRunId":null,"needsHuman":false,"createdAt":"2026-10-01T00:00:00Z","updatedAt":"2026-10-01T00:00:00Z"}"#
        return try JSONDecoder().decode(ThreadSummary.self, from: Data(json.utf8))
    }

    static func local(_ id: String, folder: String?, state: String = "active") throws -> LocatedThread {
        LocatedThread(locationID: .local, thread: try thread(id, folder: folder, state: state))
    }

    @Test func withoutFoldersTheListHasNoSections() throws {
        let threads = [try Self.local("a", folder: nil), try Self.local("b", folder: nil)]
        #expect(ThreadFolderSection.sections(for: threads).isEmpty)
        #expect(ThreadFolderSection.sections(for: []).isEmpty)
    }

    @Test func foldersAreSortedSectionsAndOneNameOnTwoEnginesIsOneSection() throws {
        let remote = ExecutionLocationID.remote(UUID())
        let threads = [
            try Self.local("newest", folder: nil),
            try Self.local("r1", folder: "research"),
            LocatedThread(locationID: remote, thread: try Self.thread("r2", folder: "research")),
            try Self.local("s1", folder: "Shipping"),
        ]
        let sections = ThreadFolderSection.sections(for: threads)
        #expect(sections.map(\.folder) == ["research", "Shipping", nil])
        #expect(sections[0].threads.map(\.thread.id) == ["r1", "r2"])
        #expect(sections[2].threads.map(\.thread.id) == ["newest"])
        // "Ungrouped" appears only when some thread has no folder.
        let filed = Array(threads.dropFirst())
        #expect(ThreadFolderSection.sections(for: filed).map(\.folder) == ["research", "Shipping"])
    }

    @Test func folderRenameAndRemoveLeaveTrashedThreadsAlone() throws {
        let members = [
            try Self.local("live", folder: "A"),
            try Self.local("archived", folder: "A", state: "closed"),
            try Self.local("binned", folder: "A", state: "trashed"),
        ]
        #expect(AppModel.threadsToRefile(members).map(\.thread.id) == ["live", "archived"])
    }

    @MainActor
    @Test func aSuccessfulRetryClearsTheEarlierPartialFailureBanner() async throws {
        defer { FolderAppStubURLProtocol.handler = nil }
        FolderAppStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "PATCH", path.hasPrefix("/v2/threads/") {
                let id = String(path.dropFirst("/v2/threads/".count))
                let body = try JSONEncoder().encode(try Self.thread(id, folder: "B"))
                return (FolderAppStubURLProtocol.response(request, status: 200), body)
            }
            let list = #"{"threads":[],"problems":[]}"#
            return (FolderAppStubURLProtocol.response(request, status: 200), Data(list.utf8))
        }
        let model = AppModel(client: FolderAppStubURLProtocol.client(), requestNotificationAuthorization: false)
        model.threads = [try Self.thread("a1", folder: "A"), try Self.thread("a2", folder: "A")]
        model.threadStatus = "Updated 1 of 2 threads; 1 failed."

        await model.renameThreadFolder("A", to: "B")

        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func renamingAFolderRefilesOnlyLiveMembersWithoutAFailureReport() async throws {
        defer { FolderAppStubURLProtocol.handler = nil }
        nonisolated(unsafe) var patched: [String] = []
        FolderAppStubURLProtocol.handler = { request in
            let path = request.url?.path ?? ""
            if request.httpMethod == "PATCH", path.hasPrefix("/v2/threads/") {
                let id = String(path.dropFirst("/v2/threads/".count))
                patched.append(id)
                let body = try JSONEncoder().encode(try Self.thread(id, folder: "C"))
                return (FolderAppStubURLProtocol.response(request, status: 200), body)
            }
            let list = #"{"threads":[],"problems":[]}"#
            return (FolderAppStubURLProtocol.response(request, status: 200), Data(list.utf8))
        }
        let model = AppModel(client: FolderAppStubURLProtocol.client(), requestNotificationAuthorization: false)
        model.threads = [
            try Self.thread("a1", folder: "A"),
            try Self.thread("a2", folder: "A", state: "trashed"),
            try Self.thread("b1", folder: "B"),
        ]

        await model.renameThreadFolder("A", to: "C")

        #expect(patched == ["a1"])
        #expect(model.threadStatus == nil)
    }

    @MainActor
    @Test func aPreFoldersEngineReadsAsAnUpdateHintAndOtherRefusalsKeepTheirReason() async throws {
        defer { FolderAppStubURLProtocol.handler = nil }
        nonisolated(unsafe) var answer = (status: 400, body: #"{"code":"invalid_request","message":"Request validation failed for 1 field.","retryable":false,"fieldErrors":{"/folder":["Unexpected field; not part of this request."]},"requiredActions":[],"evidenceRefs":[],"context":{"issueCount":1,"omittedIssueCount":0}}"#)
        FolderAppStubURLProtocol.handler = { request in
            (FolderAppStubURLProtocol.response(request, status: answer.status), Data(answer.body.utf8))
        }
        let model = AppModel(client: FolderAppStubURLProtocol.client(), requestNotificationAuthorization: false)
        model.threads = [try Self.thread("t1", folder: nil)]

        await model.setThreadFolder(locationID: .local, id: "t1", folder: "Research")
        #expect(model.threadStatus == "The engine is too old for folders. Update Claudexor.")

        answer = (409, #"{"code":"thread_trashed","message":"thread t1 is trashed","retryable":false}"#)
        await model.setThreadFolder(locationID: .local, id: "t1", folder: "Research")
        #expect(model.threadStatus == "Request failed (HTTP 409, thread_trashed): thread t1 is trashed")
    }
}

private final class FolderAppStubURLProtocol: URLProtocol {
    nonisolated(unsafe) static var handler: ((URLRequest) throws -> (HTTPURLResponse, Data))?

    static func client() -> GatewayClient {
        let config = URLSessionConfiguration.ephemeral
        config.protocolClasses = [FolderAppStubURLProtocol.self]
        return GatewayClient(
            baseURL: URL(string: "http://127.0.0.1:1234")!, token: "t",
            session: URLSession(configuration: config))
    }

    static func response(_ request: URLRequest, status: Int) -> HTTPURLResponse {
        HTTPURLResponse(
            url: request.url!, statusCode: status, httpVersion: "HTTP/1.1",
            headerFields: ["Content-Type": "application/json"])!
    }

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
}
