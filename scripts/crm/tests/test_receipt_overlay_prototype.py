import importlib.util
import sqlite3
import unittest
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('receipt_overlay', Path(__file__).resolve().parents[1] / 'receipt_overlay_prototype.py')
mod = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mod)


def db():
    conn = sqlite3.connect(':memory:')
    conn.executescript('''
      CREATE TABLE crm_contacts(id TEXT PRIMARY KEY, name TEXT);
      CREATE TABLE crm_idempotency_receipts(
        submission_key TEXT PRIMARY KEY, resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL, received_at TEXT NOT NULL);
      INSERT INTO crm_contacts VALUES ('synthetic', 'اسم اصطناعي');
      INSERT INTO crm_idempotency_receipts VALUES ('ticket','contact','authorized_pending','2026-01-01');
    ''')
    return conn


class OverlayTest(unittest.TestCase):
    def setUp(self):
        self.base, self.current = db(), db()

    def tearDown(self):
        self.base.close()
        self.current.close()

    def test_overlay_preserves_consumed_and_additional_receipts_without_touching_inputs(self):
        self.current.executescript("UPDATE crm_idempotency_receipts SET resource_id='consumed'; INSERT INTO crm_idempotency_receipts VALUES('second','contact','consumed','2026-01-02');")
        output = mod.build_receipt_overlay(self.base, self.current)
        try:
            self.assertEqual(mod._fingerprint(output), mod._fingerprint(self.current))
            self.assertEqual(self.base.execute("SELECT resource_id FROM crm_idempotency_receipts WHERE submission_key='ticket'").fetchone(), ('authorized_pending',))
            self.assertEqual(output.execute("SELECT resource_id FROM crm_idempotency_receipts WHERE submission_key='ticket'").fetchone(), ('consumed',))
        finally:
            output.close()

    def test_refuses_non_receipt_data_and_schema_difference(self):
        self.current.execute("UPDATE crm_contacts SET name='تغيير اصطناعي'")
        self.current.commit()
        with self.assertRaisesRegex(ValueError, 'non-receipt-data-differs'):
            mod.build_receipt_overlay(self.base, self.current)
        self.current.execute('CREATE TABLE extra(id TEXT)')
        with self.assertRaisesRegex(ValueError, 'schema-mismatch'):
            mod.build_receipt_overlay(self.base, self.current)

    def test_refuses_receipt_triggers(self):
        for conn in (self.base, self.current):
            conn.execute('CREATE TRIGGER receipt_trigger AFTER DELETE ON crm_idempotency_receipts BEGIN SELECT 1; END')
        with self.assertRaisesRegex(ValueError, 'receipt-trigger-present'):
            mod.build_receipt_overlay(self.base, self.current)

    def test_refuses_source_change_during_operation(self):
        clone = mod._clone
        count = 0
        def changing(conn):
            nonlocal count
            count += 1
            if count == 4:
                self.current.execute("UPDATE crm_idempotency_receipts SET resource_id='consumed'")
                self.current.commit()
            return clone(conn)
        with patch.object(mod, '_clone', changing):
            with self.assertRaisesRegex(ValueError, 'source-changed-during-check'):
                mod.build_receipt_overlay(self.base, self.current)


if __name__ == '__main__':
    unittest.main()
