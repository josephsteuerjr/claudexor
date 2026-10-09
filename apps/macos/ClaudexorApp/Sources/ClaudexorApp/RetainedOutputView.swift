import SwiftUI
import ClaudexorKit

extension TaskRun {
    mutating func adoptPrimaryOutput(_ detail: RunDetail) {
        primaryOutputPath = detail.primaryOutput?.path
        primaryOutputTruncated = detail.primaryOutput?.truncated == true
        capturedArtifactPaths = detail.artifacts.filter {
            $0.kind == "file" && $0.path.hasPrefix("attempts/") && $0.path.contains("/produced/")
        }.map(\.path)
    }

    var hasRetainedOutput: Bool {
        phase.isTerminal && outputReadyState == "diagnostic" &&
            !(answerText ?? "").trimmingCharacters(in: .whitespacesAndNewlines).isEmpty
    }
}

/// Shared chat/Outcome content: the real terminal cause precedes the retained text.
struct RetainedOutputContent: View {
    let task: TaskRun
    let openArtifact: (String) -> Void
    @State private var expanded = false

    var body: some View {
        VStack(alignment: .leading, spacing: Theme.Spacing.sm) {
            Label(task.outcomeBanner ?? RunReasonLabel.label(task.outcomeFacts?.reason) ?? task.phase.label,
                  systemImage: "exclamationmark.triangle")
                .font(.headline).foregroundStyle(Theme.status(.caution))
            if let error = task.engineError, !error.isEmpty {
                Text(error).font(.caption).foregroundStyle(.secondary).textSelection(.enabled)
            }
            Text("Unverified retained output")
                .font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            let text = task.answerText ?? ""
            MarkdownOutputView(markdown: expanded ? text : String(text.prefix(4_000)),
                               fileScopeRoots: task.fileScopeRoots,
                               remoteFileScope: task.remoteFileScope,
                               bodyFont: .body)
            if text.count > 4_000 {
                Button(expanded ? "Show less" : "Show more") { expanded.toggle() }
                    .buttonStyle(.borderless).font(.caption)
            }
            if task.primaryOutputTruncated || text.count > MarkdownOutputView.renderCharCap {
                Text("Inline preview is limited. The saved artifact contains the recorded output.")
                    .font(.caption).foregroundStyle(.secondary)
            }
            if let path = task.primaryOutputPath {
                Button("Open saved output") { openArtifact(path) }.buttonStyle(.link)
                Text(path).font(.caption.monospaced()).foregroundStyle(.secondary).textSelection(.enabled)
            }
            ForEach(task.capturedArtifactPaths, id: \.self) { path in
                Button("Open captured file: \(path)") { openArtifact(path) }
                    .buttonStyle(.link).font(.caption)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }
}

struct RetainedOutputView: View {
    @Environment(AppModel.self) private var model
    let task: TaskRun
    let locationID: ExecutionLocationID
    @State private var showingArtifact = false
    @State private var preview: LoadState<SafeFilePreviewRequest> = .idle
    @State private var selectedPath = ""

    var body: some View {
        RetainedOutputContent(task: task) { path in
            selectedPath = path
            showingArtifact = true
            Task { await loadArtifact(path) }
        }
        .sheet(isPresented: $showingArtifact) {
            ArtifactPreviewSheet(state: preview, path: selectedPath) {
                Task { await loadArtifact(selectedPath) }
            }
        }
    }

    private func loadArtifact(_ path: String) async {
        preview = .loading
        do {
            let request = try await stagedArtifactPreview(
                model: model, locationID: locationID,
                runId: task.resolvedRunId ?? task.id, path: path, produced: false)
            if selectedPath == path { preview = .loaded(request) }
        } catch {
            if selectedPath == path {
                preview = .failed(error as? PayloadError ?? .notRenderable("\(path): \(error.localizedDescription)"))
            }
        }
    }
}
