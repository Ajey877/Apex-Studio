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

struct ApexRezTraceRec {
  char stage[24];
  uint32_t block;
  uint32_t flags; // bit0 env !finite, bit1 phi !finite, bit2 buf0 !finite, bit3 fff !finite
  uint32_t env_bits, env2_bits, phi_bits, bufl_bits, buf0_bits, buf1_bits, buf2_bits;
  uint32_t fff_bits, fenv_bits, flfo_bits, dphi_bits, fq_bits, fg_bits, fmax_bits;
  uint32_t att_bits, rel_bits, tthr_bits, p0_bits, p1_bits, p3_bits, p6_bits, p8_bits, p9_bits;
  int32_t tatt, ttrig, lfomode;
};

constexpr int APEX_REZ_TRACE_CAP = 96;
static ApexRezTraceRec gApexRezTraceBuf[APEX_REZ_TRACE_CAP];
static int gApexRezTraceCount = 0;
static uint32_t gApexRezTraceBlock = 0;

inline uint32_t apexRezBits(float value) {
  uint32_t bits = 0;
  std::memcpy(&bits, &value, sizeof(bits));
  return bits;
}

inline uint32_t apexRezNanInf(float value) {
  return std::isfinite(value) ? 0u : 1u;
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
  if (gApexRezTraceCount >= APEX_REZ_TRACE_CAP) return;
  ApexRezTraceRec record{};
  std::strncpy(record.stage, stage, sizeof(record.stage) - 1);
  record.block = gApexRezTraceBlock;
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
  gApexRezTraceBuf[gApexRezTraceCount++] = record;
  if (std::strncmp(stage, "process-", 8) == 0) ++gApexRezTraceBlock;
}

// File I/O only after processing has stopped. Never call from doProcessing.
inline void apexRezTraceFlush() {
  const char* path = std::getenv("APEX_REZFILTER_TRACE");
  if (!path || !path[0]) return;
  FILE* file = std::fopen(path, "wb");
  if (!file) return;
  std::fwrite(&gApexRezTraceCount, sizeof(gApexRezTraceCount), 1, file);
  if (gApexRezTraceCount > 0) std::fwrite(gApexRezTraceBuf, sizeof(ApexRezTraceRec), gApexRezTraceCount, file);
  std::fclose(file);
  char jsonPath[1024];
  std::snprintf(jsonPath, sizeof(jsonPath), "%s.json", path);
  FILE* json = std::fopen(jsonPath, "w");
  if (!json) return;
  std::fprintf(json, "{\"count\":%d,\"records\":[", gApexRezTraceCount);
  for (int i = 0; i < gApexRezTraceCount; ++i) {
    const ApexRezTraceRec& record = gApexRezTraceBuf[i];
    std::fprintf(json,
      "%s{\"stage\":\"%s\",\"block\":%u,\"flags\":%u,\"env\":\"%08x\",\"env2\":\"%08x\",\"phi\":\"%08x\","
      "\"bufl\":\"%08x\",\"buf0\":\"%08x\",\"buf1\":\"%08x\",\"buf2\":\"%08x\",\"fff\":\"%08x\",\"fenv\":\"%08x\","
      "\"flfo\":\"%08x\",\"dphi\":\"%08x\",\"fq\":\"%08x\",\"fg\":\"%08x\",\"fmax\":\"%08x\",\"att\":\"%08x\","
      "\"rel\":\"%08x\",\"tthr\":\"%08x\",\"p0\":\"%08x\",\"p1\":\"%08x\",\"p3\":\"%08x\",\"p6\":\"%08x\","
      "\"p8\":\"%08x\",\"p9\":\"%08x\",\"tatt\":%d,\"ttrig\":%d,\"lfomode\":%d}",
      i ? "," : "", record.stage, record.block, record.flags, record.env_bits, record.env2_bits, record.phi_bits,
      record.bufl_bits, record.buf0_bits, record.buf1_bits, record.buf2_bits, record.fff_bits, record.fenv_bits,
      record.flfo_bits, record.dphi_bits, record.fq_bits, record.fg_bits, record.fmax_bits, record.att_bits,
      record.rel_bits, record.tthr_bits, record.p0_bits, record.p1_bits, record.p3_bits, record.p6_bits,
      record.p8_bits, record.p9_bits, record.tatt, record.ttrig, record.lfomode);
  }
  std::fprintf(json, "]}\n");
  std::fclose(json);
}
