from app.services.record_manager import determine_action


def test_failed_same_content_document_is_reprocessed():
    existing = {"content_hash": "same", "status": "failed"}

    assert determine_action(existing, "same") == "update"


def test_completed_same_content_document_is_skipped():
    existing = {"content_hash": "same", "status": "completed"}

    assert determine_action(existing, "same") == "skip"
