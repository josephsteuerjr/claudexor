import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

@Suite @MainActor struct ThreadWorkspaceRootTests {
    private func thread(
        mode: String? = "delegated", repoRoot: String? = "/author",
        workspaceRoot: String? = "/workspace"
    ) throws -> ThreadSummary {
        var json: [String: Any] = [
            "id": "t", "runIds": [], "needsHuman": false,
            "createdAt": "2026-10-08T00:00:00Z", "updatedAt": "2026-10-08T00:00:00Z",
        ]
        json["workspaceMode"] = mode
        json["repoRoot"] = repoRoot
        json["workspaceRoot"] = workspaceRoot
        return try JSONDecoder().decode(
            ThreadSummary.self, from: JSONSerialization.data(withJSONObject: json))
    }

    @Test func terminalUsesBoundWorkspaceEvenWithoutProjectPath() throws {
        #expect(ThreadWorkspacePanel.executionRoot(for: try thread()) == "/workspace")
        #expect(ThreadWorkspacePanel.executionRoot(for: try thread(repoRoot: nil)) == "/workspace")
    }

    @Test(arguments: [nil, ""] as [String?])
    func missingDelegatedBindingNeverFallsBackToProject(workspaceRoot: String?) throws {
        let thread = try thread(workspaceRoot: workspaceRoot)
        #expect(ThreadWorkspacePanel.executionRoot(for: thread) == nil)
        #expect(ThreadWorkspacePanel.localPreview(for: thread) == .missingWorkspace)
    }

