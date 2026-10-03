import SwiftUI
import ClaudexorKit

// MARK: - Thread lifecycle in the sidebar: Archive → Trash → Delete Now
//
// Kept beside ThreadsScreen.swift (INV-124 readability ratchet). The sidebar
// stays ONE list on ONE screen (DESIGN_SYSTEM §4): active threads (grouped by
// folder, ThreadsScreen+Folders), then the collapsed "Archived" section (state
// `closed`), then the collapsed "Trash" section (state `trashed`). Membership
// is derived from the server's lifecycle state only — there is no local-only
// thread state.

/// Which collapsed lifecycle sections are open. Both start collapsed.
struct ThreadSidebarDisclosure: Equatable {
    var archivedExpanded = false
    var trashExpanded = false
}

/// Sidebar section membership — one pure owner over the server's thread state.
struct ThreadSidebarSections: Equatable {
    var active: [LocatedThread] = []
    var archived: [LocatedThread] = []
    var trash: [LocatedThread] = []

    init(_ threads: [LocatedThread]) {
        for located in threads {
            switch located.thread.state {
            case "closed": archived.append(located)
            case "trashed": trash.append(located)
            case "purged": continue  // the engine lists no purged thread; never show one
            default: active.append(located)
            }
        }
    }
}

/// What a thread list the engine answered could not show: projects the engine
/// skipped (its `problems`, such as a project whose folder is missing) and rows
/// this app version could not decode. A thread missing from a list with a gap
/// may still exist, so its absence confirms nothing.
struct ThreadListGaps: Equatable {
    var skippedProjects = 0
    var unreadableThreads = 0

    var isEmpty: Bool { skippedProjects == 0 && unreadableThreads == 0 }
}

extension ThreadListGaps {
    init(_ list: ThreadListResponse) {
        self.init(skippedProjects: list.problems.count, unreadableThreads: list.droppedThreads)
    }
}

/// Where a thread stands after a "Delete Now" request failed, as a thread list
/// the engine answered shows it.
enum DeleteNowFailure: Equatable {
    case inTrash      // still listed in Trash (a refusal): Restore works
    case gone         // missing from a complete list: the engine purged it after all
    case elsewhere    // listed outside Trash (restored meanwhile)
    /// No promise either way: the list could not be read (nil), or it has a
    /// gap and does not show the thread.
    case unconfirmed(ThreadListGaps?)

    /// The thread's place by a list the engine answered: `listed` is its row
    /// there (nil when the list does not show it), `gaps` what the list could
    /// not show. Only a list without gaps confirms a purge by leaving it out.
    init(listed: ThreadSummary?, gaps: ThreadListGaps) {
        if let listed, listed.state != "purged" {
            self = listed.state == "trashed" ? .inTrash : .elsewhere
        } else if listed != nil || gaps.isEmpty {
            self = .gone
        } else {
            self = .unconfirmed(gaps)
        }
    }

    /// Whether a banner that said this still holds once a later list shows
    /// `now`: a thread confirmed purged retires every banner about it, and a
    /// thread listed outside Trash (restored, also by another client) retires
    /// the banners that point to Trash.
    func stillHolds(once now: DeleteNowFailure) -> Bool {
        switch (self, now) {
        case (_, .gone): return false
        case (.inTrash, .elsewhere), (.unconfirmed, .elsewhere): return false
        default: return true
        }
    }
}

/// Product copy of the trash lifecycle, one owner (INV-134): the honest
/// "Delete Now…" text by workspace mode, the disabled-control reasons, and the
/// Trash row caption. English-only, independent of the host locale (INV-141).
enum ThreadLifecycleCopy {
    static let deleteNowTitle = "Delete this thread now?"

    /// What a purge removes and what it keeps (owner decision E1). It never
    /// promises to erase the conversation: the engine journal keeps the
    /// messages, run outputs follow the regular cleanup of old runs, and an
    /// agent that keeps sessions in its account's own directory (a Codex
    /// config-dir login, Antigravity) keeps them there.
    static func deleteNowMessage(workspaceMode: String?) -> String {
        var text = "Project files are not touched. The thread disappears from every client,"
            + " and its own local directories and caches are deleted. Saved sessions may"
            + " remain in the agents' own storage. Its messages stay in the local engine"
            + " journal, and its run outputs are left to the regular cleanup of old runs."
        if workspaceMode == "isolated" {
            text += " The thread's separate working copy is deleted, including changes that"
                + " were never applied to the project."
        }
        return text + " This cannot be undone."
    }

