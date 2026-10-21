#!/usr/bin/env python3
"""Offline declaration consistency checker. NOT an authorization or sandbox service."""
import argparse
import datetime as dt
import json
import re
from pathlib import PurePosixPath, Path

class Invalid(ValueError):
    pass

def require(value, message):
    if not value:
        raise Invalid(message)

def fields(value, names, label):
    require(type(value) is dict, label + ': expected object')
    require(set(value) == set(names.split()), label + ': missing or unknown fields')

def text(value, label):
    require(type(value) is str and bool(value.strip()) and len(value) <= 4096, label + ': expected nonempty text')

def sha(value, label, length=64):
    require(type(value) is str and re.fullmatch('[0-9a-f]{' + str(length) + '}', value), label + ': expected lowercase hash')

def timestamp(value):
    text(value, 'timestamp')
    try:
        result = dt.datetime.fromisoformat(value.replace('Z', '+00:00'))
        require(result.utcoffset() is not None, 'timestamp must have timezone')
        return result
    except ValueError as exc:
        raise Invalid('invalid timestamp') from exc

def relpath(value):
    text(value, 'path')
    p = PurePosixPath(value)
    require(not p.is_absolute() and '..' not in p.parts and str(p) == value and '\\' not in value and value != '.', 'path must be canonical repository relative')

def strings(value, label, nonempty=True):
    require(type(value) is list and (bool(value) or not nonempty), label + ': expected list')
    for item in value:
        text(item, label)
    require(len(set(value)) == len(value), label + ': duplicate entry')

