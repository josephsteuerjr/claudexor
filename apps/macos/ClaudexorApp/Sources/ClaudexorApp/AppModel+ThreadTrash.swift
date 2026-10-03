import Foundation
import ClaudexorKit

/// The banner a failed "Delete Now" left, the thread it speaks about and what
/// it said, so a later thread list that makes it wrong can retire it.
struct DeleteNowBanner: Equatable {
    let locationID: ExecutionLocationID
    let threadID: String
    let outcome: DeleteNowFailure
    let text: String
}

/// Thread trash lifecycle (owner decision E1): "Delete" moves a thread to
/// recoverable Trash, "Restore" brings it back, and "Delete Now…" (inside
/// Trash, after a confirmation) purges it. Each command is ONE server call
/// followed by a re-read of the server's list, and the app says only what that
/// list shows: a thread whose purge was refused stays visible in Trash with
/// Restore, never hidden, and a failed request never promises Trash for a
/// thread the engine may already have purged.
extension AppModel {
    /// Move a thread to Trash (one click, no dialog). The app offers it only
    /// while the thread is idle; the engine itself does not refuse a busy trash.
    func trashThread(locationID: ExecutionLocationID, id: String) async {
        guard !isThreadBusy(id, at: locationID) else {
            threadStatus = ThreadLifecycleCopy.deleteBusyReason
            return
        }
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to delete this thread."
            return
        }
        do {
            let trashed = try await requestClient.trashThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus = "Moved to Trash, but the engine connection changed before the list could refresh."
                return
            }
            // A trashed thread takes no turns: leave its conversation for a draft.
            if selectedExecutionLocation == locationID, selectedThreadId == id {
                startDraftThread()
            }
            applyThreadUpdate(trashed, at: locationID)
            await refreshThreadList(at: locationID)
        } catch {
            threadStatus = "Could not move the thread to Trash: \(userMessage(for: error))"
        }
    }

    /// Return a trashed thread to the list (the engine refuses once the trash
    /// window has ended, and that refusal is shown as is).
    func restoreThread(locationID: ExecutionLocationID, id: String) async {
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to restore this thread."
            return
        }
        do {
            let restored = try await requestClient.restoreThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus = "Restored, but the engine connection changed before the list could refresh."
                return
            }
            // The thread is back, so an earlier failure banner about it (a
            // refused Delete Now saying it stays in Trash) no longer holds.
            clearLifecycleBanner()
            applyThreadUpdate(restored, at: locationID)
            await refreshThreadList(at: locationID)
        } catch {
            threadStatus = "Could not restore the thread: \(userMessage(for: error))"
        }
    }

    /// "Delete Now…" after its confirmation: one purge call. A refusal (409
    /// while any turn of the thread runs) leaves the thread in Trash; any other
    /// failure is reported by what the re-read list shows.
    func deleteThreadNow(locationID: ExecutionLocationID, id: String) async {
        guard !isThreadBusy(id, at: locationID) else {
            threadStatus = ThreadLifecycleCopy.deleteNowBusyReason
            return
        }
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to delete this thread."
            return
        }
        do {
            let purged = try await requestClient.purgeThread(id: id)
            guard isCurrentGateway(requestClient, at: locationID) else {
                threadStatus = "Deleted, but the engine connection changed before the list could refresh."
                return
            }
            clearLifecycleBanner()
            applyThreadUpdate(purged, at: locationID)
            await refreshThreadList(at: locationID)
        } catch {
            await reportDeleteNowFailure(
                reason: userMessage(for: error), requestClient: requestClient,
                locationID: locationID, id: id)
        }
    }

    /// The engine journals a purge BEFORE it deletes the thread's directories
    /// (docs/ARCHITECTURE.md, thread lifecycle routes), so a failed request or
    /// a lost answer does not mean the thread is still there. Re-read the list
    /// and say only what it shows; Trash and Restore are promised only while
    /// the engine still lists the thread in Trash, and only a list without
    /// gaps confirms the purge by leaving the thread out.
    private func reportDeleteNowFailure(
        reason: String,
        requestClient: GatewayClient,
        locationID: ExecutionLocationID,
        id: String
    ) async {
        let listed = isCurrentGateway(requestClient, at: locationID)
            ? await refreshThreadList(at: locationID)
            : false
        // A list that came back recorded its gaps (reconcileThreadStatus);
        // without that record nothing is confirmed.
        let outcome: DeleteNowFailure
        if listed, let gaps = threadListGaps[locationID] {
            outcome = DeleteNowFailure(listed: threadSummary(id, at: locationID), gaps: gaps)
        } else {
            outcome = .unconfirmed(nil)
        }
        let text = ThreadLifecycleCopy.deleteNowFailure(outcome, reason: reason)
        threadStatus = text
        // "Deleted" is final; the other banners hold until a later list shows
        // they no longer do.
        deleteNowBanner = outcome == .gone
            ? nil
            : DeleteNowBanner(locationID: locationID, threadID: id, outcome: outcome, text: text)
    }

    /// Called after every thread list the engine answered for `locationID`,
    /// with what that list could not show. A Delete Now banner about a thread
    /// of that engine leaves once the list makes it wrong; a thread missing
    /// from a list with gaps confirms nothing, so the banner stays. A local
    /// list also retires an earlier "Could not refresh threads", which shares
    /// the one status line with every engine's banner: a live banner it had
    /// replaced comes back.
    func reconcileThreadStatus(at locationID: ExecutionLocationID, listGaps: ThreadListGaps) {
        threadListGaps[locationID] = listGaps
        if let banner = deleteNowBanner, banner.locationID == locationID,
           !banner.outcome.stillHolds(once: DeleteNowFailure(
               listed: threadSummary(banner.threadID, at: locationID), gaps: listGaps)) {
            if threadStatus == banner.text { threadStatus = nil }
            deleteNowBanner = nil
        }
        if locationID == .local, threadStatus?.hasPrefix(Self.threadRefreshFailurePrefix) == true {
            threadStatus = deleteNowBanner?.text
        }
    }

    private func clearLifecycleBanner() {
        threadStatus = nil
        deleteNowBanner = nil
    }

    /// Re-read the list of the location; true when it now reflects the engine.
    @discardableResult
    private func refreshThreadList(at locationID: ExecutionLocationID) async -> Bool {
        if locationID == .local {
            return await refreshThreads()
        }
        return await refreshRemoteThreads(locationID)
    }
}
