import copy
import json
from pathlib import Path
import unittest
from research import analyze_research, markdown

EXAMPLES=Path(__file__).resolve().parents[1]/'examples'


def inputs():
    return json.loads((EXAMPLES/'attribution.json').read_text()),json.loads((EXAMPLES/'flows.json').read_text())


class ResearchTests(unittest.TestCase):
    def test_coherent_scopes_preserve_assetwide_counts(self):
        a,f=inputs();r=analyze_research([a],f);row=r['comparison_rows'][0]
        self.assertEqual(row['join_status'],'SCOPES_ALIGNED')
        self.assertIsNotNone(row['asset_wide_participation'])
        self.assertIn('not only',row['participation_scope'])
        self.assertFalse(row['qualifies_as_signal'])
        self.assertTrue(r['contains_declared_synthetic_data'])
        self.assertIn('Synthetic demonstration',markdown(r))
        self.assertNotIn('https://robinhoodchain.blockscout',markdown(r))

    def test_mismatched_asset_units_withhold_join(self):
        a,f=inputs();f['assets'][a['assets']['meme']['address']]['decimals']=2
        row=analyze_research([a],f)['comparison_rows'][0]
        self.assertIn('ASSET_UNIT_OR_IDENTITY_DISAGREEMENT',row['join_issues'])
        self.assertIsNone(row['asset_wide_participation'])

    def test_mismatched_pool_key_withholds_join(self):
        a,f=inputs();f['pools'][0]['fee']=100
        row=analyze_research([a],f)['comparison_rows'][0]
        self.assertIn('POOL_KEY_DISAGREEMENT',row['join_issues'])

    def test_different_cutoff_not_joined(self):
        a,f=inputs();f['knowledge_cutoff']+=1
        row=analyze_research([a],f)['comparison_rows'][0]
        self.assertIn('DIFFERENT_KNOWLEDGE_CUTOFF',row['join_issues'])

    def test_reorg_block_cannot_join(self):
        a,f=inputs();height=f['swaps'][0]['block_number']
        for x in f['swaps']:
            if x['block_number']==height:
                x['block_number']=a['snapshots'][0]['block_number']
                x['timestamp']=1788876000
        row=analyze_research([a],f)['comparison_rows'][0]
        self.assertIn('BLOCK_IDENTITY_OR_TIME_DISAGREEMENT',row['join_issues'])

    def test_block_time_order_cannot_join(self):
        a,f=inputs()
        for x in f['swaps']: x['block_number']+=100
        row=analyze_research([a],f)['comparison_rows'][0]
        self.assertIn('BLOCK_TIME_ORDER_DISAGREEMENT',row['join_issues'])

    def test_invalid_price_candidate_is_retained(self):
        a,f=inputs();bad=copy.deepcopy(a);bad['chain_id']=1
        r=analyze_research([a,bad],f)
        self.assertEqual(len(r['comparison_rows']),2)
        self.assertEqual(r['comparison_rows'][1]['attribution_status'],'INSUFFICIENT_DATA')
        self.assertEqual(r['comparison_rows'][1]['join_issues'],['ATTRIBUTION_UNAVAILABLE'])

    def test_partial_reference_preserves_local_math(self):
        a,f=inputs();a['snapshots'][1].pop('reference')
        row=analyze_research([a],f)['comparison_rows'][0]
        self.assertEqual(row['attribution_status'],'PARTIAL_REFERENCE')
        self.assertIsNotNone(row['meme_quote_return_pct'])
        self.assertFalse(row['qualifies_as_signal'])

    def test_flow_only_and_price_only(self):
        a,f=inputs()
        self.assertEqual(analyze_research([],f)['comparison_rows'],[])
        self.assertEqual(analyze_research([a])['comparison_rows'][0]['join_issues'],['NO_FLOW_INPUT'])
        with self.assertRaises(ValueError): analyze_research([])

    def test_deterministic_hashes_and_reports(self):
        a,f=inputs();r=analyze_research([a],f)
        self.assertEqual(r,analyze_research([copy.deepcopy(a)],copy.deepcopy(f)))
        a['snapshots'][1].pop('reference')
        self.assertNotEqual(r['input_manifest']['attribution_sha256'],analyze_research([a],f)['input_manifest']['attribution_sha256'])


if __name__=='__main__':unittest.main()
