"""Ranh giới HTTP cho ứng dụng local một người dùng."""
import os
import re
from urllib.parse import urlsplit

from starlette.responses import JSONResponse

MAX_BODY_BYTES = 1_048_576


class LocalRequestBoundary:
    def __init__(self, app):
        self.app = app
        self.extension_ids = {value.strip() for value in os.environ.get('POINTSNAP_EXTENSION_IDS', '').split(',') if value.strip()}
        self.hosts = {'localhost', '127.0.0.1', '::1'} | {
            value.strip().lower() for value in os.environ.get('POINTSNAP_ALLOWED_HOSTS', '').split(',') if value.strip()
        }

    async def __call__(self, scope, receive, send):
        if scope['type'] != 'http':
            return await self.app(scope, receive, send)
        headers = {key.lower(): value.decode('latin-1') for key, value in scope['headers']}

        async def deny(status, message):
            response = JSONResponse({'detail': message}, status_code=status,
                                    headers={'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff'})
            await response(scope, receive, send)

        for key in (b'host', b'origin', b'content-length'):
            if sum(k.lower() == key for k, _ in scope['headers']) > 1:
                return await deny(400, 'Header HTTP bị lặp.')

        try:
            host = urlsplit('//'+headers.get(b'host', '')).hostname
            # TestClient dùng transport nội bộ, không phải peer TCP của Uvicorn.
            test_transport = host == 'testserver' and (scope.get('client') or ('',))[0] == 'testclient'
            if host not in self.hosts and not test_transport:
                return await deny(403, 'Host không được phép; dùng địa chỉ local đã cấu hình.')
            origin = headers.get(b'origin')
            extension = bool(origin and re.fullmatch(r'chrome-extension://[a-p]{32}', origin))
            if extension and self.extension_ids and scope['method'] in ('POST', 'PUT', 'DELETE', 'PATCH'):
                if origin.split('://', 1)[1] not in self.extension_ids:
                    return await deny(403, 'Extension chưa được cấp quyền ghi; cấu hình POINTSNAP_EXTENSION_IDS.')
            if origin and not extension:
                parsed = urlsplit(origin)
                target = urlsplit(f"{scope['scheme']}://{headers.get(b'host', '')}")
                def identity(url):
                    return url.scheme, url.hostname, url.port or (443 if url.scheme == 'https' else 80)
                if (parsed.scheme not in ('http', 'https') or parsed.username or parsed.password
                        or parsed.path or parsed.query or parsed.fragment or identity(parsed) != identity(target)):
                    return await deny(403, 'Origin không được phép.')
            if headers.get(b'sec-fetch-site') == 'cross-site' and not extension:
                return await deny(403, 'Request từ website khác không được phép.')
            length = headers.get(b'content-length')
            if length and (not length.isdigit() or int(length) > MAX_BODY_BYTES):
                return await deny(413, 'Payload vượt giới hạn 1 MiB hoặc Content-Length không hợp lệ.')
        except ValueError:
            return await deny(403, 'Host/Origin không hợp lệ.')

        # Đọc từng chunk có giới hạn, cả khi caller không gửi Content-Length.
        body = bytearray()
        while True:
            message = await receive()
            if message['type'] == 'http.disconnect':
                return
            body.extend(message.get('body', b''))
            if len(body) > MAX_BODY_BYTES:
                return await deny(413, 'Payload vượt giới hạn 1 MiB.')
            if not message.get('more_body', False):
                break
        delivered = False

        async def bounded_receive():
            nonlocal delivered
            if not delivered:
                delivered = True
                return {'type': 'http.request', 'body': bytes(body), 'more_body': False}
            return await receive()

        async def private_send(message):
            if message['type'] == 'http.response.start':
                extra = [(b'x-content-type-options', b'nosniff'), (b'referrer-policy', b'no-referrer'), (b'x-frame-options', b'DENY')]
                if scope['path'].startswith('/api/'):
                    message['headers'] = [(k,v) for k,v in message['headers'] if k.lower() != b'cache-control']
                    extra.append((b'cache-control', b'private, no-store'))
                message['headers'] += extra
            await send(message)
        await self.app(scope, bounded_receive, private_send)
