import Foundation

// Shared bounded SSE delivery helper, extracted to keep the client within its
// existing complexity cap. Stream overflow remains an explicit resnapshot error.
extension GatewayClient {
    static func yieldChecked<Element: Sendable>(
        _ element: Element,
        to continuation: AsyncThrowingStream<Element, Error>.Continuation,
        context: String
    ) throws -> Bool {
        switch continuation.yield(element) {
        case .enqueued:
            return true
        case .dropped:
            throw GatewayError.transport("\(context) buffer overflow; resnapshot is required")
        case .terminated:
            return false
        @unknown default:
            throw GatewayError.transport("\(context) returned an unknown buffering result")
        }
    }
}
