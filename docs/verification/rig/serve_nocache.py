import http.server, socketserver, sys

ROOT = sys.argv[1]
PORT = int(sys.argv[2])


class H(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *a, **kw):
        super().__init__(*a, directory=ROOT, **kw)

    def send_head(self):
        # Never honour conditional requests. A 304 here let the browser reuse a
        # bundle cached from the OTHER tree, which silently corrupted an earlier
        # baseline campaign (it measured the fixed bundle as "baseline").
        for h in ('If-Modified-Since', 'If-None-Match', 'If-Range'):
            try:
                del self.headers[h]
            except KeyError:
                pass
        return super().send_head()

    def end_headers(self):
        self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0')
        self.send_header('Pragma', 'no-cache')
        self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, *a):
        pass


class S(socketserver.ThreadingTCPServer):
    allow_reuse_address = True


S(('0.0.0.0', PORT), H).serve_forever()
