"""ZIP boundary controls and inert fixture producer. No signing, network or product build."""
from pathlib import Path
import argparse
import hashlib
import importlib.util
import io
import json
import os
import stat
import struct
import sys
import tempfile
import unittest
import warnings
import zipfile

ROOT=Path(__file__).resolve().parents[2]
spec=importlib.util.spec_from_file_location('candidate_extract',ROOT/'vinci/scripts/extract-release-candidate.py')
module=importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
SHA=lambda raw:hashlib.sha256(raw).hexdigest()

def files(version='0.0.58',source='a'*40):
    names=[f'vinci-code-{version}.tgz',f'vinci-code-{version}.tgz.sha256','vinci-code.tgz','install.sh','manifest-beta.json','live-before.json','live-before.headers']
    values={name:('INERT '+name+'\n').encode() for name in names}
    record={'schemaVersion':1,'repository':'getsimpledirect/vinci-code-cli','repositoryId':'1345288037','tag':'vinci-v'+version,'version':version,'source':source,'producerRunId':'101','producerRunAttempt':'1','files':{name:SHA(raw) for name,raw in values.items()}}
    values['candidate.json']=(json.dumps(record)+'\n').encode()
    values['staged-archive-put.json']=b'{}\n'
    values['staged-checksum-put.json']=b'{}\n'
    return values

def archive(path,values,compression=zipfile.ZIP_DEFLATED,custom=None):
    with warnings.catch_warnings():
        warnings.simplefilter('ignore',UserWarning)
        with zipfile.ZipFile(path,'w',compression=compression) as zipped:
            for name,raw in values.items():
                info=zipfile.ZipInfo(name)
                info.create_system=3
                info.external_attr=(stat.S_IFREG|0o644)<<16
                info.compress_type=compression
                if custom:custom(info)
                zipped.writestr(info,raw)

def rewrite_member(path,name='install.sh',central_extra=b'',local_extra=b'',central_fields=None,local_fields=None):
    """Keep payload/CRC/receipt bytes intact while independently changing raw member metadata."""
    raw=path.read_bytes();eocd=raw.rfind(b'PK\x05\x06')
    count=struct.unpack_from('<H',raw,eocd+10)[0]
    central_offset=struct.unpack_from('<I',raw,eocd+16)[0]
    records=[];cursor=central_offset
    for _ in range(count):
        header=bytearray(raw[cursor:cursor+46])
        name_length,extra_length,comment_length=struct.unpack_from('<HHH',header,28)
        start=cursor+46
        records.append({'header':header,'name':raw[start:start+name_length],'extra':raw[start+name_length:start+name_length+extra_length],'comment':raw[start+name_length+extra_length:start+name_length+extra_length+comment_length],'offset':struct.unpack_from('<I',header,42)[0]})
        cursor=start+name_length+extra_length+comment_length
    locals=[];new_offsets={};position=0
    ordered=sorted(records,key=lambda r:r['offset'])
    for index,record in enumerate(ordered):
        end=ordered[index+1]['offset'] if index+1<len(ordered) else central_offset
        segment=raw[record['offset']:end]
        header=bytearray(segment[:30]);name_length,extra_length=struct.unpack_from('<HH',header,26)
        entry_name=segment[30:30+name_length]
        extra=segment[30+name_length:30+name_length+extra_length]
        if entry_name.decode()==name:
            extra+=local_extra;struct.pack_into('<H',header,28,len(extra))
            for offset,(format,value) in (local_fields or {}).items():struct.pack_into(format,header,offset,value)
        rebuilt=bytes(header)+entry_name+extra+segment[30+name_length+extra_length:]
        new_offsets[record['offset']]=position;position+=len(rebuilt);locals.append(rebuilt)
    central=[]
    for record in records:
        header=record['header'];extra=record['extra']
        struct.pack_into('<I',header,42,new_offsets[record['offset']])
        if record['name'].decode()==name:
            extra+=central_extra;struct.pack_into('<H',header,30,len(extra))
            for offset,(format,value) in (central_fields or {}).items():struct.pack_into(format,header,offset,value)
        central.append(bytes(header)+record['name']+extra+record['comment'])
    central=b''.join(central);footer=bytearray(raw[eocd:])
    struct.pack_into('<I',footer,12,len(central));struct.pack_into('<I',footer,16,position)
    path.write_bytes(b''.join(locals)+central+footer)

