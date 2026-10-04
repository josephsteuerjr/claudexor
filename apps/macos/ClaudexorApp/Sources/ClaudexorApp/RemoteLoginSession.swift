import ClaudexorKit
import Foundation
import Observation

/// A remote presentation of the existing setup observer. The caller retains
/// connection ownership; the controller retains job and disclosure authority.
@MainActor @Observable final class RemoteLoginSession {
    private(set) var lifecycle: SetupLifecycleSnapshot
    private(set) var readiness: RemoteNativeLoginReadiness?
    private(set) var actionInFlight = false
    private(set) var status: String?
    private let controller: SetupLifecycleController
    private let jobId: String
    private let isCurrent: @MainActor () -> Bool
    private let refreshReadiness: @MainActor (SetupJob) async -> RemoteNativeLoginReadiness?

    init(gateway: any SetupJobGateway, jobId: String, initialJob: SetupJob? = nil,
         isCurrent: @escaping @MainActor () -> Bool,
         refreshReadiness: @escaping @MainActor (SetupJob) async -> RemoteNativeLoginReadiness?) {
        controller = SetupLifecycleController(gateway: gateway)
        self.jobId = jobId
        self.isCurrent = isCurrent
        self.refreshReadiness = refreshReadiness
        lifecycle = SetupLifecycleSnapshot(job: initialJob, connection: .recovering)
    }

    var current: Bool { isCurrent() && lifecycle.connection != .detached }

    func observe() async {
        guard isCurrent() else { return }
        await controller.observeJob(jobId: jobId)
        let updates = await controller.updates()
        for await next in updates {
            guard !Task.isCancelled, isCurrent() else { break }
            lifecycle = next
            status = next.lastError
            if let job = next.job, job.isTerminal {
                let refreshed = await refreshReadiness(job)
                guard !Task.isCancelled, isCurrent() else { break }
                readiness = refreshed
                if refreshed == nil { status = "Login finished, but account readiness could not be refreshed." }
                break
            }
            if next.connection == .detached { break }
        }
        await controller.detach()
    }

    func submitInput(_ value: String) async -> String? {
        guard current, !actionInFlight else { return "The remote sign-in is not available for input." }
        actionInFlight = true
        defer { actionInFlight = false }
        let result = await controller.submitInput(value)
        guard isCurrent() else { return "The remote connection changed. Recheck the sign-in status." }
        return result
    }

    func cancel() async {
        guard current, !actionInFlight else { return }
        actionInFlight = true
        await controller.cancel()
        actionInFlight = false
    }

    func reconnect() async {
        guard current, !actionInFlight else { return }
        actionInFlight = true
        // A reconnect observes exactly the job that this presentation owns.
        await controller.observeJob(jobId: jobId)
        actionInFlight = false
    }

    func detach() async {
        await controller.detach()
        lifecycle = await controller.snapshot()
    }
}