    @Test(arguments: [nil, "in_place", "isolated"] as [String?])
    func ordinaryThreadRootBehaviorIsPreserved(mode: String?) throws {
        #expect(ThreadWorkspacePanel.executionRoot(
            for: try thread(mode: mode, workspaceRoot: nil)) == "/author")
    }

    @Test func noProjectHasNoPreview() throws {
        let thread = try thread(mode: nil, repoRoot: nil, workspaceRoot: nil)
        #expect(ThreadWorkspacePanel.executionRoot(for: thread) == nil)
        #expect(ThreadWorkspacePanel.localPreview(for: thread) == .absent)
    }

    @Test func previewReadsOnlyTheBoundWorkspaceAndReportsItsRemoval() throws {
        let fixture = FileManager.default.temporaryDirectory.appendingPathComponent(UUID().uuidString)
        defer { try? FileManager.default.removeItem(at: fixture) }
        let author = fixture.appendingPathComponent("author")
        let workspace = fixture.appendingPathComponent("workspace")
        try FileManager.default.createDirectory(at: author, withIntermediateDirectories: true)
        try FileManager.default.createDirectory(at: workspace, withIntermediateDirectories: true)
        try Data("author output".utf8).write(to: author.appendingPathComponent("index.html"))
        let thread = try thread(repoRoot: author.path, workspaceRoot: workspace.path)

        // A project preview cannot substitute for absent workspace output.
        #expect(ThreadWorkspacePanel.localPreview(for: thread) == .absent)
        try Data("workspace output".utf8).write(to: workspace.appendingPathComponent("index.html"))
        #expect(ThreadWorkspacePanel.localPreview(for: thread) == .available(root: workspace.path))
        try FileManager.default.removeItem(at: author)
        #expect(ThreadWorkspacePanel.localPreview(for: thread) == .available(root: workspace.path))

        try FileManager.default.createDirectory(at: author, withIntermediateDirectories: true)
        try Data("author output".utf8).write(to: author.appendingPathComponent("index.html"))
        try FileManager.default.removeItem(at: workspace)
        #expect(ThreadWorkspacePanel.localPreview(for: thread) == .missingWorkspace)
    }

    private struct ImageFixture {
        let base: String
        var author: String { base + "/author" }
        var workspace: String { base + "/workspace" }
        var runDir: String { base + "/run" }

        init() throws {
            base = NSTemporaryDirectory() + "delegated-images-" + UUID().uuidString
            for dir in ["author/shots", "workspace/shots", "run"] {
                try FileManager.default.createDirectory(
                    atPath: base + "/" + dir, withIntermediateDirectories: true)
            }
        }

        func write(_ text: String, to path: String) throws {
            try Data(text.utf8).write(to: URL(fileURLWithPath: path))
        }
    }

    /// The roots a turn card in this thread scopes its answer and transcript to.
    private func turnScope(_ thread: ThreadSummary, runDir: String) -> [String] {
        TurnCard.fileScopeRoots(
            executionRoot: ThreadWorkspacePanel.executionRoot(for: thread), runDir: runDir)
    }

    @Test func changedImagesAndTurnLinksReadWorkspaceBytesNotSameNamedAuthorFiles() throws {
        let fixture = try ImageFixture()
        defer { try? FileManager.default.removeItem(atPath: fixture.base) }
        try fixture.write("author bytes", to: fixture.author + "/shots/action.png")
        try fixture.write("workspace bytes", to: fixture.workspace + "/shots/action.png")
        let thread = try thread(repoRoot: fixture.author, workspaceRoot: fixture.workspace)
        let root = ThreadWorkspacePanel.executionRoot(for: thread)

        // Two runs touching the same image show it once, from the workspace,
        // carried by the first run that changed it.
        let local = ArtifactGalleryView.changedImages(
            runs: [("run-1", ["shots/action.png"]), ("run-2", ["shots/action.png"])],
            executionRoot: root)
        #expect(local.map(\.runID) == ["run-1"])
        let shown = try #require(local.first?.path)
        #expect(try Data(contentsOf: URL(fileURLWithPath: shown)) == Data("workspace bytes".utf8))
        let scope = turnScope(thread, runDir: fixture.runDir)
        #expect(ScopedInlineImage.scopedImagePath(
            fixture.workspace + "/shots/action.png", roots: scope) != nil)
        #expect(ScopedInlineImage.scopedImagePath(
            fixture.author + "/shots/action.png", roots: scope) == nil)
        // Remote retrieval stays relative to the workspace; an author path never maps.
        #expect(ArtifactGalleryView.changedImages(
            runs: [("run-1", ["shots/action.png", fixture.author + "/shots/action.png"])],
            executionRoot: root, locationID: .remote(UUID())).map(\.path) == ["shots/action.png"])
        let workspaceRoot = try #require(root)
        #expect(AppModel.containedProjectRelativePath(
            target: fixture.author + "/shots/action.png", repoRoot: workspaceRoot) == nil)
    }

    @Test func workspaceOnlyImageResolvesWithoutAnAuthorCopy() throws {
        let fixture = try ImageFixture()
        defer { try? FileManager.default.removeItem(atPath: fixture.base) }
        try fixture.write("workspace only", to: fixture.workspace + "/shots/new.png")
        let root = ThreadWorkspacePanel.executionRoot(
            for: try thread(repoRoot: fixture.author, workspaceRoot: fixture.workspace))

        let paths = ArtifactGalleryView.changedImages(
            runs: [("run-1", ["shots/new.png"])], executionRoot: root)
        #expect(paths.count == 1)
        let shown = try #require(paths.first?.path)
        #expect(try Data(contentsOf: URL(fileURLWithPath: shown)) == Data("workspace only".utf8))
        // The project identity has no such file; resolving there would show nothing.
        #expect(ArtifactGalleryView.changedImages(
            runs: [("run-1", ["shots/new.png"])], executionRoot: fixture.author).isEmpty)
    }

    @Test(arguments: [nil, ""] as [String?])
    func missingWorkspaceNeverFallsBackToAuthorImages(workspaceRoot: String?) throws {
        let fixture = try ImageFixture()
        defer { try? FileManager.default.removeItem(atPath: fixture.base) }
        try fixture.write("author bytes", to: fixture.author + "/shots/action.png")
        let thread = try thread(repoRoot: fixture.author, workspaceRoot: workspaceRoot)
        let root = ThreadWorkspacePanel.executionRoot(for: thread)

        #expect(root == nil)
        #expect(ArtifactGalleryView.changedImages(
            runs: [("run-1", ["shots/action.png"])], executionRoot: root).isEmpty)
        #expect(ArtifactGalleryView.changedImages(
            runs: [("run-1", ["shots/action.png"])], executionRoot: root,
            locationID: .remote(UUID())).isEmpty)
        #expect(turnScope(thread, runDir: fixture.runDir) == [fixture.runDir])
        #expect(ScopedInlineImage.scopedImagePath(
            fixture.author + "/shots/action.png",
            roots: turnScope(thread, runDir: fixture.runDir)) == nil)
    }
}
