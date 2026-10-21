"""Offline regressions for the three PR review findings. No targets or model calls."""
import copy
import datetime as dt
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from validate_review import load, validate, Invalid
NOW=dt.datetime(2026,10,21,19,30,tzinfo=dt.timezone.utc)
base=load(ROOT/'examples/synthetic-review.json')
cases={}
d=copy.deepcopy(base)
d['route']={'mode':'hosted','verification_state':'verified','provider':'synthetic provider','endpoint':'https://example.invalid/inference','model':'synthetic model','requested_class':'synthetic class','approval_ref':'synthetic approval','verification_ref':'synthetic receipt','region':'unknown-region','retention':'pending legal review','data_classes':['synthetic']}
cases['compound_unresolved_hosted_fields']=d
for state in ['accepted','dismissed']:
 d=copy.deepcopy(base); d['findings'][0]['human_review']={'state':state,'reviewer':{'type':'human','identity_ref':'SYNTHETIC human'},'evidence_ref':'synthetic disposition'}
 d['conclusion']='review_complete_with_limitations'
 cases['hypothesis_with_'+state+'_review']=d
for who in ['AI','GPT-5','model reviewer']:
 d=copy.deepcopy(base); f=d['findings'][0]; f['status']='confirmed'
 f['human_review']={'state':'accepted','reviewer':who,'evidence_ref':'synthetic acceptance'}
 cases['model_acceptance_'+who]=d
 d=copy.deepcopy(d); f=d['findings'][0]; f['status']='remediated'
 f['human_review']['reviewer']={'type':'human','identity_ref':'SYNTHETIC human'}
 f['remediation']={'state':'applied','proposal_ref':'synthetic patch','patch_sha256':'a'*64,'owner':'synthetic owner','rationale':'synthetic rationale'}
 f['retest']={'state':'pass','evidence_ref':'synthetic receipt','tested_commit':'b'*40,'patch_sha256':'a'*64,'reviewer':who,'limitations':'synthetic only'}
 cases['model_retest_'+who]=d
results={}
for name,doc in cases.items():
 try:
  validate(doc,NOW); results[name]={'accepted':True}
 except Invalid as exc: results[name]={'accepted':False,'reason':str(exc)}
print(json.dumps(results,indent=2))
raise SystemExit(1 if any(item['accepted'] for item in results.values()) else 0)
