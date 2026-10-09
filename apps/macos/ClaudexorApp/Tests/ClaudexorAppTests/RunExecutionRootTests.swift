import ClaudexorKit
import Foundation
import Testing
@testable import ClaudexorApp

/// Run Detail surfaces (outcome answer, retained output, artifact previews)
/// and remote image retrieval resolve a run's files in the execution root its
/// summary projects, addressed through the stable project identity — never in
/// the project's same-named files, and never by falling back to it when absent.
@Suite @MainActor struct RunExecutionRootTests {
    private struct Fixture {
        let base: String
        var author: String { base + "/author" }
        var copy: String { base + "/copy" }
        var runDir: String { base + "/run" }

        init() throws {
            base = NSTemporaryDirectory() + "run-execution-root-" + UUID().uuidString
            for dir in ["author/shots", "copy/shots", "run"] {
                try FileManager.default.createDirectory(
                    atPath: base + "/" + dir, withIntermediateDirectories: true)
            }
            try write("author bytes", to: author + "/shots/action.png")
            try write("copy bytes", to: copy + "/shots/action.png")
            try write("copy only", to: copy + "/shots/new.png")
        }

        func write(_ text: String, to path: String) throws {
            try Data(text.utf8).write(to: URL(fileURLWithPath: path))
        }
    }

    private func task(project: String?, executionRoot: String?, runDir: String) throws -> TaskRun {
        var json: [String: Any] = ["runId": "run-del", "state": "succeeded", "runDir": runDir]
        if let project {
            json["project"] = ["kind": "project", "root": project, "context": "auto"]
        }
        json["executionRoot"] = executionRoot
        return AppModel.liveTask(from: try JSONDecoder().decode(
            RunSummary.self, from: JSONSerialization.data(withJSONObject: json)))
    }

    private func bytes(_ path: String?) throws -> Data {
        try Data(contentsOf: URL(fileURLWithPath: try #require(path)))
    }

    @Test func runDetailScopeReadsCopyBytesNotSameNamedAuthorFiles() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(atPath: fixture.base) }
        let run = try task(project: fixture.author, executionRoot: fixture.copy, runDir: fixture.runDir)

        #expect(run.repoRoot == fixture.author)
        #expect(run.fileScopeRoots == [fixture.copy, fixture.runDir])
        #expect(try bytes(ScopedInlineImage.scopedImagePath(
            fixture.copy + "/shots/action.png", roots: run.fileScopeRoots)) == Data("copy bytes".utf8))
        #expect(try bytes(ScopedInlineImage.scopedImagePath(
            fixture.copy + "/shots/new.png", roots: run.fileScopeRoots)) == Data("copy only".utf8))
        #expect(ScopedInlineImage.scopedImagePath(
            fixture.author + "/shots/action.png", roots: run.fileScopeRoots) == nil)
        // File links: the copy previews, the same-named author file is refused.
        guard case .preview(let path, _) = MarkdownOutputView.localFileAction(
            fixture.copy + "/shots/action.png", roots: run.fileScopeRoots)
        else { Issue.record("a copy file link must preview"); return }
        #expect(try bytes(path) == Data("copy bytes".utf8))
        guard case .refuse = MarkdownOutputView.localFileAction(
            fixture.author + "/shots/action.png", roots: run.fileScopeRoots)
        else { Issue.record("an author file link must be refused in a delegated run's scope"); return }
    }

    @Test(arguments: [true, false])
    func absentBindingNeverFallsBackToTheProject(projectKnown: Bool) throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(atPath: fixture.base) }
        let run = try task(
            project: projectKnown ? fixture.author : nil, executionRoot: nil, runDir: fixture.runDir)

        #expect(run.fileScopeRoots == [fixture.runDir])
        #expect(ScopedInlineImage.scopedImagePath(
            fixture.author + "/shots/action.png", roots: run.fileScopeRoots) == nil)
        let remote = AppModel.remoteFileReference(
            target: "shots/action.png", scope: run.remoteFileScope, projects: [project(fixture.author)])
        #expect(remote == nil)
    }

    private func project(_ root: String, id: String = "prj-1") -> RegisteredProject {
        RegisteredProject(schemaVersion: 3, id: id, root: root, createdAt: "", updatedAt: "")
    }

    @Test func remoteReferenceKeepsProjectIdentityAndCarriesTheRunBinding() throws {
        let scope = RemoteFileScope(runID: "run-del", projectRoot: "/author", executionRoot: "/copy")
        // Only the project is registered: the workspace needs no registration.
        let projects = [project("/author")]
        let absolute = try #require(AppModel.remoteFileReference(
            target: "/copy/shots/action.png", scope: scope, projects: projects))
        #expect(absolute.projectID == "prj-1")
        #expect(absolute.relativePath == "shots/action.png")
        #expect(absolute.runID == "run-del")
        let relative = try #require(AppModel.remoteFileReference(
            target: "shots/new.png", scope: scope, projects: projects))
        #expect(relative.relativePath == "shots/new.png")
        #expect(relative.runID == "run-del")
        // An author path is outside the run's tree; a tree without its run maps nowhere.
        #expect(AppModel.remoteFileReference(
            target: "/author/shots/action.png", scope: scope, projects: projects) == nil)
        #expect(AppModel.remoteFileReference(
            target: "shots/action.png",
            scope: RemoteFileScope(runID: nil, projectRoot: "/author", executionRoot: "/copy"),
            projects: projects) == nil)
        // A workspace registered as some other project does not stand in for the identity.
        #expect(AppModel.remoteFileReference(
            target: "shots/action.png", scope: scope, projects: [project("/copy", id: "prj-copy")]) == nil)
    }

    @Test func ordinaryRunsKeepTheUnboundProjectRequest() throws {
        let reference = try #require(AppModel.remoteFileReference(
            target: "/author/shots/action.png",
            scope: RemoteFileScope(runID: "run-1", projectRoot: "/author", executionRoot: "/author"),
            projects: [project("/author")]))
        #expect(reference.projectID == "prj-1")
        #expect(reference.relativePath == "shots/action.png")
        #expect(reference.runID == nil)
    }

    @Test func turnScopeUsesTheThreadTreeAndTheRunsProject() throws {
        let fixture = try Fixture()
        defer { try? FileManager.default.removeItem(atPath: fixture.base) }
        let run = try task(project: fixture.author, executionRoot: fixture.copy, runDir: fixture.runDir)
        #expect(TurnCard.remoteFileScope(run, executionRoot: fixture.copy)
            == RemoteFileScope(runID: "run-del", projectRoot: fixture.author, executionRoot: fixture.copy))
        #expect(run.remoteFileScope
            == RemoteFileScope(runID: "run-del", projectRoot: fixture.author, executionRoot: fixture.copy))
    }
}
