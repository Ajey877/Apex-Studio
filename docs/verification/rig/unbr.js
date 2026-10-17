const fs=require('fs'),zlib=require('zlib');
const [inp,out]=process.argv.slice(2);
fs.writeFileSync(out, zlib.brotliDecompressSync(fs.readFileSync(inp)));
console.log('ok', inp, '->', out, fs.statSync(out).size);
