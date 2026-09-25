/**
 * Owns session-only Blob URLs created for audio recordings and project hydration.
 *
 * The registry is deliberately small: a URL is retained while one or more
 * session consumers own it, and revoked only when the final owner releases it.
 * This is separate from persisted audio and AudioEngine sample-buffer ownership.
 */
export class SessionBlobUrlRegistry {
  private readonly owners = new Map<string, number>();

  retain(url: string): void {
    if (!url || !url.startsWith('blob:')) return;
    this.owners.set(url, (this.owners.get(url) ?? 0) + 1);
  }

  release(url: string): void {
    if (!url || !url.startsWith('blob:')) return;

    const count = this.owners.get(url);
    if (!count) return;

    if (count > 1) {
      this.owners.set(url, count - 1);
      return;
    }

    this.owners.delete(url);
    URL.revokeObjectURL(url);
  }

  releaseAll(urls: Iterable<string>): void {
    for (const url of urls) this.release(url);
  }

  isOwned(url: string): boolean {
    return this.owners.has(url);
  }

  getOwnerCount(url: string): number {
    return this.owners.get(url) ?? 0;
  }

  /**
   * Test/support hook for deterministic cleanup. Production callers should
   * normally release individual ownership instead.
   */
  releaseAllOwned(): void {
    const urls = [...this.owners.keys()];
    this.owners.clear();
    for (const url of urls) URL.revokeObjectURL(url);
  }
}

export const sessionBlobUrlRegistry = new SessionBlobUrlRegistry();

export const getProjectSessionBlobUrls = (state: {
  recordings?: Array<{ audioUrl?: string }>;
}): string[] => {
  const urls = new Set<string>();
  for (const recording of state.recordings ?? []) {
    if (recording.audioUrl?.startsWith('blob:')) urls.add(recording.audioUrl);
  }
  return [...urls];
};

export const reconcileProjectSessionBlobUrls = (
  previousState: { recordings?: Array<{ audioUrl?: string }> },
  nextState: { recordings?: Array<{ audioUrl?: string }> }
): void => {
  const previous = new Set(getProjectSessionBlobUrls(previousState));
  const next = new Set(getProjectSessionBlobUrls(nextState));

  for (const url of next) {
    if (!previous.has(url)) sessionBlobUrlRegistry.retain(url);
  }

  for (const url of previous) {
    if (!next.has(url)) sessionBlobUrlRegistry.release(url);
  }
};
