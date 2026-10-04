import AppKit
import SwiftUI
import Testing
@testable import ClaudexorApp

/// Hosts the shared actual chat/Outcome content without starting the application.
@MainActor @Suite(.serialized)
struct RetainedOutputRenderingTests {
    @Test(.enabled(if: ProcessInfo.processInfo.environment["CX_RETAINED_RENDER_QA"] == "1"))
    func retainedMarkdownRendersWithTerminalCauseAndArtifactAction() async throws {
        let application = NSApplication.shared
        let policy = application.activationPolicy()
        application.setActivationPolicy(.prohibited)
        defer { application.setActivationPolicy(policy) }
        var task = TaskRun(
            id: "run-retained", title: "Retained review", prompt: "Review the files",
            mode: .agent, phase: .failed, project: "Fixture", harnesses: [], n: 1,
            createdAt: .now, updatedAt: .now, spendUsd: 0, capUsd: 0,
            routeProof: .unverified, attentionNote: nil, plan: [], activity: [],
            candidates: [], findings: [], diff: [])
        task.outputReadyState = "diagnostic"
        task.outcomeBanner = "Failed"
        task.engineError = "The native connection closed before completion."
        task.answerText = """
        ## Attempt a01 · Cursor

        ### Review progress

        - Checked **four of six** files.
        - Found a missing error handler in `save()`.

        ```typescript
        await save(result);
        ```
        """
        task.primaryOutputPath = "final/retained-output.md"
        task.primaryOutputTruncated = true
        task.capturedArtifactPaths = ["attempts/a01/produced/screenshot.png"]
        #expect(task.hasRetainedOutput)
        var opened = false
        let host = NSHostingView(rootView: AnyView(
            RetainedOutputContent(task: task) { _ in opened = true }
                .padding(24).frame(width: 760, alignment: .topLeading)
                .background(Color(nsColor: .windowBackgroundColor))))
        let window = NSWindow(contentRect: NSRect(x: 0, y: 0, width: 760, height: 700),
                              styleMask: [.borderless], backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.contentView = host
        host.frame = NSRect(x: 0, y: 0, width: 760, height: 700)
        defer { window.close() }
        for (name, appearance) in [("light", NSAppearance.Name.aqua), ("dark", .darkAqua)] {
            host.appearance = NSAppearance(named: appearance)
            host.layoutSubtreeIfNeeded()
            try await Task.sleep(for: .milliseconds(150))
            host.displayIfNeeded()
            let bitmap = try #require(host.bitmapImageRepForCachingDisplay(in: host.bounds))
            host.cacheDisplay(in: host.bounds, to: bitmap)
            let png = try #require(bitmap.representation(using: .png, properties: [:]))
            if let root = ProcessInfo.processInfo.environment["CX_RETAINED_RENDER_OUTPUT"] {
                let directory = URL(fileURLWithPath: root, isDirectory: true)
                try FileManager.default.createDirectory(at: directory, withIntermediateDirectories: true)
                try png.write(to: directory.appendingPathComponent("retained-\(name).png"))
            }
        }
        func buttons(_ view: NSView) -> [NSButton] {
            (view as? NSButton).map { [$0] } ?? view.subviews.flatMap(buttons)
        }
        if let open = buttons(host).first(where: { $0.title == "Open saved output" }) {
            open.performClick(nil)
            #expect(opened)
        }
        // Visual PNG inspection qualifies layout. Some unshown SwiftUI hosts
        // omit native buttons; do not claim that case exercised the click.
    }
}
