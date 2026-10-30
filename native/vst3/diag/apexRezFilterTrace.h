// Diagnostic-only, read-only MDA RezFilter internal-state trace.
// Never compiled into production or uninstrumented four-cell plugins.
// Snapshots copy existing member bits; they must not assign DSP state.
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

struct ApexRezTraceRec {
  char stage[24];
  char sessionId[48];
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
  uint32_t fMin_bits, fMax_bits;
  uint32_t framesFNeg, framesIZero, inputNonzero, outputNonzero, frames;
};

constexpr int APEX_REZ_INST_CAP = 8;
constexpr int APEX_REZ_TRACE_CAP = 256;

struct ApexRezInst {
  uint64_t gen;
  uint32_t pid;
  char sessionId[48];
  uint32_t sequence;
  uint32_t dropped;
  int count;
  bool flushed;
  uint32_t fNeg, iZero, inNz, outNz, frames;
  float fMin, fMax;
  bool haveF;
  ApexRezTraceRec recs[APEX_REZ_TRACE_CAP];
};

static ApexRezInst gApexRezInst[APEX_REZ_INST_CAP];
static uint64_t gApexRezNextGen = 1;
static int gApexRezCurrent = -1;

inline uint32_t apexRezBits(float value) {
  uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  return bits;
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

inline ApexRezInst* apexRezBind() {
  if (gApexRezCurrent >= 0 && gApexRezCurrent < APEX_REZ_INST_CAP && !gApexRezInst[gApexRezCurrent].flushed)
    return &gApexRezInst[gApexRezCurrent];
  for (int i = 0; i < APEX_REZ_INST_CAP; ++i) {
    if (gApexRezInst[i].gen == 0 || gApexRezInst[i].flushed) {
      ApexRezInst& inst = gApexRezInst[i];
      std::memset(&inst, 0, sizeof(inst));
      inst.gen = gApexRezNextGen++;
      inst.pid = static_cast<uint32_t>(apex_getpid());
      if (const char* dir = std::getenv("APEX_REZFILTER_TRACE_DIR")) {
        char pending[1024];
        std::snprintf(pending, sizeof(pending), "%s/pending-open.txt", dir);
        if (FILE* file = std::fopen(pending, "rb")) {
          char line[48]{};
          if (std::fgets(line, sizeof(line), file)) {
            size_t n = std::strlen(line);
            while (n && (line[n - 1] == '\n' || line[n - 1] == '\r')) line[--n] = 0;
            std::strncpy(inst.sessionId, line, sizeof(inst.sessionId) - 1);
          }
          std::fclose(file);
          std::remove(pending);
        }
      }
      gApexRezCurrent = i;
      return &inst;
    }
  }
  return nullptr;
}

inline void apexRezBeginBlock(uint32_t frames) {
  ApexRezInst* inst = apexRezBind();
  if (!inst) return;
  inst->fNeg = inst->iZero = inst->inNz = inst->outNz = 0;
  inst->frames = frames;
  inst->haveF = false;
  inst->fMin = 0;
  inst->fMax = 0;
}

inline void apexRezAccumCutoff(float f) {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (!inst) return;
  if (!inst->haveF) { inst->fMin = inst->fMax = f; inst->haveF = true; }
  else {
    if (f < inst->fMin) inst->fMin = f;
    if (f > inst->fMax) inst->fMax = f;
  }
  if (f < 0.f) ++inst->fNeg;
}

inline void apexRezAccumIZero() {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (inst) ++inst->iZero;
}

inline void apexRezAccumIn(float a) {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (inst && a != 0.f) ++inst->inNz;
}

inline void apexRezAccumOut(float b) {
  ApexRezInst* inst = gApexRezCurrent >= 0 ? &gApexRezInst[gApexRezCurrent] : nullptr;
  if (inst && b != 0.f) ++inst->outNz;
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
  record.fMin_bits = inst->haveF ? apexRezBits(inst->fMin) : 0;
  record.fMax_bits = inst->haveF ? apexRezBits(inst->fMax) : 0;
  record.framesFNeg = inst->fNeg; record.framesIZero = inst->iZero;
  record.inputNonzero = inst->inNz; record.outputNonzero = inst->outNz;
  record.frames = inst->frames;
  inst->recs[inst->count++] = record;
  if (std::strncmp(stage, "process-post", 12) == 0)
    ++inst->sequence;
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
  for (int i = inst->count - 1; i >= 0; --i) {
    if (std::strncmp(inst->recs[i].stage, "process-", 8) == 0) { lastProcess = &inst->recs[i]; break; }
  }
  std::fprintf(json,
    "{\"pid\":%u,\"instanceGen\":%llu,\"sessionId\":\"%s\",\"count\":%d,\"dropped\":%u,\"flushed\":true,"
    "\"cutoff\":{\"fMin\":\"%08x\",\"fMax\":\"%08x\",\"framesFNeg\":%u,\"framesIZero\":%u,"
    "\"inputNonzero\":%u,\"outputNonzero\":%u,\"frames\":%u},\"records\":[",
    inst->pid, static_cast<unsigned long long>(inst->gen), inst->sessionId, inst->count, inst->dropped,
    lastProcess ? lastProcess->fMin_bits : 0, lastProcess ? lastProcess->fMax_bits : 0,
    lastProcess ? lastProcess->framesFNeg : 0, lastProcess ? lastProcess->framesIZero : 0,
    lastProcess ? lastProcess->inputNonzero : 0, lastProcess ? lastProcess->outputNonzero : 0,
    lastProcess ? lastProcess->frames : 0);
  for (int i = 0; i < inst->count; ++i) {
    const ApexRezTraceRec& record = inst->recs[i];
    std::fprintf(json,
      "%s{\"stage\":\"%s\",\"sessionId\":\"%s\",\"instanceGen\":%llu,\"pid\":%u,\"sequence\":%u,\"block\":%u,"
      "\"stampMs\":%llu,\"flags\":%u,\"env\":\"%08x\",\"env2\":\"%08x\",\"phi\":\"%08x\",\"bufl\":\"%08x\","
      "\"buf0\":\"%08x\",\"buf1\":\"%08x\",\"buf2\":\"%08x\",\"fff\":\"%08x\",\"fenv\":\"%08x\",\"flfo\":\"%08x\","
      "\"dphi\":\"%08x\",\"fq\":\"%08x\",\"fg\":\"%08x\",\"fmax\":\"%08x\",\"att\":\"%08x\",\"rel\":\"%08x\","
      "\"tthr\":\"%08x\",\"p0\":\"%08x\",\"p1\":\"%08x\",\"p3\":\"%08x\",\"p6\":\"%08x\",\"p8\":\"%08x\",\"p9\":\"%08x\","
      "\"tatt\":%d,\"ttrig\":%d,\"lfomode\":%d,\"fMin\":\"%08x\",\"fMax\":\"%08x\",\"framesFNeg\":%u,\"framesIZero\":%u,"
      "\"inputNonzero\":%u,\"outputNonzero\":%u,\"frames\":%u}",
      i ? "," : "", record.stage, record.sessionId, static_cast<unsigned long long>(record.instanceGen),
      record.pid, record.sequence, record.block, static_cast<unsigned long long>(record.stampMs), record.flags,
      record.env_bits, record.env2_bits, record.phi_bits, record.bufl_bits, record.buf0_bits, record.buf1_bits,
      record.buf2_bits, record.fff_bits, record.fenv_bits, record.flfo_bits, record.dphi_bits, record.fq_bits,
      record.fg_bits, record.fmax_bits, record.att_bits, record.rel_bits, record.tthr_bits, record.p0_bits,
      record.p1_bits, record.p3_bits, record.p6_bits, record.p8_bits, record.p9_bits, record.tatt, record.ttrig,
      record.lfomode, record.fMin_bits, record.fMax_bits, record.framesFNeg, record.framesIZero,
      record.inputNonzero, record.outputNonzero, record.frames);
  }
  std::fprintf(json, "]}\n");
  std::fclose(json);
  inst->flushed = true;
}