    static let deleteBusyReason =
        "A turn is running in this thread. Stop it or let it finish before deleting the thread."

    /// The row menu's "Delete" title. While a turn runs the item is disabled,
    /// and its title carries the reason itself: a disabled menu item's tooltip
    /// is no reliable place for it on macOS.
    static func deleteMenuTitle(busy: Bool) -> String {
        busy ? "Delete (a turn is running)" : "Delete"
    }

    static let deleteNowBusyReason =
        "A turn is still running in this thread. Delete Now becomes available when it finishes."

    /// A failed "Delete Now", said by what the re-read list shows. Only a
    /// thread still listed in Trash is promised to stay there, and only a
    /// complete list confirms that it was deleted.
    static func deleteNowFailure(_ outcome: DeleteNowFailure, reason: String) -> String {
        switch outcome {
        case .inTrash: return "Could not delete the thread now; it stays in Trash: \(reason)"
        case .gone: return "The thread was deleted, though the request reported an error: \(reason)"
        case .elsewhere: return "Could not delete the thread now: \(reason)"
        case .unconfirmed(nil):
            return "Could not confirm whether the thread was deleted; check Trash once the engine"
                + " responds: \(reason)"
        case .unconfirmed(let gaps?):
            return "Could not confirm whether the thread was deleted: the thread list was"
                + " incomplete (\(listGaps(gaps))); check Trash once it is complete: \(reason)"
        }
    }

    /// The gaps of a thread list, as the unconfirmed banner names them.
    static func listGaps(_ gaps: ThreadListGaps) -> String {
        var parts: [String] = []
        if gaps.skippedProjects > 0 {
            parts.append("the engine skipped \(counted(gaps.skippedProjects, "project"))")
        }
        if gaps.unreadableThreads > 0 {
            parts.append("this app could not read \(counted(gaps.unreadableThreads, "thread"))")
        }
        return parts.joined(separator: " and ")
    }

    private static func counted(_ count: Int, _ noun: String) -> String {
        "\(count) \(noun)\(count == 1 ? "" : "s")"
    }

    /// Trash row caption: where the thread lives and how long Restore works.
    static func trashCaption(
        place: String,
        purgeAfter: String?,
        now: Date = .now
    ) -> String {
        guard let purgeAfter, let deadline = instant(purgeAfter) else { return "\(place) · in Trash" }
        let day = deadline.formatted(
            Date.FormatStyle(date: .abbreviated, time: .omitted)
                .locale(Locale(identifier: "en_US_POSIX")))
        return restorePeriodEnded(purgeAfter: purgeAfter, now: now)
            ? "\(place) · restore period ended \(day)"
            : "\(place) · restorable until \(day)"
    }

    /// Whether Restore is over: the caption says so, the engine would answer
    /// 410 `thread_trash_expired`, and the button is off. A missing or
    /// unreadable deadline claims nothing (the engine decides).
    static func restorePeriodEnded(purgeAfter: String?, now: Date = .now) -> Bool {
        guard let purgeAfter, let deadline = instant(purgeAfter) else { return false }
        return deadline <= now
    }

    private static func instant(_ raw: String) -> Date? {
        (try? Date(raw, strategy: .iso8601.time(includingFractionalSeconds: true)))
            ?? (try? Date(raw, strategy: .iso8601))
    }
}

extension ThreadsScreen {
    /// The thread list: the active threads in their folder sections
    /// (ThreadsScreen+Folders), then the collapsed Archived and Trash sections.
    /// Archived and trashed threads keep their folder label but are listed
    /// only in their own section. Active and archived rows open the
    /// conversation; Trash rows are not selectable (a trashed thread takes no
    /// turns until restored).
    var threadSections: some View {
        let sections = ThreadSidebarSections(model.locatedThreads)
        return List(selection: Binding(
            get: { model.selectedLocatedThreadID },
            set: { locatedID in
                guard let locatedID,
                      let located = model.locatedThreads.first(where: {
                          $0.id == locatedID
                      })
                else { return }
                Task {
                    await model.openThread(
                        locationID: located.locationID,
                        id: located.thread.id)
                }
            }
        )) {
            threadListRows(sections.active)
            if !sections.archived.isEmpty {
                Section(isExpanded: $sidebarDisclosure.archivedExpanded) {
                    ForEach(sections.archived) { located in
                        threadRow(located).tag(located.id)
                    }
                } header: {
                    Text("Archived (\(sections.archived.count))")
                }
            }
            if !sections.trash.isEmpty {
                Section(isExpanded: $sidebarDisclosure.trashExpanded) {
                    ForEach(sections.trash) { located in trashRow(located) }
                } header: {
                    Text("Trash (\(sections.trash.count))")
                }
            }
        }
        .listStyle(.sidebar)
        .scrollContentBackground(.hidden)   // let the Liquid Glass panel show through
    }

