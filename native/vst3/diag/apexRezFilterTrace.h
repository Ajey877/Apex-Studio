// Diagnostic-only, read-only MDA RezFilter internal-state trace.
// Never compiled into production. Snapshots copy existing member bits;
// they must not assign DSP state. No disk or locks on the audio thread.
#pragma once
#ifdef _MSC_VER
#define _CRT_SECURE_NO_WARNINGS
#endif
#include <cstdint>
#include <cstring>
#include <cstdio>
#include <cmath>
#include <cstdlib>
#ifdef _WIN32
#include <process.h>
#include <windows.h>
#define apex_getpid() _getpid()
#else
#include <unistd.h>
#define apex_getpid() getpid()
#endif

struct ApexRezChan {
  uint32_t nonzero;
  uint32_t nanInf;
  uint32_t peak_bits;
  uint32_t rms_bits;
};

struct ApexRezTraceRec {
  char stage[24];
  char sessionId[48];
  char classId[48];
  uint64_t instanceGen;
  uint32_t pid;
  uint32_t sequence;
  uint32_t block;
  uint32_t flags;
  uint64_t stampMs;
  uint32_t env_bits, env2_bits, phi_bits, bufl_bits, buf0_bits, buf1_bits, buf2_bits;
  uint32_t fff_bits, fenv_bits, flfo_bits, dphi_bits, fq_bits, fg_bits, fmax_bits;
  uint32_t att_bits, rel_bits, tthr_bits, p0_bits, p1_bits, p3_bits, p6_bits, p8_bits, p9_bits;
  int32_t tatt, ttrig, lfomode;
  uint32_t fFirst_bits, fLast_bits, fMinFinite_bits, fMaxFinite_bits, fNegExample_bits;
  uint32_t framesFNeg, framesFNan, framesFInf, framesFFinite, framesIZero, frames;
  ApexRezChan inL, inR, outL, outR;
};

// 66 host blocks * 64 internal 16-frame slices * pre+post + lifecycle headroom.
constexpr int APEX_REZ_INST_CAP = 2;
constexpr int APEX_REZ_TRACE_CAP = 12288;

struct ApexRezInst {
  uint64_t gen;
  uint32_t pid;
  char sessionId[48];
  char classId[48];
  uint32_t sequence;
  uint32_t dropped;
  int count;
  bool flushed;
  uint32_t frames;
  uint32_t fNeg, fNan, fInf, fFinite, iZero;
  uint32_t fFirst_bits, fLast_bits, fMinFinite_bits, fMaxFinite_bits, fNegExample_bits;
  bool haveF, haveFinite;
  ApexRezChan inL, inR, outL, outR;
  ApexRezTraceRec recs[APEX_REZ_TRACE_CAP];
};

static ApexRezInst gApexRezInst[APEX_REZ_INST_CAP];
static uint64_t gApexRezNextGen = 1;
static int gApexRezCurrent = -1;
static bool gApexRezSelfTestRan = false;

inline uint32_t apexRezBits(float value) {
  uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  return bits;
}

inline float apexRezFromBits(uint32_t bits) {
  float value = 0;
  std::memcpy(&value, &bits, sizeof(value));
  return value;
}

inline uint32_t apexRezNanInf(float value) {
  return std::isfinite(value) ? 0u : 1u;
}

inline uint64_t apexRezNowMs() {
#ifdef _WIN32
  return GetTickCount64();
#else
  return 0;
#endif
}

inline void apexRezScanChannel(const float* samples, uint32_t frames, ApexRezChan& ch) {
  ch = {};
  if (!samples || !frames) return;
  double square = 0;
  float peak = 0;
  for (uint32_t i = 0; i < frames; ++i) {
    const float sample = samples[i];
    if (!std::isfinite(sample)) {
      ++ch.nanInf;
      continue;
    }
    if (sample != 0.f) ++ch.nonzero;
    const float abs = sample < 0.f ? -sample : sample;
    if (abs > peak) peak = abs;
    square += double(sample) * double(sample);
  }
  ch.peak_bits = apexRezBits(peak);
  ch.rms_bits = apexRezBits(frames ? static_cast<float>(std::sqrt(square / double(frames))) : 0.f);
}

