#!/usr/bin/env python3
"""Local-only, no-cache static server for the isolated Stage C capture rig."""
import http.server
import socketserver
import sys

ROOT = sys.argv[1]
PORT = int(sys.argv[2])
HOST = '127.0.0.1'


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=ROOT, **kwargs)

    def send_head(self):
        # Never let Chromium satisfy a request from a cached bundle.
        for header in ('If-Modified-Since', 'If-None-Match', 'If-Range'):
            try:
                del self.headers[header]
            except KeyError:
                pass
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *args):
        pass


class Server(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


Server((HOST, PORT), Handler).serve_forever()
