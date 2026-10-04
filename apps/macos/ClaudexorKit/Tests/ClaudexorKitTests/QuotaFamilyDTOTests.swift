import Foundation
import Testing
@testable import ClaudexorKit

@Suite struct QuotaFamilyDTOTests {
    @Test func vendorFamilyScopesAndSubjectPacingSurviveDecodeAndProjection() throws {
        let response = try JSONDecoder().decode(ControlQuotaResponse.self, from: Data(#"""
        {"snapshots":[{"subject":{"harness":"agy","credential_route":"vendor_native","plan_label":null,"subject_id":"work"},
         "constraints":[{"id":"third-party","label":"Weekly","applies_to_models":["claude-opus-5-5-high"],"applies_to_model_prefixes":["claude-","gpt-"],"used_ratio":1,"window_seconds":604800,"resets_at":"2026-10-11T00:00:00Z","cooldown_until":null}],
         "source":"agy_command_usage","observed_at":"2026-10-04T00:00:00Z","freshness":"fresh",
         "availability":{"state":"available","blocking_constraints":[],"resets_at":null,"model_scoped_exhaustions":[{"constraint_id":"third-party","applies_to_models":[],"applies_to_model_prefixes":["claude-","gpt-"],"resets_at":"2026-10-11T00:00:00Z"}]}}],
         "absences":[],"refreshed_at":"2026-10-04T00:00:00Z",
         "refresh_skipped":[{"vendor":"claude","not_before":"2026-10-04T00:20:00Z","subject":{"harness":"claude","credential_route":"vendor_native","plan_label":null,"subject_id":"account-a"}}]}
        """#.utf8))
        let snapshot = try #require(response.snapshots.first)
        #expect(snapshot.constraints.first?.appliesToModelPrefixes == ["claude-", "gpt-"])
        #expect(snapshot.availability?.modelScopedExhaustions.first?.appliesToModelPrefixes == ["claude-", "gpt-"])
        let skipped = try #require(response.refreshSkipped?.first)
        #expect(skipped.subject?.subjectId == "account-a")
        #expect(skipped.id == "claude:vendor_native:account-a")
        let decoded = try JSONDecoder().decode(ControlQuotaResponse.self, from: JSONEncoder().encode(response))
        #expect(decoded == response)
        let group = try #require(QuotaPresentation.groups(from: response.snapshots).first)
        #expect(group.hasOnlyScopedWindows)
        #expect(group.availability?.state == "available")
        #expect(group.windows.first?.appliesToModels?.contains("claude-*") == true)
        #expect(group.scopedExhaustions.first?.appliesToModels == ["claude-*", "gpt-*"])
    }
}


extension QuotaFamilyDTOTests {
    @Test func familyLabelsStayIdenticalWithOneOrEighteenKnownModels() throws {
        for count in [1, 18] {
            let snapshot = try familySnapshot(models: (1...count).map { "claude-next-\($0)" })
            let group = try #require(QuotaPresentation.groups(from: [snapshot]).first)
            let window = try #require(group.windows.first)
            #expect(QuotaPresentation.modelScopeLabel(window.appliesToModels ?? []) == "Claude, Gpt only")
            #expect(group.scopedExhaustions.first?.scopeLabel == "Claude, Gpt only")
        }
    }

    @Test func prefixOnlyWindowsStayScopedAndUncoveredIdsRemainVisible() throws {
        let snapshot = try familySnapshot(models: [])
        let group = try #require(QuotaPresentation.groups(from: [snapshot]).first)
        #expect(group.hasOnlyScopedWindows)
        #expect(group.availability?.state == "available")
        #expect(group.windows.first?.appliesToModels == ["claude-*", "gpt-*"])
        #expect(group.scopedExhaustions.first?.scopeLabel == "Claude, Gpt only")
        let uncovered = try familySnapshot(models: ["other-model", "claude-next"])
        #expect(uncovered.constraints.first?.modelScope == ["other-model", "claude-*", "gpt-*"])
    }

    private func familySnapshot(models: [String]) throws -> QuotaSnapshot {
        let object: [String: Any] = [
            "subject": ["harness": "agy", "credential_route": "vendor_native", "subject_id": "work"],
            "constraints": [["id": "family", "label": "Weekly", "applies_to_models": models,
                "applies_to_model_prefixes": ["claude-", "gpt-"], "used_ratio": 1,
                "window_seconds": 604800, "resets_at": "2026-10-11T00:00:00Z"]],
            "source": "agy_command_usage", "observed_at": "2026-10-04T00:00:00Z", "freshness": "fresh",
            "availability": ["state": "available", "blocking_constraints": [],
                "model_scoped_exhaustions": [["constraint_id": "family", "applies_to_models": models,
                    "applies_to_model_prefixes": ["claude-", "gpt-"], "resets_at": "2026-10-11T00:00:00Z"]]],
        ]
        return try JSONDecoder().decode(QuotaSnapshot.self, from: JSONSerialization.data(withJSONObject: object))
    }
}