inline bool apexRezMeasurementSelfTest(char* err, size_t errCap) {
  auto fail = [&](const char* message) {
    if (err && errCap) std::snprintf(err, errCap, "%s", message);
    return false;
  };
  float inL[4] = { 0.5f, 0.f, -0.25f, 0.f };
  float inR[4] = { 0.f, 0.5f, 0.5f, 0.f };
  ApexRezChan left{}, right{};
  apexRezScanChannel(inL, 4, left);
  apexRezScanChannel(inR, 4, right);
  if (left.nonzero != 2 || right.nonzero != 2) return fail("stereo channels must be counted independently");
  float cancelL[1] = { 1.f };
  float cancelR[1] = { -1.f };
  ApexRezChan cL{}, cR{};
  apexRezScanChannel(cancelL, 1, cL);
  apexRezScanChannel(cancelR, 1, cR);
  if (cL.nonzero != 1 || cR.nonzero != 1) return fail("cancelling stereo sum must not hide per-channel nonzero");
  float nans[2] = { 0.f, 0.f };
  std::memset(&nans[1], 0xff, sizeof(float));
  nans[1] = std::nanf("");
  ApexRezChan nanCh{};
  apexRezScanChannel(nans, 2, nanCh);
  if (nanCh.nanInf != 1 || nanCh.nonzero != 0) return fail("NaN samples must increment nanInf, not nonzero");
  const float nanF = std::nanf("");
  const float negF = -0.2f;
  if (!(nanF < 0.f) && std::isfinite(negF) && negF < 0.f) return true;
  return fail("cutoff classifier self-test constants unexpected");
}

inline void apexRezCopyEnv(char* dest, size_t destSize, const char* key) {
  dest[0] = 0;
  if (const char* value = std::getenv(key))
    std::strncpy(dest, value, destSize - 1);
}

inline ApexRezInst* apexRezBind() {
  if (gApexRezCurrent >= 0 && gApexRezCurrent < APEX_REZ_INST_CAP && !gApexRezInst[gApexRezCurrent].flushed)
    return &gApexRezInst[gApexRezCurrent];
  for (int i = 0; i < APEX_REZ_INST_CAP; ++i) {
    if (gApexRezInst[i].gen == 0 || gApexRezInst[i].flushed) {
      ApexRezInst& inst = gApexRezInst[i];
      std::memset(&inst, 0, sizeof(inst));
      inst.gen = gApexRezNextGen++;
      inst.pid = static_cast<uint32_t>(apex_getpid());
      apexRezCopyEnv(inst.sessionId, sizeof(inst.sessionId), "APEX_REZFILTER_SESSION_ID");
      apexRezCopyEnv(inst.classId, sizeof(inst.classId), "APEX_REZFILTER_CLASS_ID");
      gApexRezCurrent = i;
      if (!gApexRezSelfTestRan) {
        gApexRezSelfTestRan = true;
        char err[192]{};
        const bool ok = apexRezMeasurementSelfTest(err, sizeof(err));
        if (const char* dir = std::getenv("APEX_REZFILTER_TRACE_DIR")) {
          char path[1024];
          std::snprintf(path, sizeof(path), "%s/pcm-selftest-pid-%u.json", dir, inst.pid);
          if (FILE* file = std::fopen(path, "w")) {
            std::fprintf(file, "{\"ok\":%s,\"pid\":%u,\"error\":\"%s\"}\n", ok ? "true" : "false", inst.pid, err);
            std::fclose(file);
          }
        }
      }
      return &inst;
    }
  }
  return nullptr;
}

inline void apexRezBeginBlock(uint32_t frames) {
  ApexRezInst* inst = apexRezBind();
  if (!inst) return;
  inst->frames = frames;
  inst->fNeg = inst->fNan = inst->fInf = inst->fFinite = inst->iZero = 0;
  inst->haveF = inst->haveFinite = false;
  inst->fFirst_bits = inst->fLast_bits = inst->fMinFinite_bits = inst->fMaxFinite_bits = inst->fNegExample_bits = 0;
  inst->inL = inst->inR = inst->outL = inst->outR = {};
}

