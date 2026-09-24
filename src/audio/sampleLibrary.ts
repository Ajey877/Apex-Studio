import type { CustomSampleData, SamplePack } from '../types/daw';

export interface SampleLibraryFilters {
  query?: string;
  packId?: string;
  category?: string;
  tag?: string;
}

export const normalizeSampleTags = (tags: unknown): string[] =>
  Array.isArray(tags)
    ? [...new Set(tags.map(tag => String(tag).trim().toLowerCase()).filter(Boolean))]
    : [];

export const normalizeSampleName = (name: unknown): string =>
  String(name ?? '').trim() || 'Untitled Sample';

export const sampleMatchesFilters = (
  sample: CustomSampleData,
  packs: SamplePack[],
  filters: SampleLibraryFilters
): boolean => {
  const query = String(filters.query || '').trim().toLowerCase();
  const pack = packs.find(item => item.id === sample.packId);
  const haystack = [
    sample.name,
    sample.category || '',
    ...(sample.tags || []),
    pack?.name || ''
  ].join(' ').toLowerCase();

  if (query && !haystack.includes(query)) return false;
  if (filters.packId && sample.packId !== filters.packId) return false;
  if (filters.category && (sample.category || 'Uncategorized') !== filters.category) return false;
  if (filters.tag && !(sample.tags || []).includes(filters.tag)) return false;
  return true;
};

export const getSampleLibraryCategories = (samples: CustomSampleData[]): string[] =>
  [...new Set(samples.map(sample => sample.category?.trim() || 'Uncategorized'))].sort();

export const getSampleLibraryTags = (samples: CustomSampleData[]): string[] =>
  [...new Set(samples.flatMap(sample => normalizeSampleTags(sample.tags)))].sort();

export const createSamplePack = (
  name: string,
  category = 'Uncategorized',
  tags: string[] = [],
  now = Date.now()
): SamplePack => ({
  id: `pack-${now}-${Math.random().toString(36).slice(2, 8)}`,
  name: name.trim() || 'New Sample Pack',
  description: '',
  category: category.trim() || 'Uncategorized',
  tags: normalizeSampleTags(tags),
  created: now,
  updated: now
});

export const updateSampleMetadata = (
  sample: CustomSampleData,
  updates: Partial<Pick<CustomSampleData, 'name' | 'packId' | 'category' | 'tags'>>
): CustomSampleData => ({
  ...sample,
  ...updates,
  name: normalizeSampleName(updates.name ?? sample.name),
  category: (updates.category ?? sample.category ?? '').trim() || undefined,
  tags: normalizeSampleTags(updates.tags ?? sample.tags)
});

export const getSamplePackCounts = (
  samples: CustomSampleData[],
  packs: SamplePack[]
): Record<string, number> => {
  const counts: Record<string, number> = {};
  packs.forEach(pack => { counts[pack.id] = 0; });
  samples.forEach(sample => {
    if (sample.packId) counts[sample.packId] = (counts[sample.packId] || 0) + 1;
  });
  return counts;
};
