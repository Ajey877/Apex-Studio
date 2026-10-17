#!/bin/bash
set -e
mkdir -p /tmp/scz && cd /tmp/scz
curl -sL "https://registry.npmjs.org/@sparticuz/chromium/-/chromium-153.0.0.tgz" -o chromium.tgz
echo "tarball: $(wc -c < chromium.tgz) bytes"
rm -rf package
tar xzf chromium.tgz
echo "--- package/bin ---"
ls -la package/bin/ | head -20

# decompress main chromium binary
cd /tmp/scz/package/bin
for f in *.br; do
  [ -f "$f" ] || continue
  out="${f%.br}"
  if command -v brotli >/dev/null 2>&1; then brotli -d "$f" -o "$out"
  else python3 -c "import brotli;open('$out','wb').write(brotli.decompress(open('$f','rb').read()))"
  fi
  echo "decompressed $f -> $out"
done
chmod +x /tmp/scz/package/bin/chromium 2>/dev/null || true

# decompress + extract shared-library tarballs
mkdir -p /tmp/scz/libs && cd /tmp/scz/libs
for f in /tmp/scz/package/bin/*.tar.br /tmp/scz/package/*.tar.br; do
  [ -f "$f" ] || continue
  out="${f%.br}"
  if command -v brotli >/dev/null 2>&1; then brotli -d "$f" -o "$out"
  else python3 -c "import brotli;open('$out','wb').write(brotli.decompress(open('$f','rb').read()))"
  fi
  echo "extracting $out"
  tar xf "$out" 2>/dev/null || true
done

echo "=== result ==="
ls /tmp/scz/libs/lib 2>/dev/null | wc -l
echo "libs:"
ls /tmp/scz/libs/lib 2>/dev/null | head -15
echo "chromium version:"
LD_LIBRARY_PATH=/tmp/scz/libs/lib /tmp/scz/package/bin/chromium --version 2>&1 | head -3
echo "DONE"
