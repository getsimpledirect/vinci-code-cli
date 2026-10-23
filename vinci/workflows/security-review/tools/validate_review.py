#!/usr/bin/env python3
"""Offline declaration consistency checker. NOT an authorization or sandbox service."""
import argparse
import ipaddress
import datetime as dt
import json
import re
import unicodedata
from pathlib import PurePosixPath, Path
from urllib.parse import urlsplit

# Contract field declarations also define which key names are safe in diagnostics.
FIELD_NAMES = {
    'human_reviewer': 'type identity_ref',
    'review': 'schema_version review_id scope route findings coverage conclusion',
    'scope': 'repository commit allowed_paths owner approval_ref issued_at expires_at actions data_class environment',
    'route': 'mode verification_state provider endpoint model requested_class approval_ref verification_ref region retention data_classes',
    'finding': 'id title status severity confidence evidence remediation retest human_review',
    'evidence': 'path start_line end_line source_sha256 observation preconditions reachability limitations',
    'human_review': 'state reviewer evidence_ref',
    'remediation': 'state proposal_ref patch_sha256 owner rationale',
    'retest': 'state evidence_ref tested_commit patch_sha256 reviewer limitations',
    'coverage': 'reviewed_paths not_reviewed limitations',
}
CONTRACT_FIELDS = frozenset(name for names in FIELD_NAMES.values() for name in names.split())

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

def resolved_text(value, label):
    text(value, label)
    normalized = unicodedata.normalize('NFKC', value).casefold()
    # Reserved unresolved markers also fail in compound values, not just exact matches.
    # This is a declaration vocabulary check, not a natural-language truth detector.
    words = re.sub(r'[^a-z0-9]+', ' ', normalized).strip().split()
    require(not (set(words) & {'unknown', 'pending', 'tbd', 'unresolved', 'unverified'}), label + ': unresolved declaration')
    phrase = ' '.join(words)
    require(not any(marker in phrase for marker in ['not verified', 'not yet known', 'to be determined', 'not established', 'not confirmed']), label + ': unresolved declaration')

def human_reviewer(value, label):
    fields(value, FIELD_NAMES['human_reviewer'], label)
    require(value['type'] == 'human', label + ': requires explicit human reviewer type')
    text(value['identity_ref'], label + '.identity_ref')
    # Human is a declared actor type, not an identity attestation. Operators must
    # authenticate the identity reference independently; labels are never proof.

def https_endpoint(value):
    """Validate a bounded ASCII HTTPS URL syntax, without DNS or network access."""
    text(value, 'endpoint')
    require(all(33 <= ord(c) <= 126 for c in value) and '\\' not in value, 'endpoint contains whitespace, controls or non-ASCII characters')
    require(value.startswith('https://') and '?' not in value and '#' not in value, 'endpoint must be HTTPS without query or fragment')
    try:
        u = urlsplit(value)
        require(u.scheme == 'https' and u.netloc and not u.username and not u.password and '@' not in u.netloc, 'endpoint must have credential-free authority')
        # Parse the port explicitly: urlsplit alone accepts nonnumeric/out-of-range ports.
        port = u.port
        require(port is None or 1 <= port <= 65535, 'endpoint port outside 1..65535')
        if u.netloc.startswith('['):
            m = re.fullmatch(r'\[([0-9a-fA-F:.]+)\](?::([0-9]+))?', u.netloc)
            require(m is not None, 'invalid bracketed IPv6 authority')
            ipaddress.IPv6Address(m.group(1))
        else:
            m = re.fullmatch(r'([A-Za-z0-9.-]+)(?::([0-9]+))?', u.netloc)
            require(m is not None, 'invalid hostname or port syntax')
            host = m.group(1)
            require(len(host) <= 253, 'hostname too long')
            if re.fullmatch(r'[0-9.]+', host):
                ipaddress.IPv4Address(host)
            else:
                require(all(re.fullmatch(r'[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?', label) for label in host.split('.')), 'invalid DNS label')
        require(re.fullmatch(r"(?:[A-Za-z0-9._~!$&'()*+,;=:@/\-]|%[0-9a-fA-F]{2})*", u.path), 'invalid URL path encoding')
    except Invalid as exc:
        raise Invalid('invalid HTTPS endpoint: ' + str(exc)) from exc
    except ValueError as exc:
        raise Invalid('invalid HTTPS endpoint') from exc

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
    require(not p.is_absolute() and '..' not in p.parts and str(p) == value and '\\' not in value and '\x00' not in value and value != '.', 'path must be canonical repository relative')

