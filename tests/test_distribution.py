import io
import json
from pathlib import Path
import sys
import tempfile
import threading
import unittest
from unittest.mock import patch
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))
import server
from scripts.package import build, source_files


class DistributionTests(unittest.TestCase):
    def test_archive_contains_only_distributable_source(self):
        files = [p.relative_to(ROOT).as_posix() for p in source_files()]
        self.assertIn('LICENSE', files)
        self.assertIn('web/transport.js', files)
        self.assertTrue(all(not p.startswith(('recordings/', 'research/', '.runtime/', 'web/downloads/')) for p in files))
        with tempfile.TemporaryDirectory() as folder:
            output = build(Path(folder) / 'workbench.zip')
            with zipfile.ZipFile(output) as archive:
                self.assertEqual(len(archive.namelist()), len(set(files)))
                self.assertTrue(all(p.startswith('OpenBCI-Research-Workbench/') for p in archive.namelist()))
            self.assertTrue(output.with_suffix('.zip.sha256').is_file())

    def test_completed_record_download_and_active_session_protection(self):
        acquisition = server.Acquisition()
        with tempfile.TemporaryDirectory() as directory:
            acquisition.folder = Path(directory) / 'test_session'
            acquisition.folder.mkdir()
            for name, content in {'raw.csv':'index,eeg\n0,10\n','events.tsv':'event_id\tvalue\n','metadata.json':'{}','bridge.log':'test\n'}.items():
                (acquisition.folder / name).write_text(content)
            acquisition.info.update(samples=1, recording='test_session')
            with patch.object(server, 'ACQUISITION', acquisition):
                http = server.ThreadingHTTPServer(('127.0.0.1',0), server.Handler)
                thread = threading.Thread(target=http.serve_forever, daemon=True)
                thread.start()
                url = f'http://127.0.0.1:{http.server_port}'
                try:
                    with urllib.request.urlopen(url+'/api/recording') as response:
                        self.assertEqual(response.headers.get_content_type(), 'application/zip')
                        with zipfile.ZipFile(io.BytesIO(response.read())) as archive:
                            self.assertEqual(archive.read('test_session/raw.csv'), b'index,eeg\n0,10\n')
                            self.assertEqual(len(archive.namelist()),4)
                    acquisition.info['running'] = True
                    with self.assertRaises(urllib.error.HTTPError) as blocked:
                        urllib.request.urlopen(url+'/api/recording')
                    self.assertEqual(blocked.exception.code,409)
                    blocked.exception.close()
                    request = urllib.request.Request(url+'/api/status',headers={'Origin':'https://example.org'})
                    with self.assertRaises(urllib.error.HTTPError) as blocked:
                        urllib.request.urlopen(request)
                    self.assertEqual(blocked.exception.code,403)
                    blocked.exception.close()
                finally:
                    http.shutdown(); http.server_close(); thread.join()


if __name__ == '__main__': unittest.main()
