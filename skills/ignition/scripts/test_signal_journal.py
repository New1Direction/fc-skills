import copy
import sqlite3
import unittest
from datetime import datetime, timezone

import signal_journal as j


def moment(day):
    return datetime(2026, 1, day, tzinfo=timezone.utc)


class JournalTests(unittest.TestCase):
    def setUp(self):
        self.db = j.connect(':memory:')
        self.report = {'schema_version':'ignition.report.v1','source_kind':'synthetic',
                       'cutoff':'2026-01-01T00:00:00Z',
                       'candidates':[{'candidate_id':'a','quote_unit':'chain:quote'},{'candidate_id':'b','quote_unit':'chain:quote'}]}
        j.record(self.db,self.report,'a'*64,moment(2))
        self.outcome = {'schema_version':'ignition.outcome.v1','id':'o1','report_sha256':'a'*64,
                        'candidate_id':'a','quote_unit':'chain:quote','source_kind':'synthetic',
                        'horizon_at':'2026-01-03T00:00:00Z','available_at':'2026-01-03T00:00:00Z',
                        'status':'resolved','basis':'modeled','method':'one-day predeclared exit',
                        'entry_all_in_quote':'100.01','exit_net_quote':'110.011', 'cost_coverage':'complete',
                        'evidence':[{'id':'e1','source':'invented-fixture','available_at':'2026-01-03T00:00:00Z'}]}

    def tearDown(self):
        self.db.close()

    def test_exact_returns_and_full_universe(self):
        j.add_outcome(self.db,self.outcome,moment(4))
        summary=j.summarize(self.db,'2026-01-04T00:00:00Z')
        self.assertEqual(summary['recorded_candidate_snapshots'],2)
        self.assertEqual(summary['candidate_snapshots_with_any_outcome'],1)
        self.assertEqual(summary['groups'][0]['return_fractions'][0]['numerator'],'1')
        self.assertEqual(summary['groups'][0]['return_fractions'][0]['denominator'],'10')

    def test_import_is_not_backdated_alert(self):
        self.assertEqual(j.summarize(self.db,'2026-01-01T12:00:00Z')['recorded_reports'],0)

    def test_outcome_ingestion_prevents_hindsight(self):
        j.add_outcome(self.db,self.outcome,moment(4))
        self.assertEqual(j.summarize(self.db,'2026-01-03T12:00:00Z')['latest_outcomes'],0)

    def test_failed_unknown_is_not_zero_return(self):
        value=copy.deepcopy(self.outcome)
        value.update(status='execution_failed',entry_all_in_quote=None,exit_net_quote=None,cost_coverage='incomplete')
        j.add_outcome(self.db,value,moment(4))
        group=j.summarize(self.db,'2026-01-04T00:00:00Z')['groups'][0]
        self.assertEqual(group['execution_failed'],1)
        self.assertEqual(group['return_fractions'],[])

    def test_incomplete_costs_cannot_resolve(self):
        self.outcome['cost_coverage']='incomplete'
        with self.assertRaises(ValueError): j.add_outcome(self.db,self.outcome,moment(4))

    def test_rejects_future_evidence(self):
        self.outcome['evidence'][0]['available_at']='2026-01-04T00:00:00Z'
        with self.assertRaises(ValueError): j.add_outcome(self.db,self.outcome,moment(4))

    def test_rejects_unit_and_source_mismatch(self):
        for field,value in [('quote_unit','different'),('source_kind','observed')]:
            case=copy.deepcopy(self.outcome);case[field]=value
            with self.subTest(field=field), self.assertRaises(ValueError): j.add_outcome(self.db,case,moment(4))

    def test_rejects_duplicate_report_and_mutation(self):
        with self.assertRaises(sqlite3.IntegrityError): j.record(self.db,self.report,'a'*64,moment(3))
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('DELETE FROM reports')
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute("UPDATE reports SET source_kind='observed'")

    def test_append_only_revision_respects_asof(self):
        j.add_outcome(self.db,self.outcome,moment(4))
        revision=copy.deepcopy(self.outcome)
        revision.update(id='o2',supersedes_id='o1',exit_net_quote='90.009',available_at='2026-01-05T00:00:00Z')
        j.add_outcome(self.db,revision,moment(5))
        old=j.summarize(self.db,'2026-01-04T12:00:00Z')['groups'][0]
        new=j.summarize(self.db,'2026-01-05T12:00:00Z')['groups'][0]
        self.assertEqual(old['positive_return_count'],1)
        self.assertEqual(new['positive_return_count'],0)
        self.assertEqual(new['resolved'],1)
        with self.assertRaises(sqlite3.IntegrityError): self.db.execute('DELETE FROM outcomes')

    def test_revisions_cannot_fork(self):
        j.add_outcome(self.db,self.outcome,moment(4))
        revision=copy.deepcopy(self.outcome);revision.update(id='o2',supersedes_id='o1')
        j.add_outcome(self.db,revision,moment(5))
        revision['id']='o3'
        with self.assertRaises(ValueError): j.add_outcome(self.db,revision,moment(6))

    def test_missing_revision_link_rejected(self):
        j.add_outcome(self.db,self.outcome,moment(4))
        self.outcome['id']='o2'
        with self.assertRaises(ValueError): j.add_outcome(self.db,self.outcome,moment(5))

    def test_modes_and_units_do_not_pool(self):
        j.add_outcome(self.db,self.outcome,moment(4))
        other=copy.deepcopy(self.outcome);other.update(id='o2',candidate_id='b',basis='simulated')
        j.add_outcome(self.db,other,moment(4))
        self.assertEqual(len(j.summarize(self.db,'2026-01-04T00:00:00Z')['groups']),2)


if __name__=='__main__':
    unittest.main()
