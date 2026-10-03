import Foundation
import Testing
@testable import ClaudexorApp

/// `installableRemoteHarnesses` is the app's one copy of the CLI's installable
/// set; it feeds the Settings install menu and the pre-flight guard. Read the
/// CLI SSOT itself so a harness the CLI can install never goes missing here.
@Suite struct RemoteInstallAllowlistTests {
    @Test func mirrorsTheCliInstallableHarnesses() throws {
        let repoRoot = URL(fileURLWithPath: #filePath)
            .deletingLastPathComponent()  // ClaudexorAppTests
            .deletingLastPathComponent()  // Tests
            .deletingLastPathComponent()  // ClaudexorApp
            .deletingLastPathComponent()  // macos
            .deletingLastPathComponent()  // apps
            .deletingLastPathComponent()  // repo root
        let source = try String(
            contentsOf: repoRoot.appendingPathComponent("packages/cli/src/harness-command-specs.ts"),
            encoding: .utf8)
        let start = try #require(source.range(of: "export const INSTALLABLE_HARNESSES = ["))
        let end = try #require(source.range(of: "] as const;", range: start.upperBound..<source.endIndex))
        let cliHarnesses = source[start.upperBound..<end.lowerBound]
            .split(separator: "\"", omittingEmptySubsequences: false)
            .enumerated()
            .filter { $0.offset % 2 == 1 }
            .map { String($0.element) }
        #expect(cliHarnesses.contains("copilot"))
        #expect(installableRemoteHarnesses == cliHarnesses)
    }

    /// A not-ready install names a step that exists: stored credentials for the
    /// families without a native login flow, the Login menu for the others.
    @Test func notReadyInstallNamesTheCredentialStepWithoutNativeLogin() {
        #expect(remoteInstallNextStep(harness: "copilot", displayName: "GitHub Copilot")
            == "Configure its provider credentials.")
        #expect(remoteInstallNextStep(harness: "opencode", displayName: "OpenCode")
            == "Configure its provider credentials.")
        #expect(remoteInstallNextStep(harness: "claude", displayName: "Claude") == "Use Login → Claude.")
    }
}