def strings(value, label, nonempty=True):
    require(type(value) is list and (bool(value) or not nonempty), label + ': expected list')
    for item in value:
        text(item, label)
    require(len(set(value)) == len(value), label + ': duplicate entry')

def load(path):
    def pairs(items):
        result = {}
        for key, value in items:
            require(key not in result, 'duplicate JSON key: ' + key if key in CONTRACT_FIELDS else 'duplicate JSON key (unrecognized key name withheld)')
            result[key] = value
        return result
    def nonfinite(value):
        raise Invalid('non-finite JSON number')
    return json.loads(Path(path).read_text(), object_pairs_hook=pairs, parse_constant=nonfinite)

def validate(doc, now=None):
    now = now or dt.datetime.now(dt.timezone.utc)
    fields(doc, FIELD_NAMES['review'], 'review')
    require(doc['schema_version'] == '1.1', 'unknown schema version')
    text(doc['review_id'], 'review_id')
    s = doc['scope']
    fields(s, FIELD_NAMES['scope'], 'scope')
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
    fields(r, FIELD_NAMES['route'], 'route')
    require(r['mode'] in {'offline_only', 'hosted'}, 'unknown route mode')
    if r['mode'] == 'offline_only':
        require(r['verification_state'] == 'not_applicable', 'offline route must use not_applicable verification state')
        require(all(r[k] is None for k in ['provider','endpoint','model','requested_class','approval_ref','verification_ref','region','retention']), 'offline route must not assert hosted details')
        require(r['data_classes'] == [], 'offline route must not declare export')
    else:
        require(r['verification_state'] == 'verified', 'hosted route must explicitly declare verified state')
        for key in ['provider','endpoint','model','requested_class','approval_ref','verification_ref','region','retention']:
            resolved_text(r[key], 'route.' + key)
        https_endpoint(r['endpoint'])
        strings(r['data_classes'], 'route.data_classes')
        require(set(r['data_classes']) <= {'synthetic','public','sanitized_private'} and s['data_class'] in r['data_classes'], 'data not approved for route')
    require(type(doc['findings']) is list, 'findings must be list')
    ids = set()
    for f in doc['findings']:
        fields(f, FIELD_NAMES['finding'], 'finding')
        text(f['id'], 'finding.id'); require(f['id'] not in ids, 'duplicate finding id'); ids.add(f['id'])
        text(f['title'], 'title')
        require(f['status'] in {'hypothesis','confirmed','dismissed','remediated'}, 'unknown finding status')
        require(f['severity'] in {'unknown','low','medium','high','critical'}, 'unknown severity')
        require(f['confidence'] in {'low','medium','high'}, 'unknown confidence')
        e = f['evidence']
        fields(e, FIELD_NAMES['evidence'], 'evidence')
        relpath(e['path']); require(e['path'] in s['allowed_paths'], 'evidence path outside exact allowlist')
        require(type(e['start_line']) is int and type(e['end_line']) is int and 1 <= e['start_line'] <= e['end_line'], 'invalid line range')
        sha(e['source_sha256'], 'source_sha256')
        for k in ['observation','preconditions','reachability','limitations']:
            text(e[k], k)
        h = f['human_review']
        fields(h, FIELD_NAMES['human_review'], 'human_review')
        require(h['state'] in {'pending','accepted','dismissed'}, 'unknown human review state')
        if h['state'] == 'pending':
            require(h['reviewer'] is None and h['evidence_ref'] is None, 'pending review cannot assert acceptance')
        else:
            human_reviewer(h['reviewer'], 'human_review.reviewer'); text(h['evidence_ref'], 'human review evidence')
        expected_review = {'hypothesis':'pending', 'confirmed':'accepted', 'dismissed':'dismissed', 'remediated':'accepted'}
        require(h['state'] == expected_review[f['status']], 'finding status and human review state disagree')
        if f['status'] in {'confirmed','remediated'}:
            require(h['state'] == 'accepted' and f['severity'] != 'unknown', 'confirmed status requires human acceptance and severity')
        if f['status'] == 'dismissed':
            require(h['state'] == 'dismissed', 'dismissal needs human evidence')
        m = f['remediation']
        fields(m, FIELD_NAMES['remediation'], 'remediation')
        require(m['state'] in {'not_proposed','proposed','applied'}, 'unknown remediation state')
        if m['state'] == 'not_proposed':
            require(all(m[k] is None for k in ['proposal_ref','patch_sha256','owner','rationale']), 'empty remediation must not claim a patch')
        else:
            require('propose_patch' in s['actions'], 'patch proposal not in scope')
            for k in ['proposal_ref','owner','rationale']:
                text(m[k], k)
            sha(m['patch_sha256'], 'patch_sha256')
        t = f['retest']
        fields(t, FIELD_NAMES['retest'], 'retest')
        require(t['state'] in {'NOT_RUN','pass','fail','inconclusive'}, 'unknown retest state')
        text(t['limitations'], 'retest limitations')
        if t['state'] == 'NOT_RUN':
            require(all(t[k] is None for k in ['evidence_ref','tested_commit','patch_sha256','reviewer']), 'NOT_RUN cannot assert test evidence')
        else:
            text(t['evidence_ref'], 'retest evidence'); human_reviewer(t['reviewer'], 'retest.reviewer')
            sha(t['tested_commit'], 'tested_commit', 40); sha(t['patch_sha256'], 'retest patch')
            require(m['state'] != 'not_proposed' and t['patch_sha256'] == m['patch_sha256'], 'retest must bind exact proposed patch')
        if f['status'] == 'remediated':
            require(m['state'] == 'applied' and t['state'] == 'pass', 'remediated requires exact-patch passing retest')
    c = doc['coverage']
    fields(c, FIELD_NAMES['coverage'], 'coverage')
    strings(c['reviewed_paths'], 'reviewed_paths', False)
    require(set(c['reviewed_paths']) <= set(s['allowed_paths']), 'coverage outside scope')
    strings(c['not_reviewed'], 'not_reviewed', False)
    require(set(c['not_reviewed']) == set(s['allowed_paths']) - set(c['reviewed_paths']), 'coverage must account for every allowed path')
    require(all(f['evidence']['path'] in c['reviewed_paths'] for f in doc['findings']), 'finding cannot cite unreviewed source')
    strings(c['limitations'], 'coverage limitations')
    require(doc['conclusion'] in {'review_incomplete','review_complete_with_limitations'}, 'no security certification or unknown conclusion')
    if doc['conclusion'] == 'review_complete_with_limitations':
        require(not c['not_reviewed'] and all(f['status'] != 'hypothesis' and f['human_review']['state'] != 'pending' for f in doc['findings']), 'complete review requires accounted coverage and resolved human dispositions')
    return {'contract_status': 'VALID_DECLARATION_ONLY', 'authorization_verified': False,
            'model_accuracy_validated': False, 'runtime_enforcement': False}

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('report'); p.add_argument('--at', help='Explicit evidence-time for fixture replay, not current authorization')
    a = p.parse_args()
    try:
        result = validate(load(a.report), timestamp(a.at) if a.at else None)
        print(json.dumps(result, sort_keys=True)); return 0
    except Invalid as exc:
        reason = str(exc)
    except json.JSONDecodeError as exc:
        reason = f'invalid JSON at line {exc.lineno} column {exc.colno}'
    except UnicodeError:
        reason = 'report must contain valid UTF-8 text'
    except OSError:
        reason = 'unable to read report'
    except (ValueError, TypeError, KeyError):
        reason = 'invalid report value or structure'
    print(json.dumps({'contract_status':'REJECTED', 'reason':reason})); return 2

if __name__ == '__main__':
    raise SystemExit(main())
