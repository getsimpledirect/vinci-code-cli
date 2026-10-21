import copy
import datetime as dt
import json
import sys
import tempfile
import unittest
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'tools'))
from validate_review import validate, load, Invalid
NOW = dt.datetime(2026, 10, 21, 19, 30, tzinfo=dt.timezone.utc)

class ContractTests(unittest.TestCase):
    def setUp(self):
        self.doc = load(ROOT / 'examples/synthetic-review.json')
    def rejected(self, path, value):
        obj = self.doc
        for key in path[:-1]: obj = obj[key]
        obj[path[-1]] = value
        with self.assertRaises(Invalid): validate(self.doc, NOW)
    def test_valid_synthetic_hypothesis(self):
        self.assertFalse(validate(self.doc, NOW)['authorization_verified'])
    def test_missing_authority(self): self.rejected(['scope','approval_ref'], '')
    def test_expired_authority(self): self.rejected(['scope','expires_at'], '2026-10-21T19:00:00Z')
    def test_future_authority(self): self.rejected(['scope','issued_at'], '2026-10-22T19:00:00Z')
    def test_naive_time(self): self.rejected(['scope','issued_at'], '2026-10-21T19:00:00')
    def test_live_environment(self): self.rejected(['scope','environment'], 'production')
    def test_active_scan(self): self.rejected(['scope','actions'], ['read_source','network_scan'])
    def test_live_secret_class(self): self.rejected(['scope','data_class'], 'credentials')
    def test_unknown_route(self): self.rejected(['route','mode'], 'unknown')
    def test_offline_export(self): self.rejected(['route','data_classes'], ['synthetic'])
    def test_out_of_scope_evidence(self): self.rejected(['findings',0,'evidence','path'], 'other.py')
    def test_parent_path(self): self.rejected(['scope','allowed_paths'], ['../secret'])
    def test_absolute_path(self): self.rejected(['scope','allowed_paths'], ['/etc/passwd'])
    def test_bad_hash(self): self.rejected(['findings',0,'evidence','source_sha256'], 'unknown')
    def test_line_boolean(self): self.rejected(['findings',0,'evidence','start_line'], True)
    def test_unreviewed_confirmation(self): self.rejected(['findings',0,'status'], 'confirmed')
    def test_false_remediated(self): self.rejected(['findings',0,'status'], 'remediated')
    def test_unknown_retest(self): self.rejected(['findings',0,'retest','state'], 'green')
    def test_not_run_with_evidence(self): self.rejected(['findings',0,'retest','evidence_ref'], 'pretend-pass')
    def test_unaccounted_coverage(self): self.rejected(['coverage','reviewed_paths'], [])
    def test_unreviewed_complete(self): self.rejected(['conclusion'], 'review_complete_with_limitations')
    def test_no_certification(self): self.rejected(['conclusion'], 'vulnerability_free')
    def test_unknown_field(self):
        self.doc['approved'] = True
        with self.assertRaises(Invalid): validate(self.doc, NOW)
    def test_duplicate_finding(self):
        self.doc['findings'].append(copy.deepcopy(self.doc['findings'][0]))
        with self.assertRaises(Invalid): validate(self.doc, NOW)
    def hosted(self):
        self.doc['route'] = {'mode':'hosted','verification_state':'verified','provider':'SYNTHETIC provider','endpoint':'https://example.invalid/inference','model':'synthetic-model-revision','requested_class':'synthetic-class','approval_ref':'SYNTHETIC-ONLY-EXPORT-APPROVAL','verification_ref':'SYNTHETIC-ONLY-ROUTE-RECEIPT','region':'synthetic-region','retention':'synthetic no-retention declaration','data_classes':['synthetic']}
    def test_synthetic_hosted_declaration(self):
        self.hosted(); self.assertFalse(validate(self.doc, NOW)['runtime_enforcement'])
    def test_hosted_unknown_model(self):
        self.hosted(); self.rejected(['route','model'], 'unknown')
    def test_hosted_missing_receipt(self):
        self.hosted(); self.rejected(['route','verification_ref'], '')
    def test_hosted_secret_endpoint(self):
        self.hosted(); self.rejected(['route','endpoint'], 'https://example.invalid/?token=placeholder')
    def test_hosted_wrong_data(self):
        self.hosted(); self.rejected(['route','data_classes'], ['public'])
    def test_hosted_plain_http(self):
        self.hosted(); self.rejected(['route','endpoint'], 'http://example.invalid/')
    def test_missing_field(self):
        del self.doc['route']
        with self.assertRaises(Invalid): validate(self.doc, NOW)
    def test_duplicate_json_key(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input.json'; p.write_text('{"x":1,"x":2}')
            with self.assertRaises(Invalid): load(p)
    def test_nonfinite_json(self):
        with tempfile.TemporaryDirectory() as d:
            p=Path(d)/'input.json'; p.write_text('{"x":NaN}')
            with self.assertRaises(Invalid): load(p)
    def test_unknown_schema(self): self.rejected(['schema_version'], 'future')
    def test_finding_in_unreviewed_path(self):
        self.doc['coverage']['reviewed_paths']=[]
        self.doc['coverage']['not_reviewed']=self.doc['scope']['allowed_paths'][:]
        with self.assertRaises(Invalid): validate(self.doc, NOW)
    def test_model_cannot_accept(self):
        self.doc['findings'][0]['human_review']={'state':'accepted','reviewer':'MODEL','evidence_ref':'dummy'}
        with self.assertRaises(Invalid): validate(self.doc, NOW)
    def test_synthetic_human_disposition(self):
        f=self.doc['findings'][0]
        f['status']='dismissed'
        f['human_review']={'state':'dismissed','reviewer':{'type':'human','identity_ref':'SYNTHETIC human'},'evidence_ref':'SYNTHETIC disposition, no real approval'}
        self.doc['conclusion']='review_complete_with_limitations'
        self.assertFalse(validate(self.doc, NOW)['authorization_verified'])
    def test_positive_synthetic_remediation_and_hash_mismatch(self):
        f=self.doc['findings'][0]; f['status']='remediated'
        f['human_review']={'state':'accepted','reviewer':{'type':'human','identity_ref':'SYNTHETIC human'},'evidence_ref':'SYNTHETIC acceptance'}
        f['remediation']={'state':'applied','proposal_ref':'SYNTHETIC patch','patch_sha256':'a'*64,'owner':'SYNTHETIC owner','rationale':'SYNTHETIC rationale'}
        f['retest']={'state':'pass','evidence_ref':'SYNTHETIC test only','tested_commit':'b'*40,'patch_sha256':'a'*64,'reviewer':{'type':'human','identity_ref':'SYNTHETIC reviewer'},'limitations':'No real behavior executed'}
        self.assertFalse(validate(self.doc, NOW)['authorization_verified'])
        self.rejected(['findings',0,'retest','patch_sha256'], 'c'*64)

    def test_compound_hosted_placeholders(self):
        for field in ['provider','model','requested_class','approval_ref','verification_ref','region','retention']:
            for value in ['unknown-region','PENDING legal review','TBD_provider','unverified route','not yet known','not verified','to be determined','not confirmed','not established','ＵＮＫＮＯＷＮ region']:
                with self.subTest(field=field,value=value):
                    self.hosted(); self.rejected(['route',field],value)
    def test_compound_placeholder_in_endpoint(self):
        self.hosted(); self.rejected(['route','endpoint'],'https://unknown-region.example.invalid/inference')
    def test_route_verification_state(self):
        for value in ['unknown','pending','unresolved','not_applicable',None,True]:
            with self.subTest(value=value):
                self.hosted(); self.rejected(['route','verification_state'],value)
    def test_route_missing_verification_state(self):
        self.hosted(); del self.doc['route']['verification_state']
        with self.assertRaises(Invalid): validate(self.doc,NOW)
    def test_offline_false_verification(self):
        self.rejected(['route','verification_state'],'verified')
    def test_status_review_matrix(self):
        mapping={'hypothesis':'pending','confirmed':'accepted','dismissed':'dismissed','remediated':'accepted'}
        for status,expected in mapping.items():
            for state in ['pending','accepted','dismissed']:
                if state == expected: continue
                with self.subTest(status=status,state=state):
                    d=copy.deepcopy(self.doc); f=d['findings'][0]; f['status']=status
                    f['human_review']={'state':state,'reviewer':None if state=='pending' else {'type':'human','identity_ref':'SYNTHETIC reviewer'},'evidence_ref':None if state=='pending' else 'synthetic disposition'}
                    with self.assertRaisesRegex(Invalid,'status and human review'): validate(d,NOW)
    def test_hypothesis_cannot_complete_with_human_disposition(self):
        for state in ['accepted','dismissed']:
            with self.subTest(state=state):
                d=copy.deepcopy(self.doc); d['conclusion']='review_complete_with_limitations'
                d['findings'][0]['human_review']={'state':state,'reviewer':{'type':'human','identity_ref':'SYNTHETIC reviewer'},'evidence_ref':'synthetic disposition'}
                with self.assertRaisesRegex(Invalid,'status and human review'): validate(d,NOW)
    def test_freeform_reviewer_labels_rejected(self):
        for who in ['human','AI','GPT-5','model reviewer','Alice']:
            with self.subTest(who=who):
                d=copy.deepcopy(self.doc); f=d['findings'][0]; f['status']='confirmed'
                f['human_review']={'state':'accepted','reviewer':who,'evidence_ref':'synthetic receipt'}
                with self.assertRaisesRegex(Invalid,'expected object'): validate(d,NOW)
    def test_nonhuman_reviewer_types_rejected(self):
        for kind in ['model','ai','AI','GPT-5','unknown','agent','service',None,True]:
            with self.subTest(kind=kind):
                d=copy.deepcopy(self.doc); f=d['findings'][0]; f['status']='confirmed'
                f['human_review']={'state':'accepted','reviewer':{'type':kind,'identity_ref':'synthetic actor'},'evidence_ref':'synthetic receipt'}
                with self.assertRaisesRegex(Invalid,'human reviewer type'): validate(d,NOW)
    def test_retest_reviewer_is_structured_human(self):
        for who in ['AI','GPT-5','model reviewer', {'type':'model','identity_ref':'synthetic actor'}, {'type':'human','identity_ref':''}]:
            with self.subTest(who=who):
                d=copy.deepcopy(self.doc); f=d['findings'][0]
                f['remediation']={'state':'proposed','proposal_ref':'synthetic patch','patch_sha256':'a'*64,'owner':'synthetic owner','rationale':'synthetic rationale'}
                f['retest']={'state':'pass','evidence_ref':'synthetic test','tested_commit':'b'*40,'patch_sha256':'a'*64,'reviewer':who,'limitations':'synthetic only'}
                with self.assertRaises(Invalid): validate(d,NOW)
    def test_legacy_schema_rejected(self): self.rejected(['schema_version'],'1.0')
    def test_malformed_https_endpoints(self):
        invalid=['https://bad host.example/inference','https://example.invalid:notaport/inference','https://example.invalid:99999/inference',
                 'https://example.invalid:0/','https://example.invalid:/','https://example.invalid:+443/',
                 'https://example.invalid\n/inference','https://example.invalid\t/inference',' https://example.invalid/',
                 'https://a..example/','https://-bad.example/','https://bad-.example/','https://a_b.example/',
                 'https://256.0.0.1/','https://127.1/','https://[::1]:notaport/','https://[::1]:99999/',
                 'https://[invalid]/','https://[fe80::1%25eth0]/','https://example.invalid/%zz',
                 'https://example.invalid/?','https://example.invalid/#','https://example.invalid\\other/',
                 'https://user@example.invalid/','https://example.invalid:１２３/', 'https://'+('a'*64)+'.example/']
        for endpoint in invalid:
            with self.subTest(endpoint=endpoint):
                self.hosted(); self.rejected(['route','endpoint'],endpoint)
    def test_valid_https_endpoint_syntax_not_network_clearance(self):
        for endpoint in ['https://example.invalid/inference','https://example.invalid:443/v1','https://example.invalid:65535/v1',
                         'https://192.0.2.1/v1','https://[2001:db8::1]:443/v1','https://xn--bcher-kva.example/v1/path%20value']:
            with self.subTest(endpoint=endpoint):
                self.hosted(); self.doc['route']['endpoint']=endpoint
                self.assertFalse(validate(self.doc,NOW)['runtime_enforcement'])

if __name__ == '__main__': unittest.main(verbosity=2)
