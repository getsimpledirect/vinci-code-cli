"""Offline endpoint and inverse-disposition regressions; no network activity."""
import copy
import datetime as dt
import json
import sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'tools'))
from validate_review import load,validate,Invalid
now=dt.datetime(2026,10,21,19,30,tzinfo=dt.timezone.utc)
base=load(ROOT/'examples/synthetic-review.json')
results={}
for endpoint in ['https://bad host.example/inference','https://example.invalid:notaport/inference','https://example.invalid:99999/inference']:
 d=copy.deepcopy(base)
 d['route']={'mode':'hosted','verification_state':'verified','provider':'synthetic provider','endpoint':endpoint,'model':'synthetic model','requested_class':'synthetic class','approval_ref':'synthetic approval','verification_ref':'synthetic receipt','region':'synthetic region','retention':'synthetic retention','data_classes':['synthetic']}
 try: validate(d,now); results[endpoint]={'accepted':True}
 except Invalid as exc: results[endpoint]={'accepted':False,'reason':str(exc)}
for status,state in [('confirmed','dismissed'),('dismissed','accepted'),('remediated','dismissed')]:
 d=copy.deepcopy(base); f=d['findings'][0]; f['status']=status
 f['human_review']={'state':state,'reviewer':{'type':'human','identity_ref':'synthetic reviewer'},'evidence_ref':'synthetic receipt'}
 try: validate(d,now); results[status+'/'+state]={'accepted':True}
 except Invalid as exc: results[status+'/'+state]={'accepted':False,'reason':str(exc)}
print(json.dumps(results,indent=2))
raise SystemExit(1 if any(v['accepted'] for v in results.values()) else 0)