    /// The row menu's "Delete": one click, no dialog. The thread moves to the
    /// collapsed Trash section and stays restorable (owner decision E1).
    @ViewBuilder func threadDeleteMenuItem(_ located: LocatedThread) -> some View {
        let busy = model.isThreadBusy(located.thread.id, at: located.locationID)
        Divider()
        Button(ThreadLifecycleCopy.deleteMenuTitle(busy: busy), role: .destructive) {
            Task { await model.trashThread(locationID: located.locationID, id: located.thread.id) }
        }
        .disabled(busy)
        .help(busy
            ? ThreadLifecycleCopy.deleteBusyReason
            : "Move this thread to Trash. You can restore it for 30 days.")
    }

    /// A Trash row: what it is, how long Restore works, and the two actions.
    /// While a turn of the thread runs, "Delete Now…" is disabled and the row
    /// says why (the engine answers 409 to every client in that state). Once
    /// the restore period has ended, Restore is disabled and the caption
    /// already says so (the engine would answer 410).
    func trashRow(_ located: LocatedThread) -> some View {
        let thread = located.thread
        let busy = model.isThreadBusy(thread.id, at: located.locationID)
        let now = Date.now
        let restoreEnded = ThreadLifecycleCopy.restorePeriodEnded(
            purgeAfter: thread.purgeAfter, now: now)
        let project = thread.repoRoot.map { URL(fileURLWithPath: $0).lastPathComponent } ?? "No project"
        let place = model.remoteConnection(for: located.locationID)
            .map { "\($0.displayName) · \(project)" } ?? project
        return VStack(alignment: .leading, spacing: Theme.Spacing.xxs) {
            Text(thread.title ?? "Untitled thread").font(.body).lineLimit(1)
            Text(ThreadLifecycleCopy.trashCaption(
                place: place, purgeAfter: thread.purgeAfter, now: now))
                .font(.caption).foregroundStyle(.secondary).lineLimit(1)
            HStack(spacing: Theme.Spacing.sm) {
                Button("Restore") {
                    Task {
                        await model.restoreThread(
                            locationID: located.locationID, id: thread.id)
                    }
                }
                .disabled(restoreEnded)
                .help(restoreEnded
                    ? "The restore period of this thread has ended"
                    : "Return this thread to the thread list")
                Button("Delete Now…", role: .destructive) { deleteNowTarget = located }
                    .disabled(busy)
                    .help(busy
                        ? ThreadLifecycleCopy.deleteNowBusyReason
                        : "Delete this thread for good after a confirmation")
            }
            .buttonStyle(.borderless)
            .controlSize(.small)
            if busy {
                Text(ThreadLifecycleCopy.deleteNowBusyReason)
                    .font(.caption2).foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, Theme.Spacing.xxs)
        .selectionDisabled()
    }

    func confirmDeleteNow(_ located: LocatedThread) {
        deleteNowTarget = nil
        Task { await model.deleteThreadNow(locationID: located.locationID, id: located.thread.id) }
    }
}

extension View {
    /// The "Delete Now…" confirmation (the #349 dialog scaffold) carrying the
    /// honest text for the target thread's workspace mode.
    func threadDeleteNowConfirmation(
        target: Binding<LocatedThread?>,
        onConfirm: @escaping @MainActor (LocatedThread) -> Void
    ) -> some View {
        confirmationDialog(
            ThreadLifecycleCopy.deleteNowTitle,
            isPresented: Binding(
                get: { target.wrappedValue != nil },
                set: { if !$0 { target.wrappedValue = nil } }
            ),
            titleVisibility: .visible,
            presenting: target.wrappedValue
        ) { located in
            Button("Delete Now", role: .destructive) { onConfirm(located) }
            Button("Cancel", role: .cancel) {}
        } message: { located in
            Text(ThreadLifecycleCopy.deleteNowMessage(workspaceMode: located.thread.workspaceMode))
        }
    }
}
