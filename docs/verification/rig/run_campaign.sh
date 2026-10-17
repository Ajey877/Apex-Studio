#!/bin/bash
# $1 = tree dir, $2 = output filename, $3 = engine run count
TREE=$1; OUT=$2; N=${3:-100}
export LD_LIBRARY_PATH=/tmp/scz/libs/lib
cd /home/user/$TREE
export RIG_PORT=8099 RIG_CDP=http://127.0.0.1:9222
export RIG_CONDITIONS="[
 {\"label\":\"gapProof\",\"kind\":\"gapProof\",\"sampleRate\":44100,\"bufferSize\":4096,\"repeats\":3},
 {\"label\":\"bare_reused_60\",\"mode\":\"bare\",\"contextMode\":\"reused\",\"runs\":60,\"bpm\":120,\"sampleRate\":44100,\"lateStep\":8,\"refDelay\":0.5,\"smallDelays\":[0.05,0.1],\"bufferSize\":4096},
 {\"label\":\"bare_fresh_30\",\"mode\":\"bare\",\"contextMode\":\"fresh\",\"runs\":30,\"bpm\":120,\"sampleRate\":44100,\"lateStep\":8,\"refDelay\":0.5,\"smallDelays\":[0.05,0.1],\"bufferSize\":4096},
 {\"label\":\"engine_reused\",\"mode\":\"engine\",\"contextMode\":\"reused\",\"runs\":$N,\"bpm\":120,\"lateStep\":8,\"refDelay\":0.5,\"bufferSize\":4096}
]"
mkdir -p results
timeout 1200 node scratch-rig/run-transport.mjs > results/$OUT 2>results/$OUT.log
echo "exit=$?"
echo "wrote results/$OUT"
