"""Offline authorization checks for privileged loopback Flask controls."""

import base64
import json
import os
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

from flask import Flask


STUDENTS_DIR = Path(__file__).resolve().parents[2] / 'TimeInAndTimeOutMonitoring' / 'students'
sys.path.insert(0, str(STUDENTS_DIR))
from local_admin_auth import active_admin_aal2, local_service_or_admin, require_admin_aal2


USER_ID = '11111111-1111-4111-8111-111111111111'


def bearer(aal='aal2', subject=USER_ID):
    payload = base64.urlsafe_b64encode(json.dumps({
        'sub': subject, 'role': 'authenticated', 'aal': aal,
    }).encode()).decode().rstrip('=')
    return 'Bearer header.' + payload + '.signature'


class LocalAdminAuthTests(unittest.TestCase):
    def setUp(self):
        self.app = Flask(__name__)
        self.environment = patch.dict(os.environ, {
            'SUPABASE_URL': 'https://example.supabase.co',
            'SUPABASE_KEY': 'public-test-key',
            'LOCAL_SERVICE_TOKEN': 'fixture-only-local-token',
        })
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def lookup(self, level='admin', status='active'):
        def response(url, headers):
            if url.endswith('/auth/v1/user'):
                return {'id': USER_ID}
            if '/rest/v1/admins?' in url:
                return [{'admin_id': USER_ID, 'admin_level': level, 'status': status}]
            raise AssertionError('Unexpected API lookup')
        return response

    def test_aal2_admin_and_super_admin_are_allowed(self):
        with patch('local_admin_auth._read_json', side_effect=self.lookup()):
            self.assertTrue(active_admin_aal2(bearer()))
            self.assertFalse(active_admin_aal2(bearer(), super_only=True))
        with patch('local_admin_auth._read_json', side_effect=self.lookup('super_admin')):
            self.assertTrue(active_admin_aal2(bearer(), super_only=True))

    def test_missing_aal1_suspended_and_mismatched_identity_are_denied(self):
        with patch('local_admin_auth._read_json', side_effect=self.lookup()):
            self.assertFalse(active_admin_aal2(''))
            self.assertFalse(active_admin_aal2(bearer('aal1')))
            self.assertFalse(active_admin_aal2(bearer(subject='other-user')))
        with patch('local_admin_auth._read_json', side_effect=self.lookup(status='suspended')):
            self.assertFalse(active_admin_aal2(bearer()))

    def test_flask_control_requires_aal2(self):
        @require_admin_aal2
        def control():
            return 'allowed', 200

        with patch('local_admin_auth._read_json', side_effect=self.lookup()):
            with self.app.test_request_context('/control', method='POST'):
                self.assertEqual(control()[1], 403)
            with self.app.test_request_context('/control', method='POST',
                                               headers={'Authorization': bearer('aal1')}):
                self.assertEqual(control()[1], 403)
            with self.app.test_request_context('/control', method='POST',
                                               headers={'Authorization': bearer()}):
                self.assertEqual(control(), ('allowed', 200))

    def test_local_service_token_requires_loopback_and_exact_match(self):
        with self.app.test_request_context('/rebuild', method='POST',
                                           headers={'X-REBUILD-TOKEN': 'fixture-only-local-token'},
                                           environ_base={'REMOTE_ADDR': '127.0.0.1'}):
            self.assertTrue(local_service_or_admin())
        with self.app.test_request_context('/rebuild', method='POST',
                                           headers={'X-REBUILD-TOKEN': 'wrong'},
                                           environ_base={'REMOTE_ADDR': '127.0.0.1'}):
            self.assertFalse(local_service_or_admin())
        with self.app.test_request_context('/rebuild', method='POST',
                                           headers={'X-REBUILD-TOKEN': 'fixture-only-local-token'},
                                           environ_base={'REMOTE_ADDR': '198.51.100.8'}):
            self.assertFalse(local_service_or_admin())


if __name__ == '__main__':
    unittest.main()