def force_zip64_member(path,values):
    with zipfile.ZipFile(path,'w',compression=zipfile.ZIP_DEFLATED) as zipped:
        for name,raw in values.items():
            info=zipfile.ZipInfo(name);info.create_system=3;info.external_attr=(stat.S_IFREG|0o644)<<16;info.compress_type=zipfile.ZIP_DEFLATED
            if name=='install.sh':
                with zipped.open(info,'w',force_zip64=True) as stream:stream.write(raw)
            else:zipped.writestr(info,raw)

class Extraction(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='vinci-zip-boundary-')
        self.root=Path(self.temp.name).resolve()
        self.zip=self.root/'input.zip'
        self.values=files()
        self.expected=SHA(self.values['candidate.json'])
        self.destination=self.root/'candidate'
    def tearDown(self):self.temp.cleanup()
    def run_extract(self):return module.extract(self.zip,self.destination,'0.0.58',self.expected,'a'*40,'101','1')
    def refuse(self):
        with self.assertRaises(Exception):self.run_extract()
    def test_deflated_valid(self):
        archive(self.zip,self.values)
        result=self.run_extract()
        self.assertTrue(result['reviewedReceiptMatched'])
        self.assertEqual(set(result['files']),set(self.values))
        self.assertFalse((self.destination/'.INCOMPLETE').exists())
        self.assertTrue(all(stat.S_IMODE(p.stat().st_mode)==0o600 for p in self.destination.iterdir()))
    def test_stored_valid(self):
        archive(self.zip,self.values,zipfile.ZIP_STORED)
        self.assertTrue(self.run_extract()['safeBasenamesOnly'])
    def test_missing(self):
        del self.values['manifest-beta.json'];archive(self.zip,self.values);self.refuse()
    def test_duplicate(self):
        archive(self.zip,self.values)
        with warnings.catch_warnings():
            warnings.simplefilter('ignore',UserWarning)
            with zipfile.ZipFile(self.zip,'a') as zipped:zipped.writestr('candidate.json',b'changed')
        self.refuse()
    def test_unexpected_file(self):
        self.values['other.sh']=b'not executed';archive(self.zip,self.values);self.refuse()
    def test_traversal(self):
        self.values['../outside']=self.values.pop('install.sh');archive(self.zip,self.values);self.refuse()
        self.assertFalse((self.root/'outside').exists())
    def test_absolute(self):
        self.values['/outside']=self.values.pop('install.sh');archive(self.zip,self.values);self.refuse()
    def test_backslash(self):
        self.values['..\\outside']=self.values.pop('install.sh');archive(self.zip,self.values);self.refuse()
    def test_nested(self):
        self.values['folder/install.sh']=self.values.pop('install.sh');archive(self.zip,self.values);self.refuse()
    def test_symlink(self):
        archive(self.zip,self.values,custom=lambda info:setattr(info,'external_attr',(stat.S_IFLNK|0o777)<<16) if info.filename=='install.sh' else None)
        self.refuse()
    def test_device(self):
        archive(self.zip,self.values,custom=lambda info:setattr(info,'external_attr',(stat.S_IFCHR|0o600)<<16) if info.filename=='install.sh' else None)
        self.refuse()
    def test_existing_destination(self):
        archive(self.zip,self.values);self.destination.mkdir();sentinel=self.destination/'sentinel';sentinel.write_text('preserve')
        self.refuse();self.assertEqual(sentinel.read_text(),'preserve')
    def test_symlink_destination(self):
        archive(self.zip,self.values);other=self.root/'other';other.mkdir();self.destination.symlink_to(other,target_is_directory=True)
        self.refuse();self.assertEqual(list(other.iterdir()),[])
    def test_bad_receipt_digest(self):
        archive(self.zip,self.values);self.expected='0'*64;self.refuse();self.assertTrue((self.destination/'.INCOMPLETE').exists())
    def test_changed_file(self):
        self.values['install.sh']=b'changed';archive(self.zip,self.values);self.refuse();self.assertTrue((self.destination/'.INCOMPLETE').exists())
    def test_wrong_source(self):
        record=json.loads(self.values['candidate.json']);record['source']='b'*40
        self.values['candidate.json']=json.dumps(record).encode();self.expected=SHA(self.values['candidate.json']);archive(self.zip,self.values);self.refuse()
    def test_duplicate_json_key(self):
        value=self.values['candidate.json'].decode().replace('{','{"schemaVersion":2,',1)
        self.values['candidate.json']=value.encode();self.expected=SHA(self.values['candidate.json']);archive(self.zip,self.values);self.refuse()
    def test_member_bound(self):
        self.values['manifest-beta.json']=b'x'*65537;archive(self.zip,self.values);self.refuse();self.assertFalse(self.destination.exists())
    def test_unsupported_compression(self):
        archive(self.zip,self.values,zipfile.ZIP_BZIP2);self.refuse()
    def test_archive_bound(self):
        with self.zip.open('wb') as stream:stream.truncate(module.ARCHIVE_LIMIT+1)
        self.refuse()
    def test_central_count_bound(self):
        archive(self.zip,self.values);raw=bytearray(self.zip.read_bytes());index=raw.rfind(b'PK\x05\x06');struct.pack_into('<HH',raw,index+8,65535,65535);self.zip.write_bytes(raw);self.refuse()
    def test_local_name_mismatch(self):
        archive(self.zip,self.values);raw=bytearray(self.zip.read_bytes());raw[30]=ord('X');self.zip.write_bytes(raw);self.refuse()
    def test_crc_refusal(self):
        archive(self.zip,self.values,zipfile.ZIP_STORED);raw=bytearray(self.zip.read_bytes());length,extra=struct.unpack_from('<HH',raw,26);raw[30+length+extra]^=1;self.zip.write_bytes(raw);self.refuse()
    def test_stream_descriptor_zip(self):
        class NonSeek(io.BytesIO):
            def seekable(self):return False
            def seek(self,*args):raise io.UnsupportedOperation('nonseekable')
        output=NonSeek()
        with zipfile.ZipFile(output,'w',compression=zipfile.ZIP_DEFLATED) as zipped:
            for name,value in self.values.items():zipped.writestr(name,value)
        self.zip.write_bytes(output.getvalue());self.assertTrue(self.run_extract()['reviewedReceiptMatched'])
    def metadata_refusal(self):
        self.refuse();self.assertFalse(self.destination.exists(),'Reject raw indicators before any extraction writes')
    def test_force_zip64_member_below_archive_threshold(self):
        force_zip64_member(self.zip,self.values);self.metadata_refusal()
    def test_local_zip64_extra_without_sentinel(self):
        archive(self.zip,self.values);rewrite_member(self.zip,local_extra=struct.pack('<HHQQ',1,16,1,1));self.metadata_refusal()
    def test_central_zip64_extra_without_sentinel(self):
        archive(self.zip,self.values);rewrite_member(self.zip,central_extra=struct.pack('<HHQQ',1,16,1,1));self.metadata_refusal()
    def test_local_zip64_size_sentinel(self):
        archive(self.zip,self.values);rewrite_member(self.zip,local_fields={18:('<I',0xffffffff),22:('<I',0xffffffff)});self.metadata_refusal()
    def test_central_zip64_sizes_decoded_by_zipinfo(self):
        archive(self.zip,self.values)
        with zipfile.ZipFile(self.zip) as zipped:member=zipped.getinfo('install.sh');size=member.file_size;compressed=member.compress_size
        rewrite_member(self.zip,central_extra=struct.pack('<HHQQ',1,16,size,compressed),central_fields={20:('<I',0xffffffff),24:('<I',0xffffffff)})
        self.metadata_refusal()
    def test_central_zip64_offset_decoded_by_zipinfo(self):
        archive(self.zip,self.values)
        with zipfile.ZipFile(self.zip) as zipped:offset=zipped.getinfo('install.sh').header_offset
        rewrite_member(self.zip,central_extra=struct.pack('<HHQ',1,8,offset),central_fields={42:('<I',0xffffffff)});self.metadata_refusal()
    def test_local_zip64_version_marker(self):
        archive(self.zip,self.values);rewrite_member(self.zip,local_fields={4:('<H',45)});self.metadata_refusal()
    def test_central_zip64_version_marker(self):
        archive(self.zip,self.values);rewrite_member(self.zip,central_fields={6:('<H',45)});self.metadata_refusal()
    def test_member_disk_one_while_footer_disk_zero(self):
        archive(self.zip,self.values);rewrite_member(self.zip,central_fields={34:('<H',1)});self.metadata_refusal()
    def test_member_disk_sentinel_while_footer_disk_zero(self):
        archive(self.zip,self.values);rewrite_member(self.zip,central_fields={34:('<H',0xffff)});self.metadata_refusal()
    def test_member_zip64_disk_extra_with_sentinel(self):
        archive(self.zip,self.values);rewrite_member(self.zip,central_extra=struct.pack('<HHI',1,4,0),central_fields={34:('<H',0xffff)});self.metadata_refusal()
    def test_footer_disk_one(self):
        archive(self.zip,self.values);raw=bytearray(self.zip.read_bytes());index=raw.rfind(b'PK\x05\x06');struct.pack_into('<H',raw,index+4,1);self.zip.write_bytes(raw);self.metadata_refusal()
    def test_footer_central_disk_one(self):
        archive(self.zip,self.values);raw=bytearray(self.zip.read_bytes());index=raw.rfind(b'PK\x05\x06');struct.pack_into('<H',raw,index+6,1);self.zip.write_bytes(raw);self.metadata_refusal()
    def test_truncated_local_extra(self):
        archive(self.zip,self.values);rewrite_member(self.zip,local_extra=struct.pack('<HH',0xcafe,8)+b'x');self.metadata_refusal()
    def test_truncated_central_extra(self):
        archive(self.zip,self.values);rewrite_member(self.zip,central_extra=struct.pack('<HH',0xcafe,8)+b'x');self.metadata_refusal()
    def test_benign_extra_fields_remain_supported(self):
        archive(self.zip,self.values);extra=struct.pack('<HH',0xcafe,3)+b'abc';rewrite_member(self.zip,local_extra=extra,central_extra=extra)
        self.assertTrue(self.run_extract()['reviewedReceiptMatched'])
    def test_zip64_like_bytes_in_opaque_comment_are_not_a_format_indicator(self):
        archive(self.zip,self.values)
        with zipfile.ZipFile(self.zip,'a') as zipped:zipped.comment=b'Opaque comment PK\x06\x06 ZIP64 \x01\x00'
        self.assertTrue(self.run_extract()['reviewedReceiptMatched'])

if __name__=='__main__':
    if len(sys.argv)>1 and sys.argv[1]=='--fixture':
        path=Path(sys.argv[2]);values=files();archive(path,values)
        print(json.dumps({'receiptSha256':SHA(values['candidate.json']),'archiveSha256':SHA(path.read_bytes()),'bytes':path.stat().st_size}))
    else:unittest.main()