inline void apexRezMeasureInputs(const float* left, const float* right, uint32_t frames) {
  ApexRezInst* inst = apexRezBind();
  if (!inst) return;
  inst->frames = frames;
  apexRezScanChannel(left, frames, inst->inL);
  apexRezScanChannel(right, frames, inst->inR);
}

inline void apexRezMeasureOutputs(const float* left, const float* right, uint32_t frames) {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (!inst) return;
  apexRezScanChannel(left, frames, inst->outL);
  apexRezScanChannel(right, frames, inst->outR);
}

inline void apexRezAccumCutoff(float f) {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (!inst) return;
  const uint32_t bits = apexRezBits(f);
  if (!inst->haveF) { inst->fFirst_bits = bits; inst->haveF = true; }
  inst->fLast_bits = bits;
  if (!std::isfinite(f)) {
    if (std::isnan(f)) ++inst->fNan;
    else ++inst->fInf;
    return;
  }
  ++inst->fFinite;
  const float cur = f;
  if (!inst->haveFinite) {
    inst->fMinFinite_bits = inst->fMaxFinite_bits = bits;
    inst->haveFinite = true;
  } else {
    if (cur < apexRezFromBits(inst->fMinFinite_bits)) inst->fMinFinite_bits = bits;
    if (cur > apexRezFromBits(inst->fMaxFinite_bits)) inst->fMaxFinite_bits = bits;
  }
  if (cur < 0.f) {
    ++inst->fNeg;
    if (!inst->fNegExample_bits) inst->fNegExample_bits = bits;
  }
}

inline void apexRezAccumIZero() {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (inst) ++inst->iZero;
}

#define APEX_REZ_SNAP(stage) apexRezTrace((stage), env, env2, phi, bufl, buf0, buf1, buf2, \
  fff, fenv, flfo, dphi, fq, fg, fmax, att, rel, tthr, tatt, ttrig, lfomode, \
  static_cast<float>(params[0]), static_cast<float>(params[1]), static_cast<float>(params[3]), \
  static_cast<float>(params[6]), static_cast<float>(params[8]), static_cast<float>(params[9]))

inline void apexRezTrace(const char* stage,
  float env, float env2, float phi, float bufl, float buf0, float buf1, float buf2,
  float fff, float fenv, float flfo, float dphi, float fq, float fg, float fmax,
  float att, float rel, float tthr, int32_t tatt, int32_t ttrig, int32_t lfomode,
  float p0, float p1, float p3, float p6, float p8, float p9)
{
  ApexRezInst* inst = apexRezBind();
  if (!inst) return;
  if (inst->count >= APEX_REZ_TRACE_CAP) { ++inst->dropped; return; }
  ApexRezTraceRec record{};
  std::strncpy(record.stage, stage, sizeof(record.stage) - 1);
  std::strncpy(record.sessionId, inst->sessionId, sizeof(record.sessionId) - 1);
  std::strncpy(record.classId, inst->classId, sizeof(record.classId) - 1);
  record.instanceGen = inst->gen;
  record.pid = inst->pid;
  record.sequence = inst->sequence;
  record.block = inst->sequence;
  record.stampMs = apexRezNowMs();
  record.flags = apexRezNanInf(env) | (apexRezNanInf(phi) << 1) | (apexRezNanInf(buf0) << 2) | (apexRezNanInf(fff) << 3);
  record.env_bits = apexRezBits(env); record.env2_bits = apexRezBits(env2);
  record.phi_bits = apexRezBits(phi); record.bufl_bits = apexRezBits(bufl);
  record.buf0_bits = apexRezBits(buf0); record.buf1_bits = apexRezBits(buf1); record.buf2_bits = apexRezBits(buf2);
  record.fff_bits = apexRezBits(fff); record.fenv_bits = apexRezBits(fenv);
  record.flfo_bits = apexRezBits(flfo); record.dphi_bits = apexRezBits(dphi);
  record.fq_bits = apexRezBits(fq); record.fg_bits = apexRezBits(fg); record.fmax_bits = apexRezBits(fmax);
  record.att_bits = apexRezBits(att); record.rel_bits = apexRezBits(rel); record.tthr_bits = apexRezBits(tthr);
  record.p0_bits = apexRezBits(p0); record.p1_bits = apexRezBits(p1); record.p3_bits = apexRezBits(p3);
  record.p6_bits = apexRezBits(p6); record.p8_bits = apexRezBits(p8); record.p9_bits = apexRezBits(p9);
  record.tatt = tatt; record.ttrig = ttrig; record.lfomode = lfomode;
  record.fFirst_bits = inst->fFirst_bits; record.fLast_bits = inst->fLast_bits;
  record.fMinFinite_bits = inst->fMinFinite_bits; record.fMaxFinite_bits = inst->fMaxFinite_bits;
  record.fNegExample_bits = inst->fNegExample_bits;
  record.framesFNeg = inst->fNeg; record.framesFNan = inst->fNan; record.framesFInf = inst->fInf;
  record.framesFFinite = inst->fFinite; record.framesIZero = inst->iZero; record.frames = inst->frames;
  record.inL = inst->inL; record.inR = inst->inR; record.outL = inst->outL; record.outR = inst->outR;
  inst->recs[inst->count++] = record;
  if (std::strncmp(stage, "process-post", 12) == 0)
    ++inst->sequence;
}