def load(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key: ' + key)
            result[key] = value
        return result
    def nonfinite(value):
        raise Invalid('non-finite JSON number: ' + value)
    return json.loads(Path(path).read_text(), object_pairs_hook=pairs, parse_constant=nonfinite)

def validate(doc, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    fields(doc, 'schema_version review_id scope route findings coverage conclusion', 'review')
    require(doc['schema_version'] == '1.0', 'unknown schema version')
    text(doc['review_id'], 'review_id')
    s = doc['scope']
    fields(s, 'repository commit allowed_paths owner approval_ref issued_at expires_at actions data_class environment', 'scope')
    text(s['repository'], 'repository'); sha(s['commit'], 'commit', 40)
    strings(s['allowed_paths'], 'allowed_paths')
    for p in s['allowed_paths']:
        relpath(p)
    text(s['owner'], 'owner'); text(s['approval_ref'], 'approval_ref')
    require(timestamp(s['issued_at']) <= now < timestamp(s['expires_at']), 'scope not yet valid or expired')
    require(s['environment'] == 'offline_sanitized_copy', 'environment outside this workflow')
    require(s['data_class'] in {'synthetic', 'public', 'sanitized_private'}, 'unsupported data class')
    strings(s['actions'], 'actions')
    require(set(s['actions']) <= {'read_source', 'propose_patch'}, 'active execution or publication outside this workflow')
    require('read_source' in s['actions'], 'read_source not authorized')
    r = doc['route']
    fields(r, 'mode provider endpoint model requested_class approval_ref verification_ref region retention data_classes', 'route')
    require(r['mode'] in {'offline_only', 'hosted'}, 'unknown route mode')
    if r['mode'] == 'offline_only':
        require(all(r[k] is None for k in ['provider','endpoint','model','requested_class','approval_ref','verification_ref','region','retention']), 'offline route must not assert hosted details')
        require(r['data_classes'] == [], 'offline route must not declare export')
    else:
        for key in ['provider','endpoint','model','requested_class','approval_ref','verification_ref','region','retention']:
            text(r[key], 'route.' + key)
            require(r[key].strip().lower() not in {'unknown','pending','tbd'}, 'unverified hosted route')
        from urllib.parse import urlsplit
        u = urlsplit(r['endpoint'])
        require(u.scheme == 'https' and u.hostname and not u.username and not u.password and not u.query and not u.fragment, 'route must be credential-free HTTPS endpoint')
        strings(r['data_classes'], 'route.data_classes')
        require(set(r['data_classes']) <= {'synthetic','public','sanitized_private'} and s['data_class'] in r['data_classes'], 'data not approved for route')
    require(type(doc['findings']) is list, 'findings must be list')
    ids = set()
    for f in doc['findings']:
        fields(f, 'id title status severity confidence evidence remediation retest human_review', 'finding')
        text(f['id'], 'finding.id'); require(f['id'] not in ids, 'duplicate finding id'); ids.add(f['id'])
        text(f['title'], 'title')
        require(f['status'] in {'hypothesis','confirmed','dismissed','remediated'}, 'unknown finding status')
        require(f['severity'] in {'unknown','low','medium','high','critical'}, 'unknown severity')
        require(f['confidence'] in {'low','medium','high'}, 'unknown confidence')
        e = f['evidence']
        fields(e, 'path start_line end_line source_sha256 observation preconditions reachability limitations', 'evidence')
        relpath(e['path']); require(e['path'] in s['allowed_paths'], 'evidence path outside exact allowlist')
        require(type(e['start_line']) is int and type(e['end_line']) is int and 1 <= e['start_line'] <= e['end_line'], 'invalid line range')
        sha(e['source_sha256'], 'source_sha256')
        for k in ['observation','preconditions','reachability','limitations']:
            text(e[k], k)
        h = f['human_review']
        fields(h, 'state reviewer evidence_ref', 'human_review')
        require(h['state'] in {'pending','accepted','dismissed'}, 'unknown human review state')
        if h['state'] == 'pending':
            require(h['reviewer'] is None and h['evidence_ref'] is None, 'pending review cannot assert acceptance')
        else:
            text(h['reviewer'], 'reviewer'); text(h['evidence_ref'], 'human review evidence')
            require(h['reviewer'].strip().lower() != 'model', 'model cannot independently accept findings')
        if f['status'] in {'confirmed','remediated'}:
            require(h['state'] == 'accepted' and f['severity'] != 'unknown', 'confirmed status requires human acceptance and severity')
        if f['status'] == 'dismissed':
            require(h['state'] == 'dismissed', 'dismissal needs human evidence')
        m = f['remediation']
        fields(m, 'state proposal_ref patch_sha256 owner rationale', 'remediation')
        require(m['state'] in {'not_proposed','proposed','applied'}, 'unknown remediation state')
        if m['state'] == 'not_proposed':
            require(all(m[k] is None for k in ['proposal_ref','patch_sha256','owner','rationale']), 'empty remediation must not claim a patch')
        else:
            require('propose_patch' in s['actions'], 'patch proposal not in scope')
            for k in ['proposal_ref','owner','rationale']:
                text(m[k], k)
            sha(m['patch_sha256'], 'patch_sha256')
        t = f['retest']
        fields(t, 'state evidence_ref tested_commit patch_sha256 reviewer limitations', 'retest')
        require(t['state'] in {'NOT_RUN','pass','fail','inconclusive'}, 'unknown retest state')
        text(t['limitations'], 'retest limitations')
        if t['state'] == 'NOT_RUN':
            require(all(t[k] is None for k in ['evidence_ref','tested_commit','patch_sha256','reviewer']), 'NOT_RUN cannot assert test evidence')
        else:
            text(t['evidence_ref'], 'retest evidence'); text(t['reviewer'], 'retest reviewer')
            require(t['reviewer'].strip().lower() != 'model', 'model verdict is not independent retest')
            sha(t['tested_commit'], 'tested_commit', 40); sha(t['patch_sha256'], 'retest patch')
            require(m['state'] != 'not_proposed' and t['patch_sha256'] == m['patch_sha256'], 'retest must bind exact proposed patch')
        if f['status'] == 'remediated':
            require(m['state'] == 'applied' and t['state'] == 'pass', 'remediated requires exact-patch passing retest')
    c = doc['coverage']
    fields(c, 'reviewed_paths not_reviewed limitations', 'coverage')
    strings(c['reviewed_paths'], 'reviewed_paths', False)
    require(set(c['reviewed_paths']) <= set(s['allowed_paths']), 'coverage outside scope')
    strings(c['not_reviewed'], 'not_reviewed', False)
    require(set(c['not_reviewed']) == set(s['allowed_paths']) - set(c['reviewed_paths']), 'coverage must account for every allowed path')
    require(all(f['evidence']['path'] in c['reviewed_paths'] for f in doc['findings']), 'finding cannot cite unreviewed source')
    strings(c['limitations'], 'coverage limitations')
    require(doc['conclusion'] in {'review_incomplete','review_complete_with_limitations'}, 'no security certification or unknown conclusion')
    if doc['conclusion'] == 'review_complete_with_limitations':
        require(not c['not_reviewed'] and all(f['human_review']['state'] != 'pending' for f in doc['findings']), 'complete review requires accounted coverage and human dispositions')
    return {'contract_status': 'VALID_DECLARATION_ONLY', 'authorization_verified': False,
            'model_accuracy_validated': False, 'runtime_enforcement': False}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('report'); p.add_argument('--at', help='Explicit evidence-time for fixture replay, not current authorization')
    a = p.parse_args()
    try:
        result = validate(load(a.report), timestamp(a.at) if a.at else None)
        print(json.dumps(result, sort_keys=True)); return 0
    except (Invalid, OSError, ValueError, TypeError, KeyError) as exc:
        print(json.dumps({'contract_status':'REJECTED', 'reason':str(exc)})); return 2

if __name__ == '__main__':
    raise SystemExit(main())
