import Foundation
import Testing
@testable import ClaudexorApp

// The engine names its heap ceiling in `claudexord --probe` (`launch.nodeArgs`);
// the app launcher passes it unchanged unless the operator already chose one.
@Suite struct DaemonLauncherHeapTests {
    private func probe(_ nodeArgs: Any) -> [String: Any] {
        ["version": "3.22.1", "buildSha": String(repeating: "a", count: 40),
         "launch": ["nodeArgs": nodeArgs, "basis": ["memoryBytes": 137_438_953_472, "source": "physical"]]]
    }

    @Test func passesTheEngineNamedCeiling() {
        let args = DaemonLauncher.heapNodeArguments(
            probe: probe(["--max-old-space-size=16384"]), environment: ["PATH": "/usr/bin"])
        #expect(args == ["--max-old-space-size=16384"])
    }

    @Test func operatorNodeOptionsWin() {
        let args = DaemonLauncher.heapNodeArguments(
            probe: probe(["--max-old-space-size=16384"]),
            environment: ["NODE_OPTIONS": "--max-old-space-size=8192"])
        #expect(args.isEmpty)
    }

    @Test func olderEngineWithoutLaunchStartsAsBefore() {
        let legacy: [String: Any] = ["version": "3.22.0", "buildSha": String(repeating: "b", count: 40)]
        #expect(DaemonLauncher.heapNodeArguments(probe: legacy, environment: [:]).isEmpty)
        #expect(DaemonLauncher.heapNodeArguments(probe: nil, environment: [:]).isEmpty)
        #expect(DaemonLauncher.heapNodeArguments(probe: probe([String]()), environment: [:]).isEmpty)
    }

    @Test func anyOtherArgumentDropsTheList() {
        for bad: Any in [
            ["--max-old-space-size=16384", "--inspect"],
            ["--max-old-space-size=99"],
            ["--max-old-space-size=1234567"],
            ["--max-old-space-size=16k84"],
            ["--max-old-space-size=１６３８４"],
            "--max-old-space-size=16384",
        ] {
            #expect(DaemonLauncher.heapNodeArguments(probe: probe(bad), environment: [:]).isEmpty)
        }
    }
}