inline void apexRezWriteChan(FILE* json, const char* name, const ApexRezChan& ch) {
  std::fprintf(json,
    "\"%s\":{\"nonzero\":%u,\"nanInf\":%u,\"peak\":\"%08x\",\"rms\":\"%08x\"}",
    name, ch.nonzero, ch.nanInf, ch.peak_bits, ch.rms_bits);
}

// File I/O only after processing has stopped. Never call from doProcessing.
inline void apexRezTraceFlush() {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (!inst || inst->flushed) return;
  const char* dir = std::getenv("APEX_REZFILTER_TRACE_DIR");
  if (!dir || !dir[0]) return;
  char path[1024];
  std::snprintf(path, sizeof(path), "%s/rezfilter-pid-%u-gen-%llu-session-%s.json",
    dir, inst->pid, static_cast<unsigned long long>(inst->gen),
    inst->sessionId[0] ? inst->sessionId : "unknown");
  FILE* json = std::fopen(path, "w");
  if (!json) return;
  const ApexRezTraceRec* lastProcess = nullptr;
  uint32_t processRecs = 0;
  for (int i = 0; i < inst->count; ++i) {
    if (std::strncmp(inst->recs[i].stage, "process-", 8) == 0) {
      lastProcess = &inst->recs[i];
      ++processRecs;
    }
  }
  const char* origin = "unknown";
  if (lastProcess) {
    const bool inZero = lastProcess->inL.nonzero == 0 && lastProcess->inR.nonzero == 0;
    const bool outZero = lastProcess->outL.nonzero == 0 && lastProcess->outR.nonzero == 0;
    const bool outNan = lastProcess->outL.nanInf || lastProcess->outR.nanInf;
    const bool forced = lastProcess->frames && lastProcess->framesIZero == lastProcess->frames;
    if (inZero && outZero) origin = "zero-input";
    else if (outNan) origin = "non-finite-output";
    else if (forced && outZero) origin = "forced-zero-filter-input";
    else if (outZero) origin = "other-silent-output";
    else origin = "audible";
  }
  std::fprintf(json,
    "{\"pid\":%u,\"instanceGen\":%llu,\"sessionId\":\"%s\",\"classId\":\"%s\",\"count\":%d,"
    "\"dropped\":%u,\"flushed\":true,\"processRecords\":%u,\"capacity\":%d,\"silenceOrigin\":\"%s\","
    "\"cutoff\":{\"fFirst\":\"%08x\",\"fLast\":\"%08x\",\"fMinFinite\":\"%08x\",\"fMaxFinite\":\"%08x\","
    "\"fNegExample\":\"%08x\",\"framesFNeg\":%u,\"framesFNan\":%u,\"framesFInf\":%u,\"framesFFinite\":%u,"
    "\"framesIZero\":%u,\"frames\":%u},",
    inst->pid, static_cast<unsigned long long>(inst->gen), inst->sessionId, inst->classId,
    inst->count, inst->dropped, processRecs, APEX_REZ_TRACE_CAP, origin,
    lastProcess ? lastProcess->fFirst_bits : 0, lastProcess ? lastProcess->fLast_bits : 0,
    lastProcess ? lastProcess->fMinFinite_bits : 0, lastProcess ? lastProcess->fMaxFinite_bits : 0,
    lastProcess ? lastProcess->fNegExample_bits : 0,
    lastProcess ? lastProcess->framesFNeg : 0, lastProcess ? lastProcess->framesFNan : 0,
    lastProcess ? lastProcess->framesFInf : 0, lastProcess ? lastProcess->framesFFinite : 0,
    lastProcess ? lastProcess->framesIZero : 0, lastProcess ? lastProcess->frames : 0);
  if (lastProcess) {
    apexRezWriteChan(json, "inL", lastProcess->inL); std::fputc(',', json);
    apexRezWriteChan(json, "inR", lastProcess->inR); std::fputc(',', json);
    apexRezWriteChan(json, "outL", lastProcess->outL); std::fputc(',', json);
    apexRezWriteChan(json, "outR", lastProcess->outR); std::fputc(',', json);
  }
  std::fprintf(json, "\"records\":[");
  for (int i = 0; i < inst->count; ++i) {
    const ApexRezTraceRec& record = inst->recs[i];
    std::fprintf(json,
      "%s{\"stage\":\"%s\",\"sessionId\":\"%s\",\"classId\":\"%s\",\"instanceGen\":%llu,\"pid\":%u,"
      "\"sequence\":%u,\"block\":%u,\"stampMs\":%llu,\"flags\":%u,"
      "\"env\":\"%08x\",\"env2\":\"%08x\",\"phi\":\"%08x\",\"bufl\":\"%08x\","
      "\"buf0\":\"%08x\",\"buf1\":\"%08x\",\"buf2\":\"%08x\",\"fff\":\"%08x\",\"fenv\":\"%08x\",\"flfo\":\"%08x\","
      "\"dphi\":\"%08x\",\"fq\":\"%08x\",\"fg\":\"%08x\",\"fmax\":\"%08x\",\"att\":\"%08x\",\"rel\":\"%08x\","
      "\"tthr\":\"%08x\",\"p0\":\"%08x\",\"p1\":\"%08x\",\"p3\":\"%08x\",\"p6\":\"%08x\",\"p8\":\"%08x\",\"p9\":\"%08x\","
      "\"tatt\":%d,\"ttrig\":%d,\"lfomode\":%d,\"fFirst\":\"%08x\",\"fLast\":\"%08x\","
      "\"fMinFinite\":\"%08x\",\"fMaxFinite\":\"%08x\",\"fNegExample\":\"%08x\","
      "\"framesFNeg\":%u,\"framesFNan\":%u,\"framesFInf\":%u,\"framesFFinite\":%u,\"framesIZero\":%u,\"frames\":%u,",
      i ? "," : "", record.stage, record.sessionId, record.classId,
      static_cast<unsigned long long>(record.instanceGen), record.pid, record.sequence, record.block,
      static_cast<unsigned long long>(record.stampMs), record.flags,
      record.env_bits, record.env2_bits, record.phi_bits, record.bufl_bits,
      record.buf0_bits, record.buf1_bits, record.buf2_bits, record.fff_bits, record.fenv_bits, record.flfo_bits,
      record.dphi_bits, record.fq_bits, record.fg_bits, record.fmax_bits, record.att_bits, record.rel_bits,
      record.tthr_bits, record.p0_bits, record.p1_bits, record.p3_bits, record.p6_bits, record.p8_bits, record.p9_bits,
      record.tatt, record.ttrig, record.lfomode, record.fFirst_bits, record.fLast_bits,
      record.fMinFinite_bits, record.fMaxFinite_bits, record.fNegExample_bits,
      record.framesFNeg, record.framesFNan, record.framesFInf, record.framesFFinite, record.framesIZero, record.frames);
    apexRezWriteChan(json, "inL", record.inL); std::fputc(',', json);
    apexRezWriteChan(json, "inR", record.inR); std::fputc(',', json);
    apexRezWriteChan(json, "outL", record.outL); std::fputc(',', json);
    apexRezWriteChan(json, "outR", record.outR);
    std::fputc('}', json);
  }
  std::fprintf(json, "]}\n");
  std::fclose(json);
  inst->flushed = true;
}
