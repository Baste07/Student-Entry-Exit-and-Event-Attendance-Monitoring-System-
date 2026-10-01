"""Authorization for infrequent browser controls on the loopback Flask engines.

Recognition frames never call this module. Supabase Auth verifies the bearer;
the profile and AAL are checked before a control operation is accepted.
"""
import base64
import functools
import hmac
import json
import os
import urllib.parse
import urllib.request

from flask import jsonify, request


def _read_json(url, headers):
    with urllib.request.urlopen(urllib.request.Request(url, headers=headers), timeout=4) as response:
        return json.load(response)


def active_admin_aal2(authorization, super_only=False):
    if not authorization.startswith('Bearer '):
        return False
    token = authorization[7:].strip()
    url = (os.getenv('SUPABASE_URL') or '').rstrip('/')
    key = os.getenv('SUPABASE_KEY') or ''
    if not token or not url or not key:
        return False
    try:
        identity = _read_json(url + '/auth/v1/user', {
            'apikey': key, 'Authorization': 'Bearer ' + token,
        })
        user_id = identity.get('id')
        claims = json.loads(base64.urlsafe_b64decode(token.split('.')[1] + '==='))
        if not user_id or claims.get('sub') != user_id or claims.get('role') != 'authenticated' \
                or claims.get('aal') != 'aal2':
            return False
        query = urllib.parse.urlencode({
            'admin_id': 'eq.' + user_id, 'select': 'admin_id,admin_level,status', 'limit': '1',
        })
        profiles = _read_json(url + '/rest/v1/admins?' + query, {
            'apikey': key, 'Authorization': 'Bearer ' + token,
        })
        if not isinstance(profiles, list) or len(profiles) != 1:
            return False
        profile = profiles[0]
        return profile.get('status') == 'active' and profile.get('admin_id') == user_id \
            and profile.get('admin_level') in (('super_admin',) if super_only else ('admin', 'super_admin'))
    except (IndexError, ValueError, OSError, TypeError, KeyError):
        return False


def require_admin_aal2(function):
    @functools.wraps(function)
    def guarded(*args, **kwargs):
        if not active_admin_aal2(request.headers.get('Authorization', '')):
            return jsonify({'success': False, 'message': 'Active Admin MFA session required.'}), 403
        return function(*args, **kwargs)
    return guarded


def local_service_or_admin():
    expected = (os.getenv('REBUILD_SECRET') or os.getenv('LOCAL_SERVICE_TOKEN') or '').strip()
    provided = request.headers.get('X-REBUILD-TOKEN', '')
    if request.remote_addr in ('127.0.0.1', '::1') and expected and provided \
            and hmac.compare_digest(expected, provided):
        return True
    return active_admin_aal2(request.headers.get('Authorization', ''))
