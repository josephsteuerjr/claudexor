import ClaudexorKit
import Foundation

// MARK: - Thread folders
//
// A folder is one optional, daemon-owned label per thread (`folder`). The
// sidebar derives its sections from the labels, so there is no local folder
// store and an empty folder does not persist. Moving a thread is a
// folder-only PATCH, which keeps the thread's `updatedAt`: the list order and
// the CLI `--resume` target do not change.

/// One section of the thread list once folders are in use.
struct ThreadFolderSection: Identifiable, Equatable {
    /// The folder name; nil is the "Ungrouped" section (threads without one).
    let folder: String?
    let threads: [LocatedThread]

    var id: String { folder.map { "folder|\($0)" } ?? "ungrouped" }

    /// Sections for `threads`, which arrive in display order. Empty when no
    /// thread has a folder: the sidebar then shows the plain list exactly as
    /// before folders existed. Otherwise one section per folder name, sorted,
    /// then "Ungrouped" when any thread has no folder. One name used on several
    /// engines is ONE section.
    static func sections(for threads: [LocatedThread]) -> [ThreadFolderSection] {
        let names = Set(threads.compactMap(\.thread.folder))
            .sorted { $0.localizedStandardCompare($1) == .orderedAscending }
        guard !names.isEmpty else { return [] }
        let ungrouped = threads.filter { $0.thread.folder == nil }
        return names.map { name in
            ThreadFolderSection(folder: name, threads: threads.filter { $0.thread.folder == name })
        } + (ungrouped.isEmpty ? [] : [ThreadFolderSection(folder: nil, threads: ungrouped)])
    }
}

extension AppModel {
    var threadFolderNames: [String] {
        ThreadFolderSection.sections(for: locatedThreads).compactMap(\.folder)
    }

    func threads(in folder: String?) -> [LocatedThread] {
        locatedThreads.filter { $0.thread.folder == folder }
    }

    func setThreadFolder(
        locationID: ExecutionLocationID,
        id: String,
        folder: String?
    ) async {
        guard let requestClient = gateway(for: locationID) else {
            threadStatus = "Engine offline — reconnect to move the thread."
            return
        }
        do {
            threadStatus = nil
            let updated = try await requestClient.setThreadFolder(id: id, folder: folder)
            guard isCurrentGateway(requestClient, at: locationID) else { return }
            applyThreadUpdate(updated, at: locationID)
        } catch {
            threadStatus = threadFolderFailureMessage(for: error)
        }
    }

    func renameThreadFolder(_ oldName: String, to newName: String) async {
        guard oldName != newName else { return }
        await updateThreads(inFolder: oldName, to: newName)
    }

    func removeThreadFolder(_ name: String) async {
        await updateThreads(inFolder: name, to: nil)
    }

    /// The members a folder rename/remove re-files. A thread in the trash is
    /// left as it is: the engine refuses edits to it until it is restored (409),
    /// and it keeps its folder for that restore.
    nonisolated static func threadsToRefile(_ members: [LocatedThread]) -> [LocatedThread] {
        members.filter { $0.thread.state != "trashed" && $0.thread.state != "purged" }
    }

    private func updateThreads(inFolder oldName: String, to newName: String?) async {
        // A new folder operation supersedes an earlier folder banner; its own
        // PATCH failures and the refresh set the status that belongs to it.
        threadStatus = nil
        let members = Self.threadsToRefile(threads(in: oldName))
        let locations = Set(members.map(\.locationID))
        var failures = 0
        for member in members {
            guard let requestClient = gateway(for: member.locationID) else {
                failures += 1
                continue
            }
            do {
                let updated = try await requestClient.setThreadFolder(
                    id: member.thread.id, folder: newName)
                guard isCurrentGateway(requestClient, at: member.locationID) else {
                    failures += 1
                    continue
                }
                applyThreadUpdate(updated, at: member.locationID)
            } catch {
                failures += 1
            }
        }
        for locationID in locations {
            if locationID == .local {
                await refreshThreads()
            } else {
                await refreshRemoteThreads(locationID)
            }
        }
        if failures > 0 {
            threadStatus = "Updated \(members.count - failures) of \(members.count) threads; \(failures) failed."
        }
    }

    /// The engine's own reason, except for an engine that predates folders,
    /// which gets a plain update hint instead of a raw validation error.
    func threadFolderFailureMessage(for error: Error) -> String {
        if let gatewayError = error as? GatewayError, gatewayError.isThreadFolderUnsupported {
            return "The engine is too old for folders. Update Claudexor."
        }
        return userMessage(for: error)
    }
}
