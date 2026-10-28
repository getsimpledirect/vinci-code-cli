"""Bounded candidate ZIP extraction. No extractall, links, nested paths, code execution or network."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import struct
import sys
import zipfile

ARCHIVE_LIMIT=64*1024*1024
TOTAL_LIMIT=64*1024*1024
FILE_LIMIT=32*1024*1024

def unique_object(pairs):
    result={}
    for key,value in pairs:
        if key in result:raise ValueError('Duplicate JSON key')
        result[key]=value
    return result

def checked_json(raw):
    return json.loads(raw,object_pairs_hook=unique_object)

def reject_zip64_extra(raw):
    cursor=0
    while cursor<len(raw):
        if len(raw)-cursor<4:raise ValueError('Truncated extra header')
        kind,length=struct.unpack_from('<HH',raw,cursor)
        cursor+=4
        if cursor+length>len(raw):raise ValueError('Truncated extra data')
        if kind==0x0001:raise ValueError('ZIP64 extra field')
        cursor+=length

def inspect_member_headers(stream,central_offset,central_size,count):
    # Inspect the raw fields before ZipInfo can normalize ZIP64 sentinels/extra fields.
    stream.seek(central_offset)
    central=stream.read(central_size)
    if len(central)!=central_size:raise ValueError('Truncated central directory')
    cursor=0
    for _ in range(count):
        if cursor+46>len(central):raise ValueError('Truncated central header')
        fields=struct.unpack_from('<4s6H3I5H2I',central,cursor)
        signature,_,needed,_,_,_,_,_,compressed,size,name_length,extra_length,comment_length,disk,_,_,local_offset=fields
        if signature!=b'PK\x01\x02':raise ValueError('Central header signature')
        if needed>=45 or compressed==0xffffffff or size==0xffffffff or local_offset==0xffffffff:raise ValueError('ZIP64 central indicator')
        if disk!=0:raise ValueError('Member disk number')
        end=cursor+46+name_length+extra_length+comment_length
        if end>len(central) or name_length>256:raise ValueError('Central member bound')
        name=central[cursor+46:cursor+46+name_length]
        reject_zip64_extra(central[cursor+46+name_length:cursor+46+name_length+extra_length])
        if not 0<=local_offset<=central_offset-30:raise ValueError('Local header offset')
        stream.seek(local_offset)
        local=stream.read(30)
        if len(local)!=30:raise ValueError('Truncated local header')
        local_fields=struct.unpack('<4s5H3I2H',local)
        local_signature,local_needed,_,_,_,_,_,local_compressed,local_size,local_name_length,local_extra_length=local_fields
        if local_signature!=b'PK\x03\x04':raise ValueError('Local header signature')
        if local_needed>=45 or local_compressed==0xffffffff or local_size==0xffffffff:raise ValueError('ZIP64 local indicator')
        if local_name_length>256 or local_offset+30+local_name_length+local_extra_length+compressed>central_offset:raise ValueError('Local member bound')
        if stream.read(local_name_length)!=name:raise ValueError('Local/central name mismatch')
        extra=stream.read(local_extra_length)
        if len(extra)!=local_extra_length:raise ValueError('Truncated local extra')
        reject_zip64_extra(extra)
        cursor=end
    if cursor!=len(central):raise ValueError('Unexpected central directory data')

def extract(archive,destination,version,receipt_sha256,source,run_id,run_attempt):
    if not re.fullmatch(r'[0-9]+\.[0-9]+\.[0-9]+',version):raise ValueError('Version')
    if not re.fullmatch(r'[a-f0-9]{64}',receipt_sha256):raise ValueError('Receipt digest')
    if not re.fullmatch(r'[a-f0-9]{40}',source):raise ValueError('Source')
    for value in [run_id,run_attempt]:
        if not re.fullmatch(r'[1-9][0-9]{0,17}',value):raise ValueError('ID')
    archive=Path(archive)
    if archive.is_symlink() or not archive.is_file() or not 0<archive.stat().st_size<=ARCHIVE_LIMIT:raise ValueError('Archive bound')
    destination=Path(os.path.abspath(destination))
    if os.path.lexists(destination) or destination.name!='candidate' or destination.parent.resolve()!=destination.parent:raise ValueError('Fresh owned destination required')
    names=[f'vinci-code-{version}.tgz',f'vinci-code-{version}.tgz.sha256','vinci-code.tgz','install.sh','manifest-beta.json','live-before.json','live-before.headers','candidate.json','staged-archive-put.json','staged-checksum-put.json']
    limits={name:(FILE_LIMIT if name.endswith('.tgz') else 1024*1024 if name=='install.sh' else 256 if name.endswith('.sha256') else 65536) for name in names}
    # Bound allocation and reject explicit ZIP64/footer/member disk indicators before ZipInfo
    # normalization. This is not a blanket format attestation of arbitrary ignored bytes.
    size=archive.stat().st_size
    with archive.open('rb') as stream:
        stream.seek(max(0,size-65557));tail=stream.read(65557)
    index=tail.rfind(b'PK\x05\x06')
    if index<0 or len(tail)-index<22:raise ValueError('Missing EOCD')
    _,disk,central_disk,disk_count,count,central_size,central_offset,comment=struct.unpack_from('<4s4H2IH',tail,index)
    absolute=size-len(tail)+index
    if disk or central_disk or disk_count!=count or count!=len(names) or count==65535:raise ValueError('Catalog count or disk')
    if central_size==0xffffffff or central_offset==0xffffffff:raise ValueError('ZIP64 central directory indicator')
    if central_size>65536 or central_offset+central_size!=absolute or absolute+22+comment!=size:raise ValueError('Central directory bound')
    with archive.open('rb') as stream:inspect_member_headers(stream,central_offset,central_size,count)
    with zipfile.ZipFile(archive) as zipped:
        members=zipped.infolist()
        if len(members)!=len(names) or {m.filename for m in members}!=set(names):raise ValueError('Unexpected/missing/duplicate path')
        if len({m.filename for m in members})!=len(members):raise ValueError('Duplicate path')
        total=0
        for member in members:
            if member.volume!=0:raise ValueError('Member disk number')
            if member.orig_filename!=member.filename or not member.filename.isascii() or '/' in member.filename or '\\' in member.filename:raise ValueError('Untrusted path')
            mode=stat.S_IFMT(member.external_attr>>16)
            if member.is_dir() or mode not in [0,stat.S_IFREG] or member.external_attr&0x10:raise ValueError('Non-regular member')
            if member.flag_bits&1 or member.compress_type not in [zipfile.ZIP_STORED,zipfile.ZIP_DEFLATED]:raise ValueError('Unsupported ZIP member')
            if not 0<=member.file_size<=limits[member.filename] or not 0<=member.compress_size<=ARCHIVE_LIMIT:raise ValueError('Member size bound')
            if not 0<=member.header_offset<central_offset:raise ValueError('Member offset')
            total+=member.file_size
        if total>TOTAL_LIMIT:raise ValueError('Total bound')
        os.mkdir(destination,0o700)
        directory=os.open(destination,os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
        try:
            marker=os.open('.INCOMPLETE',os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
            os.close(marker)
            hashes={};actual_total=0
            for member in members:
                descriptor=os.open(member.filename,os.O_WRONLY|os.O_CREAT|os.O_EXCL|os.O_NOFOLLOW,0o600,dir_fd=directory)
                count=0;digest=hashlib.sha256()
                with os.fdopen(descriptor,'wb') as output,zipped.open(member,'r') as input_stream:
                    while True:
                        chunk=input_stream.read(65536)
                        if not chunk:break
                        count+=len(chunk);actual_total+=len(chunk)
                        if count>limits[member.filename] or actual_total>TOTAL_LIMIT:raise ValueError('Inflated bound')
                        output.write(chunk);digest.update(chunk)
                    output.flush();os.fsync(output.fileno())
                if count!=member.file_size:raise ValueError('Length mismatch')
                hashes[member.filename]={'sha256':digest.hexdigest(),'bytes':count}
            if hashes['candidate.json']['sha256']!=receipt_sha256:raise ValueError('Unreviewed receipt')
            record=checked_json((destination/'candidate.json').read_bytes())
            if record.get('schemaVersion')!=1 or record.get('version')!=version or record.get('tag')!='vinci-v'+version:raise ValueError('Receipt identity')
            if record.get('repository')!='getsimpledirect/vinci-code-cli' or str(record.get('repositoryId'))!='1345288037':raise ValueError('Receipt repository')
            if record.get('source')!=source or str(record.get('producerRunId'))!=run_id or str(record.get('producerRunAttempt'))!=run_attempt:raise ValueError('Receipt producer')
            expected=names[:7]
            if not isinstance(record.get('files'),dict) or set(record['files'])!=set(expected):raise ValueError('Receipt inventory')
            for name in expected:
                if record['files'][name]!=hashes[name]['sha256']:raise ValueError('Changed candidate bytes')
            for name in ['staged-archive-put.json','staged-checksum-put.json']:
                if not isinstance(checked_json((destination/name).read_bytes()),dict):raise ValueError('Object receipt')
            os.unlink('.INCOMPLETE',dir_fd=directory)
            os.fsync(directory)
            return {'schemaVersion':1,'files':hashes,'safeBasenamesOnly':True,'reviewedReceiptMatched':True,'incompleteMarkerAbsent':True}
        finally:os.close(directory)

def main():
    parser=argparse.ArgumentParser()
    for name in ['archive','destination','version','receipt-sha256','source','run-id','run-attempt']:parser.add_argument('--'+name,required=True)
    args=parser.parse_args()
    result=extract(args.archive,args.destination,args.version,args.receipt_sha256,args.source,args.run_id,args.run_attempt)
    print(json.dumps(result,separators=(',',':')))

if __name__=='__main__':
    try:main()
    except Exception as error:
        print('Candidate ZIP refused: '+type(error).__name__,file=sys.stderr)
        sys.exit(1)
